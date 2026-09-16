"""Storage and API logic for the Todo app.

One JSON document holds everything: ideas, todos, tombstones for what was
deleted, and the preferences. The document carries a revision, and a client
always sends its whole copy back with the revision it started from. When two
devices edit at once the server merges by item, newest write wins, and the
tombstones make sure a deletion on one device is not undone by a stale copy
on another.

Stdlib only, so the same file runs in Termux and on any laptop. The termox
panel vendors this module as termox/todo.py; keep the two identical.
"""

import json
import os
import re
import shutil
import threading
import time
from datetime import date, datetime, timedelta

DOC_VERSION = 1
TITLE_MAX = 200
TEXT_MAX = 4000
ITEMS_MAX = 20000
TOMBSTONE_DAYS = 60

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Invalid(ValueError):
    """The client sent something the document cannot hold."""


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def empty():
    return {
        "version": DOC_VERSION,
        "revision": 0,
        "saved_at": None,
        "ideas": [],
        "todos": [],
        "tombstones": {},
        "preferences": {},
    }


# ------------------------------------------------------------- validation

def _text(value, limit, name, required=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise Invalid("%s must be text" % name)
    value = value.strip()
    if required and not value:
        raise Invalid("%s is required" % name)
    if len(value) > limit:
        raise Invalid("%s is longer than %d characters" % (name, limit))
    return value


def _id(value, name):
    if not isinstance(value, str) or not ID_RE.match(value):
        raise Invalid("%s has a bad id" % name)
    return value


def _stamp(value):
    if isinstance(value, str) and value:
        return value
    return now_iso()


def _time(value, name):
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not TIME_RE.match(value):
        raise Invalid("%s must look like HH:MM" % name)
    return value


def _date(value, name):
    if not isinstance(value, str) or not DATE_RE.match(value):
        raise Invalid("%s must look like YYYY-MM-DD" % name)
    try:
        date.fromisoformat(value)
    except ValueError:
        raise Invalid("%s is not a real date" % name)
    return value


def clean_step(raw, order):
    if not isinstance(raw, dict):
        raise Invalid("a step is not an object")
    start = _time(raw.get("startTime"), "step start")
    end = _time(raw.get("endTime"), "step end")
    if start and end and end <= start:
        raise Invalid("a step ends before it starts")
    return {
        "id": _id(raw.get("id"), "step"),
        "title": _text(raw.get("title"), TITLE_MAX, "step title", required=True),
        "completed": bool(raw.get("completed")),
        "startTime": start,
        "endTime": end,
        "order": order,
    }


def clean_todo(raw):
    if not isinstance(raw, dict):
        raise Invalid("a todo is not an object")
    start = _time(raw.get("startTime"), "start time")
    end = _time(raw.get("endTime"), "end time")
    if bool(start) != bool(end):
        raise Invalid("a timed todo needs both a start and an end")
    if start and end <= start:
        raise Invalid("the end must be after the start")
    steps = raw.get("steps") or []
    if not isinstance(steps, list):
        raise Invalid("steps must be a list")
    source = raw.get("sourceIdeaId")
    return {
        "id": _id(raw.get("id"), "todo"),
        "title": _text(raw.get("title"), TITLE_MAX, "title", required=True),
        "notes": _text(raw.get("notes"), TEXT_MAX, "notes"),
        "date": _date(raw.get("date"), "date"),
        "startTime": start,
        "endTime": end,
        "category": _text(raw.get("category"), 60, "category"),
        "completed": bool(raw.get("completed")),
        "steps": [clean_step(step, i) for i, step in enumerate(steps[:200])],
        "sourceIdeaId": _id(source, "source idea") if source else None,
        "createdAt": _stamp(raw.get("createdAt")),
        "updatedAt": _stamp(raw.get("updatedAt")),
    }


def clean_idea(raw):
    if not isinstance(raw, dict):
        raise Invalid("an idea is not an object")
    return {
        "id": _id(raw.get("id"), "idea"),
        "title": _text(raw.get("title"), TITLE_MAX, "idea title", required=True),
        "description": _text(raw.get("description"), TEXT_MAX, "description"),
        "category": _text(raw.get("category"), 60, "category"),
        "expanded": bool(raw.get("expanded")),
        "createdAt": _stamp(raw.get("createdAt")),
        "updatedAt": _stamp(raw.get("updatedAt")),
    }


def clean_preferences(raw):
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    theme = raw.get("theme")
    if theme in ("dark", "light", "system"):
        out["theme"] = theme
    view = raw.get("defaultView")
    if view in ("year", "month", "week", "day"):
        out["defaultView"] = view
    if raw.get("weekStartsOn") in (0, 1):
        out["weekStartsOn"] = raw["weekStartsOn"]
    if "rightClickZoom" in raw:
        out["rightClickZoom"] = bool(raw["rightClickZoom"])
    return out


def clean_tombstones(raw):
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for key, value in list(raw.items())[:ITEMS_MAX]:
        if isinstance(key, str) and ID_RE.match(key) and isinstance(value, str):
            out[key] = value
    return out


def clean_document(raw):
    """Everything a client may send, checked field by field.

    Unknown keys are dropped rather than stored, so a newer client cannot
    smuggle shapes an older server never learnt to validate.
    """
    if not isinstance(raw, dict):
        raise Invalid("the document is not an object")
    ideas = raw.get("ideas") or []
    todos = raw.get("todos") or []
    if not isinstance(ideas, list) or not isinstance(todos, list):
        raise Invalid("ideas and todos must be lists")
    if len(ideas) + len(todos) > ITEMS_MAX:
        raise Invalid("too many items")
    doc = {
        "ideas": [clean_idea(x) for x in ideas],
        "todos": [clean_todo(x) for x in todos],
        "tombstones": clean_tombstones(raw.get("tombstones")),
        "preferences": clean_preferences(raw.get("preferences")),
    }
    for name in ("ideas", "todos"):
        seen = set()
        for item in doc[name]:
            if item["id"] in seen:
                raise Invalid("duplicate %s id %s" % (name[:-1], item["id"]))
            seen.add(item["id"])
    return doc


# ------------------------------------------------------------------ merge

def _newer(a, b):
    return a if (a.get("updatedAt") or "") >= (b.get("updatedAt") or "") else b


def merge_lists(current, incoming, tombstones):
    """Union by id; the more recently updated copy wins; a tombstone newer
    than the item deletes it."""
    by_id = {}
    for item in current:
        by_id[item["id"]] = item
    for item in incoming:
        by_id[item["id"]] = _newer(by_id[item["id"]], item) if item["id"] in by_id else item
    out = []
    for key, item in by_id.items():
        dead = tombstones.get(key)
        if dead and dead >= (item.get("updatedAt") or ""):
            continue
        if dead:
            del tombstones[key]      # edited after deletion elsewhere: it lives
        out.append(item)
    return out


def merge(current, incoming):
    tombstones = dict(current.get("tombstones") or {})
    for key, at in (incoming.get("tombstones") or {}).items():
        if key not in tombstones or at > tombstones[key]:
            tombstones[key] = at
    merged = {
        "ideas": merge_lists(current.get("ideas") or [], incoming["ideas"], tombstones),
        "todos": merge_lists(current.get("todos") or [], incoming["todos"], tombstones),
        "preferences": dict(current.get("preferences") or {}, **incoming["preferences"]),
    }
    merged["tombstones"] = tombstones
    return merged


def prune_tombstones(tombstones, today=None):
    """Tombstones only need to outlive the stalest device likely to sync."""
    cutoff = ((today or datetime.now().astimezone()) - timedelta(days=TOMBSTONE_DAYS))
    cutoff = cutoff.isoformat(timespec="seconds")
    return {k: v for k, v in tombstones.items() if v >= cutoff}


# ------------------------------------------------------------------ store

class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.doc = self._load()

    def _load(self):
        try:
            with open(self.path) as fh:
                raw = json.load(fh)
            doc = empty()
            doc.update(clean_document(raw))
            doc["revision"] = int(raw.get("revision") or 0)
            doc["saved_at"] = raw.get("saved_at")
            return doc
        except FileNotFoundError:
            return empty()
        except (ValueError, OSError, Invalid):
            # keep the unreadable file beside the fresh one rather than
            # silently starting over on top of it
            try:
                shutil.copy(self.path, self.path + ".broken-%d" % int(time.time()))
            except OSError:
                pass
            return empty()

    def _write(self):
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(self.doc, fh, indent=1, sort_keys=True)
        os.replace(tmp, self.path)

    def document(self):
        with self.lock:
            return json.loads(json.dumps(self.doc))

    def replace(self, raw):
        """Store a client's copy. Returns the document every client should
        now hold; a stale base revision means it was merged rather than
        written over."""
        incoming = clean_document(raw)
        base = raw.get("baseRevision")
        with self.lock:
            if base is not None and int(base) != self.doc["revision"]:
                incoming = merge(self.doc, incoming)
                merged = True
            else:
                merged = False
            incoming["tombstones"] = prune_tombstones(incoming["tombstones"])
            self.doc.update(incoming)
            self.doc["revision"] += 1
            self.doc["saved_at"] = now_iso()
            self._write()
            out = json.loads(json.dumps(self.doc))
        out["merged"] = merged
        return out

    def summary(self, today=None):
        """What the panel shows in its rail without loading the app."""
        today = today or date.today().isoformat()
        with self.lock:
            todos = self.doc["todos"]
            open_todos = [t for t in todos if not t["completed"]]
            return {
                "ideas": len(self.doc["ideas"]),
                "todos": len(todos),
                "open": len(open_todos),
                "today": sum(1 for t in open_todos if t["date"] == today),
                "overdue": sum(1 for t in open_todos if t["date"] < today),
                "revision": self.doc["revision"],
                "saved_at": self.doc["saved_at"],
            }


def handle(store, method, body):
    """One entry point for any HTTP server: (status, payload)."""
    if method == "GET":
        return 200, store.document()
    if method == "PUT":
        try:
            raw = json.loads(body or b"{}")
        except ValueError:
            return 400, {"error": "unreadable request"}
        try:
            return 200, store.replace(raw)
        except Invalid as exc:
            return 400, {"error": str(exc)}
        except OSError as exc:
            return 500, {"error": "could not write the file: %s" % exc}
    return 405, {"error": "method not allowed"}
