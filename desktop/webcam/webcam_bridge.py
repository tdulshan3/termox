#!/usr/bin/python3
"""Loopback-only bridge between the Termox page and the desktop webcam.

Termox runs on the phone, but scrcpy and v4l2loopback run on the Linux PC.
The page therefore calls this small local service directly. It never binds to
the LAN, and CORS accepts only the configured dashboard origins.
"""

import json
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOST = "127.0.0.1"
PORT = int(os.environ.get("S20_WEBCAM_BRIDGE_PORT", "8765"))
CONFIG = Path(os.environ.get(
    "S20_WEBCAM_CONFIG",
    "/home/tdulshan/.config/s20-webcam/settings.conf",
))
DEFAULT_ORIGINS = (
    "http://192.168.1.118:8080,"
    "http://127.0.0.1:8080,"
    "http://localhost:8080"
)
ALLOWED_ORIGINS = {
    item.strip().rstrip("/")
    for item in os.environ.get("S20_WEBCAM_ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if item.strip()
}
SERVICES = {
    "wide": "s20-wide-webcam.service",
    "ultrawide": "s20-ultrawide-webcam.service",
}
BODY_MAX = 4096


def _systemctl(*args):
    return subprocess.run(
        ("systemctl", "--user") + args,
        capture_output=True,
        text=True,
        timeout=20,
    )


def _active(service):
    return _systemctl("is-active", "--quiet", service).returncode == 0


def read_settings():
    values = {
        "lens": "wide",
        "zoom": 1.0,
        "flip_horizontal": False,
        "flip_vertical": False,
        "torch": False,
    }
    try:
        lines = CONFIG.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    raw = {}
    for line in lines:
        key, separator, value = line.partition("=")
        if separator:
            raw[key.strip()] = value.strip()
    if raw.get("lens") in SERVICES:
        values["lens"] = raw["lens"]
    try:
        zoom = float(raw.get("zoom", 1))
        if 1 <= zoom <= 8:
            values["zoom"] = round(zoom, 1)
    except ValueError:
        pass
    # Read the old single `flip` key so existing installations migrate cleanly.
    values["flip_horizontal"] = raw.get(
        "flip_horizontal", raw.get("flip", "false")) == "true"
    values["flip_vertical"] = raw.get("flip_vertical", "false") == "true"
    values["torch"] = raw.get("torch", "false") == "true"
    return values


def validate_settings(body):
    lens = body.get("lens")
    if lens not in SERVICES:
        raise ValueError("lens must be wide or ultrawide")
    try:
        zoom = round(float(body.get("zoom")), 1)
    except (TypeError, ValueError):
        raise ValueError("zoom must be a number from 1 to 8") from None
    if not 1 <= zoom <= 8:
        raise ValueError("zoom must be from 1 to 8")
    out = {"lens": lens, "zoom": zoom}
    for key in ("flip_horizontal", "flip_vertical", "torch"):
        if not isinstance(body.get(key), bool):
            raise ValueError("%s must be true or false" % key)
        out[key] = body[key]
    return out


def write_settings(values):
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    body = (
        "lens={lens}\n"
        "zoom={zoom:.1f}\n"
        "flip_horizontal={flip_horizontal}\n"
        "flip_vertical={flip_vertical}\n"
        "torch={torch}\n"
    ).format(
        lens=values["lens"],
        zoom=values["zoom"],
        flip_horizontal=str(values["flip_horizontal"]).lower(),
        flip_vertical=str(values["flip_vertical"]).lower(),
        torch=str(values["torch"]).lower(),
    )
    fd, scratch = tempfile.mkstemp(prefix="settings.", dir=str(CONFIG.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(body)
        os.chmod(scratch, 0o600)
        os.replace(scratch, CONFIG)
    finally:
        try:
            os.unlink(scratch)
        except FileNotFoundError:
            pass


def state():
    settings = read_settings()
    active = next((lens for lens, unit in SERVICES.items() if _active(unit)), None)
    return {
        "ok": True,
        "running": active is not None,
        "lens": active,
        "settings": settings,
        "device": "/dev/video0",
        "device_present": Path("/dev/video0").exists(),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "S20WebcamBridge/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def _origin(self):
        return (self.headers.get("Origin") or "").rstrip("/")

    def _origin_allowed(self):
        origin = self._origin()
        return not origin or origin in ALLOWED_ORIGINS

    def _headers(self, status, length):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        origin = self._origin()
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def _json(self, value, status=200):
        payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self._headers(status, len(payload))
        self.wfile.write(payload)

    def _reject_origin(self):
        if self._origin_allowed():
            return False
        self._json({"error": "origin is not allowed"}, 403)
        return True

    def do_OPTIONS(self):  # noqa: N802 - stdlib callback name
        if self._reject_origin():
            return
        self.send_response(204)
        origin = self._origin()
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802 - stdlib callback name
        if self._reject_origin():
            return
        if self.path == "/state":
            return self._json(state())
        if self.path == "/health":
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802 - stdlib callback name
        if self._reject_origin():
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json({"error": "invalid content length"}, 400)
        if length > BODY_MAX:
            return self._json({"error": "request too large"}, 413)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (OSError, ValueError):
            return self._json({"error": "invalid JSON"}, 400)

        if self.path == "/apply":
            try:
                settings = validate_settings(body)
            except ValueError as error:
                return self._json({"error": str(error)}, 400)
            write_settings(settings)
            result = _systemctl("restart", SERVICES[settings["lens"]])
            if result.returncode:
                return self._json({
                    "error": result.stderr.strip() or "could not start webcam",
                }, 500)
            return self._json(state())

        if self.path == "/stop":
            result = _systemctl("stop", *SERVICES.values())
            if result.returncode:
                return self._json({
                    "error": result.stderr.strip() or "could not stop webcam",
                }, 500)
            return self._json(state())

        return self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("S20 webcam bridge listening on http://%s:%d" % (HOST, PORT), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
