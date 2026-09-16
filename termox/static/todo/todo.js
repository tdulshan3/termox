/* Todo — ideas on the left, one calendar in the middle that zooms from a year
   to a day, the selected todo on the right.

   No framework and no build: the page is rebuilt from one state object on
   every change. The only stateful DOM kept across renders is the editor
   form, so a draft survives everything else redrawing around it.

   Storage: the document lives on the server at /api/todo when there is one
   (termox, or serve.py), and in localStorage always, so the page opens
   instantly and keeps working when the phone is out of reach.             */

'use strict';

/* ------------------------------------------------------------ constants */

const VIEWS = ['year', 'month', 'week', 'day'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOUR_PX = 46;
const LOCAL_KEY = 'todo.document';
const PUSH_DELAY = 400;
const PULL_EVERY = 15000;
const TOKEN = new URLSearchParams(location.search).get('token');
const API = (location.protocol === 'file:') ? null : '/api/todo';
const HOSTED = !!API && location.pathname.startsWith('/todo');   // inside the termox panel
const NARROW = () => window.innerWidth < 1180;

/* ------------------------------------------------------------ dates */

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const today = () => keyOf(new Date());
function addDays(key, n) { const d = parseKey(key); d.setDate(d.getDate() + n); return keyOf(d); }
function addMonths(key, n) {
  const d = parseKey(key);
  const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return keyOf(d);
}
function addYears(key, n) { return addMonths(key, 12 * n); }
function weekStart(key) {
  const d = parseKey(key);
  const offset = (d.getDay() - prefs().weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - offset);
  return keyOf(d);
}
function monthGrid(year, month) {
  const start = weekStart(keyOf(new Date(year, month, 1)));
  const out = [];
  for (let i = 0; i < 42; i += 1) out.push(addDays(start, i));
  return out;
}
function minutes(t) { return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null; }
function timeOf(mins) { mins = Math.max(0, Math.min(1439, mins)); return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60); }
function fmtTime(t) {
  if (!t) return '';
  const m = minutes(t);
  const h = Math.floor(m / 60), mm = m % 60;
  return ((h % 12) || 12) + (mm ? ':' + pad(mm) : '') + (h < 12 ? 'am' : 'pm');
}
function fmtRange(a, b) { return fmtTime(a) + ' – ' + fmtTime(b); }
function fmtMinutes(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  return (h ? h + 'h' : '') + (mm ? (h ? ' ' : '') + mm + 'm' : '') || '0m';
}
function fmtDuration(a, b) { return fmtMinutes(minutes(b) - minutes(a)); }
function fmtLong(key) {
  const d = parseKey(key);
  return DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}
function fmtShort(key) {
  const d = parseKey(key);
  return DAYS[d.getDay()].slice(0, 3) + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
}
function fmtRelative(key) {
  const diff = Math.round((parseKey(key) - parseKey(today())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < 0 && diff > -7) return DAYS[parseKey(key).getDay()] + ' · ' + (-diff) + ' days ago';
  if (diff > 0 && diff < 7) return DAYS[parseKey(key).getDay()];
  return fmtShort(key);
}
function isWeekend(key) { const g = parseKey(key).getDay(); return g === 0 || g === 6; }

/* Every date gets one of eight tones, stable across reloads and shared by
   every todo on it. The hash is mixed so neighbours differ. */
function dayTone(key) {
  let x = 0;
  for (let i = 0; i < key.length; i += 1) x = (x * 31 + key.charCodeAt(i)) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995) >>> 0; x ^= x >>> 15;
  return 'var(--day-' + (x % 8) + ')';
}

/* ------------------------------------------------------------ state */

const state = {
  doc: { revision: 0, ideas: [], todos: [], tombstones: {}, preferences: {} },
  view: 'month',
  cursor: today(),
  selected: today(),
  selectedTodo: null,
  editor: null,
  ideaDialog: null,
  help: false,
  sheet: null,
  anim: null,
  quickDraft: '',
  focus: null,
  sync: API ? 'loading' : 'local',
  dirty: 0,
  expandedMonth: null,
};

/* A ground carried in the link (?theme=light) is for this tab only. */
let themeOverride = null;

function prefs() {
  const p = state.doc.preferences || {};
  return {
    theme: themeOverride || p.theme || 'dark',
    defaultView: p.defaultView || 'month',
    weekStartsOn: p.weekStartsOn === 0 ? 0 : 1,
    rightClickZoom: p.rightClickZoom !== false,
  };
}

function uid() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Date.now().toString(36) + Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}
const stamp = () => new Date().toISOString();

const todosOn = (key) => state.doc.todos.filter((t) => t.date === key);
const todoById = (id) => state.doc.todos.find((t) => t.id === id) || null;
const ideaById = (id) => state.doc.ideas.find((i) => i.id === id) || null;
const overdue = () => state.doc.todos.filter((t) => !t.completed && t.date < today())
  .sort((a, b) => (a.date < b.date ? -1 : 1));

function sortTodos(list) {
  return list.slice().sort((a, b) => {
    if (!!a.startTime !== !!b.startTime) return a.startTime ? 1 : -1;
    if (a.startTime && b.startTime && a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

/* ------------------------------------------------------------ persistence */

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) {
      const doc = JSON.parse(raw);
      if (doc && Array.isArray(doc.todos)) state.doc = Object.assign(state.doc, doc);
    }
  } catch (err) { /* private mode, or blocked storage: memory only */ }
}
function saveLocal() {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state.doc)); } catch (err) { /* ignore */ }
}

let pushTimer = null;
let pushing = false;
let pending = false;
let retryDelay = 5000;

function commit() {
  state.dirty += 1;
  saveLocal();
  render();
  if (!API) return;
  pending = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, PUSH_DELAY);
}

function headers() {
  const out = { 'Content-Type': 'application/json' };
  if (TOKEN) out['X-Termox-Token'] = TOKEN;
  return out;
}

/* A todo named in the link (?todo=<id>) is selected as soon as a copy that
   holds it arrives, from this browser or from the server. */
let wantTodo = null;

function adopt(doc) {
  state.doc = {
    revision: doc.revision || 0,
    ideas: doc.ideas || [],
    todos: doc.todos || [],
    tombstones: doc.tombstones || {},
    preferences: doc.preferences || {},
  };
  if (state.selectedTodo && !todoById(state.selectedTodo)) state.selectedTodo = null;
  claimWanted();
  saveLocal();
}

function contentOf(doc) {
  return JSON.stringify([doc.ideas, doc.todos, doc.preferences]);
}

function claimWanted() {
  const todo = wantTodo && todoById(wantTodo);
  if (!todo) return;
  wantTodo = null;
  state.selectedTodo = todo.id; state.selected = todo.date;
  if (!sameView(todo.date)) state.cursor = todo.date;
}

async function push() {
  if (!API || pushing) return;
  pushing = true;
  const seq = state.dirty;
  setSync('saving');
  try {
    const body = Object.assign({}, state.doc, { baseRevision: state.doc.revision });
    const response = await fetch(API, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    if (state.dirty === seq) {
      pending = false;
      /* The server echoes what was sent, so this is usually the same
         document with a new revision. Only redraw when it differs. */
      const before = contentOf(state.doc);
      adopt(data);
      if (contentOf(state.doc) !== before) render();
    }
    retryDelay = 5000;
    setSync('synced');
    if (data.merged) toast('Merged with changes from another device');
  } catch (err) {
    setSync('offline');
    setTimeout(push, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60000);
  } finally {
    pushing = false;
    if (state.dirty !== seq) { clearTimeout(pushTimer); pushTimer = setTimeout(push, PUSH_DELAY); }
  }
}

async function pull(first) {
  if (!API) return;
  try {
    const response = await fetch(API, { headers: TOKEN ? { 'X-Termox-Token': TOKEN } : {}, cache: 'no-store' });
    if (response.status === 401) { setSync('offline'); toast('The panel wants a token: open this page from termox', 'bad'); return; }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (first && !pending && state.doc.revision === 0 && (state.doc.todos.length || state.doc.ideas.length)
        && !(data.todos || []).length && !(data.ideas || []).length) {
      commit();            // a copy made before the server existed goes up
      return;
    }
    if (!pending && !pushing) {
      if ((data.revision || 0) !== state.doc.revision || first) { adopt(data); render(); }
    }
    if (!pending) setSync('synced');
  } catch (err) {
    if (state.sync !== 'saving') setSync('offline');
  }
}

function setSync(value) {
  if (state.sync === value) return;
  state.sync = value;
  const pill = document.querySelector('.status');
  if (pill) { pill.dataset.state = value; pill.querySelector('b').textContent = syncLabel(); pill.title = syncTitle(); } else render();
}
function syncLabel() {
  return { loading: 'connecting', synced: 'synced', saving: 'saving', offline: 'offline', local: 'local' }[state.sync];
}
function syncTitle() {
  return { loading: 'Reaching the server', synced: 'Saved on ' + location.hostname + ', shared with every device',
           saving: 'Saving to ' + location.hostname, offline: 'Cannot reach ' + location.hostname + '; changes are kept here and retried',
           local: 'Kept in this browser only' }[state.sync];
}

/* ------------------------------------------------------------ mutations */

function touch(item) { item.updatedAt = stamp(); return item; }

function addTodo(fields) {
  const todo = Object.assign({
    id: uid(), title: '', notes: '', date: state.selected, startTime: null, endTime: null,
    category: '', completed: false, steps: [], sourceIdeaId: null, createdAt: stamp(), updatedAt: stamp(),
  }, fields);
  state.doc.todos.push(todo);
  return todo;
}

function removeTodo(id, quiet) {
  const index = state.doc.todos.findIndex((t) => t.id === id);
  if (index < 0) return;
  const [gone] = state.doc.todos.splice(index, 1);
  state.doc.tombstones[id] = stamp();
  if (state.selectedTodo === id) state.selectedTodo = null;
  if (state.editor && state.editor.id === id) { state.editor = null; editorDom = null; }
  if (!quiet) {
    undoable('Deleted “' + gone.title + '”', () => {
      delete state.doc.tombstones[id];
      state.doc.todos.push(touch(gone));
      state.selectedTodo = id;
    });
  }
  commit();
}

function moveTodo(id, key, time) {
  const todo = todoById(id);
  if (!todo || (todo.date === key && time === undefined)) return;
  const before = Object.assign({}, todo);
  todo.date = key;
  if (time === null && todo.startTime) {
    if (!confirm('Drop the time from “' + todo.title + '”?')) return;
    todo.startTime = null; todo.endTime = null;
  } else if (typeof time === 'string') {
    const length = todo.startTime ? minutes(todo.endTime) - minutes(todo.startTime) : 60;
    const start = Math.min(minutes(time), 1440 - length);
    todo.startTime = timeOf(start); todo.endTime = timeOf(start + length);
  }
  touch(todo);
  state.selected = key; state.selectedTodo = id;
  undoable('Moved to ' + fmtRelative(key), () => { Object.assign(todo, before); touch(todo); });
  announce('Moved ' + todo.title + ' to ' + fmtLong(key));
  commit();
}

function moveAllOverdue() {
  const list = overdue();
  if (!list.length) return;
  const before = list.map((t) => [t, t.date]);
  list.forEach((t) => { t.date = today(); touch(t); });
  undoable('Moved ' + list.length + ' overdue to today', () => { before.forEach(([t, d]) => { t.date = d; touch(t); }); });
  commit();
}

function toggleTodo(id) {
  const todo = todoById(id);
  if (!todo) return;
  if (!todo.completed && todo.steps.some((s) => !s.completed)
      && confirm('Mark every step done as well?')) {
    todo.steps.forEach((s) => { s.completed = true; });
  }
  todo.completed = !todo.completed;
  touch(todo);
  announce(todo.title + (todo.completed ? ' completed' : ' reopened'));
  commit();
}

function scheduleIdea(id, key, time, move) {
  const idea = ideaById(id);
  if (!idea) return;
  const fields = { title: idea.title, notes: idea.description, category: idea.category, date: key, sourceIdeaId: id };
  if (typeof time === 'string') { fields.startTime = time; fields.endTime = timeOf(minutes(time) + 60); }
  const todo = addTodo(fields);
  if (move) removeIdea(id, true);
  state.selected = key; state.selectedTodo = todo.id;
  if (!sameView(key)) state.cursor = key;
  undoable('Scheduled “' + idea.title + '” for ' + fmtRelative(key), () => {
    removeTodo(todo.id, true);
    if (move && !ideaById(id)) { delete state.doc.tombstones[id]; state.doc.ideas.unshift(touch(idea)); }
  });
  announce('Scheduled ' + idea.title + ' on ' + fmtLong(key));
  commit();
}

function removeIdea(id, quiet) {
  const index = state.doc.ideas.findIndex((i) => i.id === id);
  if (index < 0) return;
  const [gone] = state.doc.ideas.splice(index, 1);
  state.doc.tombstones[id] = stamp();
  if (quiet) return;
  undoable('Deleted idea “' + gone.title + '”', () => {
    delete state.doc.tombstones[id];
    state.doc.ideas.splice(Math.min(index, state.doc.ideas.length), 0, touch(gone));
  });
  commit();
}

function undoable(label, restore) {
  toast(label, null, { label: 'Undo', run: () => { restore(); commit(); } });
}

function setPref(name, value) {
  state.doc.preferences = Object.assign({}, state.doc.preferences, { [name]: value });
  commit();
}

/* ------------------------------------------------------------ navigation */

function go(view, key, anim) {
  const from = VIEWS.indexOf(state.view), to = VIEWS.indexOf(view);
  state.anim = anim || (to > from ? 'zoom-in' : to < from ? 'zoom-out' : null);
  state.view = view;
  if (key) { state.cursor = key; state.selected = key; }
  else state.cursor = state.selected || state.cursor;
  render();
}

function step(direction) {
  const c = state.cursor;
  state.cursor = state.view === 'year' ? addYears(c, direction)
    : state.view === 'month' ? addMonths(c, direction)
    : state.view === 'week' ? addDays(c, 7 * direction)
    : addDays(c, direction);
  state.selected = state.view === 'day' ? state.cursor
    : state.view === 'week' ? addDays(state.selected, 7 * direction)
    : state.view === 'month' ? addMonths(state.selected, direction)
    : addYears(state.selected, direction);
  state.anim = direction > 0 ? 'slide-left' : 'slide-right';
  render();
}

function goToday() { state.cursor = today(); state.selected = today(); state.anim = null; render(); }

function zoom(delta) {
  const index = VIEWS.indexOf(state.view) + delta;
  if (index < 0 || index >= VIEWS.length) return;
  go(VIEWS[index], state.selected);
}

function select(key) {
  state.selected = key; state.selectedTodo = null;
  if (state.view !== 'year' && !sameView(key)) state.cursor = key;
  render();
}

function sameView(key) {
  const c = state.cursor;
  if (state.view === 'year') return c.slice(0, 4) === key.slice(0, 4);
  if (state.view === 'month') return c.slice(0, 7) === key.slice(0, 7);
  if (state.view === 'week') return weekStart(c) === weekStart(key);
  return c === key;
}

function pick(id) {
  const todo = todoById(id);
  if (!todo) return;
  state.selectedTodo = id; state.selected = todo.date; state.editor = null; editorDom = null;
  if (NARROW()) state.sheet = 'inspector';
  render();
}

function openSheet(name) { state.sheet = state.sheet === name ? null : name; render(); }

/* ------------------------------------------------------------ dom helpers */

function h(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const key in props) {
      const value = props[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') node.setAttribute('style', value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
  }
  (children || []).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child)) : child);
  });
  return node;
}

function icon(name) {
  const paths = {
    left: 'm15 18-6-6 6-6', right: 'm9 18 6-6-6-6', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
    x: 'm7 7 10 10M17 7 7 17', check: 'm5 12 5 5 9-10', up: 'm7 14 5-5 5 5', down: 'm7 10 5 5 5-5',
    clock: 'M12 7.5V12l3 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    sun: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0',
    moon: 'M20 15.4A8.5 8.5 0 0 1 8.6 4 8.5 8.5 0 1 0 20 15.4Z',
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.7.5 1 1.3 1 2.1h5c0-.8.3-1.6 1-2.1A6 6 0 0 0 12 3Z',
    cal: 'M5 8h14v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8ZM8 4v6M16 4v6M5 11h14',
    list: 'M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01',
    help: 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
  };
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', paths[name]); path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.9'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function announce(text) {
  const live = document.getElementById('live');
  if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); }
}

/* Drag and drop: the payload is 'todo:<id>' or 'idea:<id>'. Touch has no
   drag, so every drop also has a button that does the same thing. */
function draggable(node, payload) {
  node.setAttribute('draggable', 'true');
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', payload);
    e.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));
  return node;
}

function dropTarget(node, onDrop) {
  node.classList.add('drop');
  node.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; node.classList.add('over'); });
  node.addEventListener('dragleave', () => node.classList.remove('over'));
  node.addEventListener('drop', (e) => {
    e.preventDefault(); node.classList.remove('over');
    const [kind, id] = (e.dataTransfer.getData('text/plain') || '').split(':');
    if (kind === 'todo' || kind === 'idea') onDrop(kind, id, e);
  });
  return node;
}

function dropOnDate(node, key, time) {
  return dropTarget(node, (kind, id, e) => {
    const t = typeof time === 'function' ? time(e) : time;
    if (kind === 'todo') moveTodo(id, key, t);
    else scheduleIdea(id, key, t, e.altKey);
  });
}

function chip(todo, opts) {
  const node = h('button', {
    type: 'button', class: 'todo-chip', style: '--day:' + dayTone(todo.date),
    'data-done': todo.completed ? 'true' : null,
    'aria-pressed': state.selectedTodo === todo.id ? 'true' : 'false',
    title: todo.title + (todo.startTime ? ' · ' + fmtRange(todo.startTime, todo.endTime) : ''),
    onclick: (e) => { e.stopPropagation(); pick(todo.id); },
    ondblclick: (e) => { e.stopPropagation(); openEditor(todo.id); },
  }, [
    todo.startTime && !(opts && opts.noTime) ? h('span', { class: 't', text: fmtTime(todo.startTime) }) : null,
    todo.title,
  ]);
  return draggable(node, 'todo:' + todo.id);
}

/* A chip with a tick beside it, for lists where completing in place is the
   point: the inspector's day list and the overdue triage. */
function chipRow(todo, extra) {
  return h('div', { class: 'chip-row' }, [
    h('input', { type: 'checkbox', class: 'tick', checked: todo.completed, 'aria-label': 'Complete ' + todo.title,
                 onchange: () => toggleTodo(todo.id) }),
    chip(todo),
    extra || null,
  ]);
}

/* ------------------------------------------------------------ views */

function periodTitle() {
  const c = parseKey(state.cursor);
  if (state.view === 'year') return String(c.getFullYear());
  if (state.view === 'month') return MONTHS[c.getMonth()] + ' ' + c.getFullYear();
  if (state.view === 'week') {
    const a = parseKey(weekStart(state.cursor)), b = parseKey(addDays(weekStart(state.cursor), 6));
    if (a.getMonth() === b.getMonth()) return a.getDate() + '–' + b.getDate() + ' ' + MONTHS[a.getMonth()] + ' ' + b.getFullYear();
    return a.getDate() + ' ' + MONTHS[a.getMonth()].slice(0, 3) + ' – ' + b.getDate() + ' ' + MONTHS[b.getMonth()].slice(0, 3) + ' ' + b.getFullYear();
  }
  return fmtLong(state.cursor);
}

function toolbar() {
  return h('div', { class: 'toolbar' }, [
    h('a', { class: 'chip brand-mini', href: '.', 'aria-label': 'Todo', onclick: (e) => { e.preventDefault(); goToday(); } }, [h('img', { src: 'todo-mark.svg', alt: '', width: '32', height: '32' })]),
    h('div', { class: 'nav' }, [
      h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Previous ' + state.view, onclick: () => step(-1) }, [icon('left')]),
      h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Next ' + state.view, onclick: () => step(1) }, [icon('right')]),
    ]),
    h('h1', { text: periodTitle() }),
    sameView(today()) ? null : h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: goToday }, ['Today']),
    h('span', { class: 'spacer' }),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Calendar view' }, VIEWS.map((v) =>
      h('button', { type: 'button', 'aria-pressed': state.view === v ? 'true' : 'false', onclick: () => go(v, state.selected),
                    text: v[0].toUpperCase() + v.slice(1) }))),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Zoom' }, [
      h('button', { type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out (−)', disabled: state.view === 'year', onclick: () => zoom(-1) }, [icon('minus')]),
      h('button', { type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in (+)', disabled: state.view === 'day', onclick: () => zoom(1) }, [icon('plus')]),
    ]),
  ]);
}

function yearView() {
  const year = parseKey(state.cursor).getFullYear();
  const counts = {};
  state.doc.todos.forEach((t) => { counts[t.date] = (counts[t.date] || 0) + 1; });
  const ws = prefs().weekStartsOn;
  return h('div', { class: 'year' }, MONTHS.map((name, m) => {
    const first = keyOf(new Date(year, m, 1));
    const cells = [];
    for (let i = 0; i < 7; i += 1) cells.push(h('div', { class: 'wd', text: DAYS[(ws + i) % 7][0] }));
    monthGrid(year, m).forEach((key) => {
      if (key.slice(0, 7) !== first.slice(0, 7)) { cells.push(h('div', { class: 'mini-day blank' })); return; }
      cells.push(dropOnDate(h('button', {
        type: 'button', class: 'mini-day', style: '--day:' + dayTone(key),
        'data-has': counts[key] ? 'true' : null, 'data-today': key === today() ? 'true' : null,
        'data-selected': key === state.selected ? 'true' : null,
        'aria-label': fmtLong(key) + (counts[key] ? ', ' + counts[key] + ' todos' : ''),
        text: String(Number(key.slice(8))),
        onclick: () => select(key), ondblclick: () => go('day', key),
      }), key, undefined));
    });
    return h('section', { class: 'mini', 'aria-label': name + ' ' + year }, [
      h('button', { type: 'button', class: 'mini-head', text: name, onclick: () => go('month', first) }),
      h('div', { class: 'mini-grid' }, cells),
    ]);
  }));
}

function monthView() {
  const c = parseKey(state.cursor);
  const month = state.cursor.slice(0, 7);
  const ws = prefs().weekStartsOn;
  const kids = [];
  for (let i = 0; i < 7; i += 1) kids.push(h('div', { class: 'wd', text: DAYS[(ws + i) % 7].slice(0, 3) }));
  monthGrid(c.getFullYear(), c.getMonth()).forEach((key) => {
    const list = sortTodos(todosOn(key));
    const expanded = state.expandedMonth === key;
    const limit = expanded ? list.length : 4;
    kids.push(dropOnDate(h('div', {
      class: 'cell', role: 'button', tabindex: '0', style: '--day:' + dayTone(key),
      'data-outside': key.slice(0, 7) !== month ? 'true' : null,
      'data-today': key === today() ? 'true' : null,
      'data-weekend': isWeekend(key) ? 'true' : null,
      'data-selected': key === state.selected ? 'true' : null,
      'aria-label': fmtLong(key) + (list.length ? ', ' + list.length + ' todos' : ''),
      onclick: () => select(key), ondblclick: () => go('day', key),
      onkeydown: (e) => { if (e.key === 'Enter') go('day', key); },
    }, [
      h('div', { class: 'cell-num' }, [
        h('span', { text: String(Number(key.slice(8))) }),
        list.length ? h('span', { class: 'cnt', text: list.filter((t) => !t.completed).length + '/' + list.length }) : null,
      ]),
      ...list.slice(0, limit).map((t) => chip(t)),
      list.length > limit ? h('button', {
        type: 'button', class: 'more', text: '+' + (list.length - limit) + ' more',
        onclick: (e) => { e.stopPropagation(); state.expandedMonth = key; render(); },
      }) : expanded && list.length > 4 ? h('button', {
        type: 'button', class: 'more', text: 'Show less',
        onclick: (e) => { e.stopPropagation(); state.expandedMonth = null; render(); },
      }) : null,
    ]), key, undefined));
  });
  return h('div', { class: 'month' }, kids);
}

/* Timed todos that overlap share the width of the column. */
function layoutTimed(list) {
  const events = list.filter((t) => t.startTime).map((t) => ({ t, a: minutes(t.startTime), b: minutes(t.endTime) }))
    .sort((x, y) => x.a - y.a || y.b - x.b);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const cols = [];
    cluster.forEach((ev) => {
      let col = cols.findIndex((end) => end <= ev.a);
      if (col < 0) { col = cols.length; cols.push(0); }
      cols[col] = ev.b; ev.col = col;
    });
    cluster.forEach((ev) => { ev.cols = cols.length; out.push(ev); });
    cluster = [];
  };
  events.forEach((ev) => {
    if (cluster.length && ev.a >= clusterEnd) flush();
    cluster.push(ev); clusterEnd = Math.max(clusterEnd, ev.b);
  });
  if (cluster.length) flush();
  return out;
}

function eventNode(ev, detailed) {
  const t = ev.t;
  const top = ev.a / 60 * HOUR_PX, height = Math.max(20, (ev.b - ev.a) / 60 * HOUR_PX - 3);
  const width = 100 / ev.cols;
  const done = t.steps.filter((s) => s.completed).length;
  const node = h('button', {
    type: 'button', class: 'event', style: '--day:' + dayTone(t.date) + ';top:' + top + 'px;height:' + height + 'px;left:calc('
      + (ev.col * width) + '% + 3px);width:calc(' + width + '% - 6px)',
    'data-done': t.completed ? 'true' : null, 'aria-pressed': state.selectedTodo === t.id ? 'true' : 'false',
    'aria-label': t.title + ', ' + fmtRange(t.startTime, t.endTime),
    onclick: (e) => { e.stopPropagation(); pick(t.id); }, ondblclick: (e) => { e.stopPropagation(); openEditor(t.id); },
  }, [
    h('b', { text: t.title }),
    h('span', { class: 't', text: fmtRange(t.startTime, t.endTime) + (detailed && t.steps.length ? ' · ' + done + '/' + t.steps.length + ' steps' : '') }),
    detailed && t.notes && height > 64 ? h('small', { text: t.notes }) : null,
  ]);
  return draggable(node, 'todo:' + t.id);
}

function timeFromDrop(col) {
  return (e) => {
    const rect = col.getBoundingClientRect();
    return timeOf(Math.round((e.clientY - rect.top) / HOUR_PX * 60 / 15) * 15);
  };
}

function column(key, single) {
  const list = todosOn(key);
  const col = h('div', { class: 'col', 'data-weekend': isWeekend(key) ? 'true' : null, role: 'presentation' });
  layoutTimed(list).forEach((ev) => col.appendChild(eventNode(ev, single)));
  if (key === today()) {
    const now = new Date();
    col.appendChild(h('div', { class: 'now', style: 'top:' + ((now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_PX) + 'px' }));
  }
  col.addEventListener('click', (e) => {
    if (e.target !== col) return;
    const rect = col.getBoundingClientRect();
    const mins = Math.floor((e.clientY - rect.top) / HOUR_PX * 60 / 30) * 30;
    state.selected = key; state.selectedTodo = null;
    openEditor(null, { date: key, startTime: timeOf(mins), endTime: timeOf(mins + 60) });
  });
  dropOnDate(col, key, timeFromDrop(col));
  return col;
}

function hoursGutter() {
  const kids = [];
  for (let i = 1; i < 24; i += 1) kids.push(h('span', { style: 'top:' + (i * HOUR_PX) + 'px', text: fmtTime(pad(i) + ':00') }));
  return h('div', { class: 'hours', 'aria-hidden': 'true' }, kids);
}

function allDay(key, opts) {
  const list = sortTodos(todosOn(key)).filter((t) => !t.startTime);
  return dropOnDate(h('div', { class: 'allday', 'aria-label': 'Untimed on ' + fmtShort(key) }, list.map((t) => chip(t, opts))), key, null);
}

function weekView() {
  const start = weekStart(state.cursor);
  const days = [];
  for (let i = 0; i < 7; i += 1) days.push(addDays(start, i));
  const kids = [h('div', { class: 'corner' })];
  days.forEach((key) => kids.push(dropOnDate(h('div', {
    class: 'dh', role: 'button', tabindex: '0', style: '--day:' + dayTone(key),
    'data-today': key === today() ? 'true' : null, 'data-selected': key === state.selected ? 'true' : null,
    onclick: () => select(key), ondblclick: () => go('day', key),
    onkeydown: (e) => { if (e.key === 'Enter') go('day', key); },
  }, [
    h('span', { class: 'kicker', text: DAYS[parseKey(key).getDay()].slice(0, 3) }),
    h('b', { text: String(Number(key.slice(8))) }),
  ]), key, undefined)));
  kids.push(h('div', { class: 'allday-label', text: 'any time' }));
  days.forEach((key) => kids.push(allDay(key)));
  kids.push(hoursGutter());
  days.forEach((key) => kids.push(column(key, false)));
  return h('div', { class: 'week' }, kids);
}

function dayView() {
  const key = state.cursor;
  const list = todosOn(key);
  const open = list.filter((t) => !t.completed).length;
  return h('div', { class: 'day' }, [
    h('div', { class: 'day-head', style: '--day:' + dayTone(key) }, [
      h('h2', {}, [h('i', { 'aria-hidden': 'true' }), fmtLong(key)]),
      h('span', { class: 'muted', text: list.length ? open + ' open of ' + list.length : 'Nothing planned' }),
      h('button', { type: 'button', class: 'btn btn-tint btn-sm', style: 'margin-left:auto', onclick: () => openEditor(null, { date: key }) }, [icon('plus'), 'Add todo']),
    ]),
    h('div', { class: 'week single' }, [
      h('div', { class: 'allday-label', text: 'any time' }),
      allDay(key, { noTime: true }),
      hoursGutter(),
      column(key, true),
    ]),
  ]);
}

function stage() {
  const view = state.view === 'year' ? yearView() : state.view === 'month' ? monthView()
    : state.view === 'week' ? weekView() : dayView();
  view.classList.add('view');
  if (state.anim) { view.dataset.anim = state.anim; state.anim = null; }
  const node = h('div', { class: 'stage', tabindex: '-1' }, [view]);
  node.addEventListener('contextmenu', (e) => {
    if (!prefs().rightClickZoom || state.view === 'year') return;
    if (e.target.closest('.todo-chip, .event, .idea, button, a, input, textarea')) return;
    e.preventDefault(); zoom(-1);
  });
  node.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (Math.abs(e.deltaY) > 8) zoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  let swipe = null;
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('[draggable="true"], button, a, input')) return;
    swipe = { x: e.clientX, y: e.clientY };
  });
  node.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 50) step(dx < 0 ? 1 : -1);
  });
  node.addEventListener('pointercancel', () => { swipe = null; });
  return node;
}

/* ------------------------------------------------------------ ideas rail */

function ideaCard(idea) {
  const open = !!idea.expanded;
  let dateInput;
  const node = h('article', { class: 'idea', 'data-open': open ? 'true' : 'false' }, [
    h('button', {
      type: 'button', class: 'idea-main', 'aria-expanded': open ? 'true' : 'false',
      onclick: () => { idea.expanded = !idea.expanded; saveLocal(); render(); },
    }, [
      h('div', { class: 'idea-title' }, [idea.title, idea.category ? h('span', { class: 'cat', text: idea.category }) : null]),
      idea.description ? h('div', { class: 'idea-desc', text: idea.description }) : null,
    ]),
    open ? h('div', { class: 'idea-actions' }, [
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', title: 'Create a todo on the selected day',
                    onclick: () => scheduleIdea(idea.id, state.selected) }, [icon('cal'), fmtRelative(state.selected)]),
      dateInput = h('input', { id: 'idea-date-' + idea.id, class: 'input', type: 'date', 'aria-label': 'Schedule on another date',
                               onchange: (e) => { if (e.target.value) scheduleIdea(idea.id, e.target.value); } }),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { state.ideaDialog = { id: idea.id }; render(); } }, ['Edit']),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', style: 'color:var(--danger)', onclick: () => {
        if (idea.description.length > 120 && !confirm('Delete “' + idea.title + '”?')) return;
        removeIdea(idea.id);
      } }, ['Delete']),
    ]) : null,
  ]);
  return draggable(node, 'idea:' + idea.id);
}

function weekCard() {
  const start = weekStart(today());
  const days = [];
  for (let i = 0; i < 7; i += 1) days.push(addDays(start, i));
  const list = state.doc.todos.filter((t) => days.includes(t.date));
  const done = list.filter((t) => t.completed).length;
  const planned = list.filter((t) => t.startTime).reduce((sum, t) => sum + minutes(t.endTime) - minutes(t.startTime), 0);
  const percent = list.length ? Math.round(done / list.length * 100) : 0;
  return h('div', { class: 'week-card' }, [
    h('span', { class: 'kicker', text: 'This week' }),
    h('h3', { text: list.length ? (planned ? fmtMinutes(planned) + ' planned' : list.length + ' todos') : 'Nothing planned yet' }),
    h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }, [h('i', { style: 'width:' + percent + '%' })]),
    h('div', { class: 'meta' }, [h('span', { text: done + ' of ' + list.length + ' complete' }), h('span', { class: 'num', text: percent + '%' })]),
  ]);
}

function ideasRail() {
  const ideas = state.doc.ideas.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const p = prefs();
  const dark = p.theme !== 'light';
  return h('aside', { class: 'panel glass rail', 'aria-label': 'Ideas' }, [
    h('div', { class: 'brand-row' }, [
      h('a', { class: 'brand', href: '.', onclick: (e) => { e.preventDefault(); goToday(); } }, [
        h('span', { class: 'chip', 'aria-hidden': 'true' }, [h('img', { src: 'todo-mark.svg', alt: '', width: '32', height: '32' })]), 'Todo',
      ]),
      h('div', { class: 'tools' }, [
        h('span', { class: 'status', 'data-state': state.sync, title: syncTitle() }, [h('i'), h('b', { text: syncLabel() })]),
        h('button', {
          type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': dark ? 'Switch to light' : 'Switch to dark',
          onclick: () => { themeOverride = null; setPref('theme', dark ? 'light' : 'dark'); },
        }, [icon(dark ? 'sun' : 'moon')]),
        h('button', { type: 'button', class: 'btn btn-icon btn-ghost sheet-close', 'aria-label': 'Close', onclick: () => { state.sheet = null; render(); } }, [icon('x')]),
      ]),
    ]),
    h('div', { class: 'rail-head' }, [
      h('h2', {}, ['Ideas', h('span', { class: 'pill', text: ideas.length })]),
      h('button', { type: 'button', class: 'btn btn-sm btn-tint', onclick: () => { state.ideaDialog = { id: null }; render(); } }, [icon('plus'), 'Idea']),
    ]),
    h('div', { class: 'note', text: 'Loose thoughts wait here. Drag one onto any date, or open it and give it a day.' }),
    h('div', { class: 'scroll' }, [
      ideas.length ? h('div', { class: 'list' }, ideas.map(ideaCard))
        : h('div', { class: 'empty' }, [
            'Nothing captured yet. An idea needs only a title; it gets a day later.',
            h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => { state.ideaDialog = { id: null }; render(); } }, [icon('plus'), 'Add the first idea']),
          ]),
    ]),
    h('div', { class: 'rail-foot' }, [
      weekCard(),
      h('div', { class: 'settings' }, [
        h('div', {}, [
          'Week starts',
          h('div', { class: 'seg small' }, [
            h('button', { type: 'button', 'aria-pressed': p.weekStartsOn === 1 ? 'true' : 'false', text: 'Mon', onclick: () => setPref('weekStartsOn', 1) }),
            h('button', { type: 'button', 'aria-pressed': p.weekStartsOn === 0 ? 'true' : 'false', text: 'Sun', onclick: () => setPref('weekStartsOn', 0) }),
          ]),
        ]),
        h('label', { class: 'check' }, [
          h('input', { type: 'checkbox', checked: p.rightClickZoom, onchange: (e) => setPref('rightClickZoom', e.target.checked) }),
          'Right-click empty space to zoom out',
        ]),
        h('div', {}, [
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'padding-left:4px', onclick: () => { state.help = true; render(); } }, [icon('help'), 'Shortcuts']),
          HOSTED ? h('a', { href: '/' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''), text: 'termox panel →', title: 'Back to the panel' }) : null,
        ]),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------ inspector */

function quickAdd() {
  return h('form', { class: 'quick', onsubmit: (e) => {
    e.preventDefault();
    const title = state.quickDraft.trim();
    if (!title) return;
    const todo = addTodo({ title, date: state.selected });
    state.quickDraft = ''; state.selectedTodo = todo.id; state.focus = 'quick';
    announce('Added ' + title + ' to ' + fmtLong(state.selected));
    commit();
  } }, [
    h('div', { class: 'label' }, [h('span', { text: 'Add to' }), h('b', { text: fmtRelative(state.selected) + ' · ' + fmtShort(state.selected).slice(4) })]),
    h('div', { class: 'rowx' }, [
      h('input', { id: 'quick', class: 'input', placeholder: 'Type a todo and press Enter', autocomplete: 'off',
                   'aria-label': 'New todo for ' + fmtLong(state.selected), value: state.quickDraft,
                   oninput: (e) => { state.quickDraft = e.target.value; } }),
      h('button', { type: 'submit', class: 'btn btn-icon btn-primary', 'aria-label': 'Add todo' }, [icon('plus')]),
    ]),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'align-self:flex-start', onclick: () => openEditor(null, { date: state.selected, title: state.quickDraft }) }, ['Add with time, notes or steps…']),
  ]);
}

function todoCard(todo) {
  const done = todo.steps.filter((s) => s.completed).length;
  const percent = todo.steps.length ? Math.round(done / todo.steps.length * 100) : (todo.completed ? 100 : 0);
  let moveInput;
  return h('div', { class: 'card', style: '--day:' + dayTone(todo.date) }, [
    h('div', { class: 'when' }, [
      h('i', { 'aria-hidden': 'true' }),
      h('span', { text: fmtRelative(todo.date) + ' · ' + fmtShort(todo.date).slice(4) }),
      h('span', { style: 'margin-left:auto', text: todo.startTime ? fmtRange(todo.startTime, todo.endTime) + ' · ' + fmtDuration(todo.startTime, todo.endTime) : 'No time' }),
    ]),
    h('h3', { 'data-done': todo.completed ? 'true' : null, text: todo.title }),
    todo.category ? h('span', { class: 'kicker', text: todo.category }) : null,
    todo.notes ? h('div', { class: 'notes', text: todo.notes }) : null,
    h('div', {}, [
      h('div', { style: 'display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:6px' }, [
        h('span', { class: 'kicker', text: 'Steps' }),
        todo.steps.length ? h('span', { class: 'muted num', text: done + ' of ' + todo.steps.length + ' · ' + percent + '%' }) : null,
      ]),
      todo.steps.length ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }, [h('i', { style: 'width:' + percent + '%' })]) : null,
      h('div', { class: 'steps' }, todo.steps.slice().sort((a, b) => a.order - b.order).map((s) => h('div', { class: 'step', 'data-done': s.completed ? 'true' : null }, [
        h('input', { type: 'checkbox', class: 'tick', checked: s.completed, 'aria-label': 'Complete ' + s.title,
                     onchange: () => { s.completed = !s.completed; touch(todo); commit(); } }),
        h('span', { class: 'title', text: s.title }),
        s.startTime ? h('span', { class: 't', text: s.endTime ? fmtRange(s.startTime, s.endTime) : fmtTime(s.startTime) }) : null,
        h('button', { type: 'button', class: 'btn btn-icon btn-ghost btn-sm step-remove', 'aria-label': 'Remove step', title: 'Remove step',
                      onclick: () => { todo.steps = todo.steps.filter((x) => x.id !== s.id).map((x, i) => Object.assign(x, { order: i })); touch(todo); commit(); } }, [icon('x')]),
      ]))),
      /* Steps are added here, inside the todo, rather than as more todos. */
      h('form', { class: 'step-add', onsubmit: (e) => {
        e.preventDefault();
        const input = e.target.querySelector('input');
        const title = input.value.trim();
        if (!title) return;
        todo.steps.push({ id: uid(), title, completed: false, startTime: null, endTime: null, order: todo.steps.length });
        touch(todo);
        state.focus = 'step-add-' + todo.id;
        announce('Added step ' + title);
        commit();
      } }, [
        h('input', { id: 'step-add-' + todo.id, class: 'input', placeholder: todo.steps.length ? 'Add another step' : 'Add a step', autocomplete: 'off',
                     'aria-label': 'New step for ' + todo.title }),
        h('button', { type: 'submit', class: 'btn btn-icon btn-sm', 'aria-label': 'Add step' }, [icon('plus')]),
      ]),
    ]),
    h('div', { class: 'actions' }, [
      h('button', { type: 'button', class: 'btn btn-sm ' + (todo.completed ? '' : 'btn-primary'), onclick: () => toggleTodo(todo.id) }, [icon('check'), todo.completed ? 'Reopen' : 'Complete']),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openEditor(todo.id) }, ['Edit']),
      todo.date !== today() ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => moveTodo(todo.id, today()) }, ['To today']) : null,
      h('button', { type: 'button', class: 'btn btn-sm btn-danger', style: 'margin-left:auto', onclick: () => removeTodo(todo.id) }, ['Delete']),
    ]),
    h('form', { class: 'move', onsubmit: (e) => { e.preventDefault(); if (moveInput.value) moveTodo(todo.id, moveInput.value); } }, [
      h('div', { class: 'field' }, [
        h('label', { for: 'move-' + todo.id, text: 'Move to' }),
        moveInput = h('input', { id: 'move-' + todo.id, class: 'input', type: 'date', value: todo.date, required: true }),
      ]),
      h('button', { type: 'submit', class: 'btn' }, ['Move']),
    ]),
  ]);
}

function daySummary() {
  const key = state.selected;
  const list = sortTodos(todosOn(key));
  const open = list.filter((t) => !t.completed);
  const timed = list.filter((t) => t.startTime);
  const late = overdue();
  return h('div', {}, [
    h('div', { class: 'summary' }, [
      h('span', { class: 'kicker', text: fmtRelative(key) }),
      h('h3', { text: fmtLong(key) }),
      h('div', { class: 'stats' }, [
        h('div', {}, [h('b', { text: list.length }), h('span', { text: 'todos' })]),
        h('div', {}, [h('b', { text: open.length }), h('span', { text: 'open' })]),
        h('div', {}, [h('b', { text: timed.length }), h('span', { text: 'timed' })]),
      ]),
    ]),
    list.length
      ? h('div', {}, [
          h('div', { class: 'group' }, [h('span', { class: 'kicker', text: 'On this day' }),
            open.length ? h('span', { class: 'muted', style: 'font-size:12px', text: 'tick to complete' }) : null]),
          h('div', { class: 'day-list' }, list.map((t) => chipRow(t))),
        ])
      : h('div', { class: 'empty' }, [
          'Nothing planned. Add one above, drag an idea here, or double-click a slot in the day view.',
          h('button', { type: 'button', class: 'btn btn-sm btn-tint', onclick: () => go('day', key) }, ['Open the day']),
        ]),
    late.length ? h('div', {}, [
      h('div', { class: 'group' }, [
        h('span', { class: 'kicker warn', text: 'Overdue · ' + late.length }),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: moveAllOverdue }, ['All to today']),
      ]),
      h('div', { class: 'day-list' }, late.slice(0, 8).map((t) => chipRow(t,
        h('button', { type: 'button', class: 'btn btn-sm btn-icon btn-ghost', 'aria-label': 'Move to today', title: 'Move to today',
                      onclick: () => moveTodo(t.id, today()) }, [icon('arrow')])))),
      late.length > 8 ? h('div', { class: 'note', text: 'and ' + (late.length - 8) + ' more' }) : null,
    ]) : null,
  ]);
}

function inspector() {
  const todo = state.selectedTodo ? todoById(state.selectedTodo) : null;
  return h('aside', { class: 'panel glass inspector', 'aria-label': 'Selected todo' }, [
    h('div', { class: 'rail-head', style: 'padding-top:18px' }, [
      h('h2', { text: state.editor ? (state.editor.id ? 'Edit todo' : 'New todo') : todo ? 'Todo' : 'Day' }),
      h('div', { style: 'display:flex;gap:4px' }, [
        !state.editor ? h('button', { type: 'button', class: 'btn btn-sm btn-tint', onclick: () => openEditor(null, { date: state.selected }) }, [icon('plus'), 'Add']) : null,
        todo && !state.editor ? h('button', { type: 'button', class: 'btn btn-icon btn-ghost btn-sm', 'aria-label': 'Back to the day', onclick: () => { state.selectedTodo = null; render(); } }, [icon('x')]) : null,
        h('button', { type: 'button', class: 'btn btn-icon btn-ghost sheet-close', 'aria-label': 'Close', onclick: () => { state.sheet = null; render(); } }, [icon('x')]),
      ]),
    ]),
    h('div', { class: 'scroll' }, [
      state.editor ? editorNode() : quickAdd(),
      state.editor ? null : todo ? todoCard(todo) : daySummary(),
    ]),
  ]);
}

/* ------------------------------------------------------------ editor */

let editorDom = null;

function openEditor(id, seed) {
  const todo = id ? todoById(id) : null;
  const draft = todo ? JSON.parse(JSON.stringify(todo)) : Object.assign({
    title: '', notes: '', date: state.selected, startTime: null, endTime: null, category: '', steps: [],
  }, seed || {});
  draft.timed = !!draft.startTime;
  if (!draft.startTime) { draft.startTime = '09:00'; draft.endTime = '10:00'; }
  state.editor = { id, draft, error: '' };
  editorDom = null;
  state.focus = 'editor-title';
  if (NARROW()) state.sheet = 'inspector';
  render();
}

function closeEditor() { state.editor = null; editorDom = null; render(); }

function saveEditor() {
  const d = state.editor.draft;
  const title = d.title.trim();
  if (!title) return setEditorError('A title is needed.');
  if (d.timed) {
    if (!d.startTime || !d.endTime) return setEditorError('Both a start and an end are needed, or remove the time.');
    if (d.endTime <= d.startTime) return setEditorError('The end must be after the start.');
  }
  for (const s of d.steps) {
    if (!s.title.trim()) return setEditorError('Every step needs a title.');
  }
  const fields = {
    title, notes: d.notes.trim(), date: d.date, category: (d.category || '').trim(),
    startTime: d.timed ? d.startTime : null, endTime: d.timed ? d.endTime : null,
    steps: d.steps.map((s, i) => ({ id: s.id || uid(), title: s.title.trim(), completed: !!s.completed,
                                     startTime: s.startTime || null, endTime: s.endTime || null, order: i })),
  };
  let todo;
  if (state.editor.id) { todo = todoById(state.editor.id); Object.assign(todo, fields); touch(todo); }
  else todo = addTodo(fields);
  state.selected = todo.date; state.selectedTodo = todo.id;
  if (!sameView(todo.date)) state.cursor = todo.date;
  state.editor = null; editorDom = null;
  announce('Saved ' + todo.title);
  commit();
}

function setEditorError(text) {
  state.editor.error = text;
  const box = editorDom && editorDom.querySelector('.error');
  if (box) box.textContent = text;
}

/* Built once per opening and reused across renders, so typing never loses
   the caret to a redraw. */
function editorNode() {
  if (editorDom) return editorDom;
  const d = state.editor.draft;
  let timeBox, stepsBox, startInput, endInput;
  const field = (label, input) => h('div', { class: 'field' }, [h('label', { for: input.id, text: label }), input]);
  const bind = (key, input) => { input.addEventListener('input', () => { d[key] = input.value; }); return input; };

  const renderSteps = () => {
    stepsBox.textContent = '';
    d.steps.forEach((s, i) => {
      stepsBox.appendChild(h('div', { class: 'step-edit' }, [
        h('input', { class: 'input', value: s.title, placeholder: 'Step', 'aria-label': 'Step ' + (i + 1), oninput: (e) => { s.title = e.target.value; },
                     onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addStep(); } } }),
        h('input', { class: 'input', type: 'time', value: s.startTime || '', 'aria-label': 'Step ' + (i + 1) + ' time', oninput: (e) => { s.startTime = e.target.value || null; } }),
        h('div', { class: 'btns' }, [
          h('button', { type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': 'Move step up', disabled: i === 0,
                        onclick: () => { d.steps.splice(i - 1, 0, d.steps.splice(i, 1)[0]); renderSteps(); } }, [icon('up')]),
          h('button', { type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': 'Move step down', disabled: i === d.steps.length - 1,
                        onclick: () => { d.steps.splice(i + 1, 0, d.steps.splice(i, 1)[0]); renderSteps(); } }, [icon('down')]),
          h('button', { type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': 'Remove step',
                        onclick: () => { d.steps.splice(i, 1); renderSteps(); } }, [icon('x')]),
        ]),
      ]));
    });
    stepsBox.appendChild(h('button', { type: 'button', class: 'btn btn-sm btn-ghost', style: 'align-self:flex-start', onclick: addStep }, [icon('plus'), 'Add step']));
  };
  const addStep = () => {
    d.steps.push({ id: uid(), title: '', completed: false, startTime: null, endTime: null });
    renderSteps();
    const inputs = stepsBox.querySelectorAll('.step-edit input');
    if (inputs.length) inputs[inputs.length - 2].focus();
  };

  /* The end follows the start so a moved start keeps the duration; the
     presets set a duration from the start. */
  const setDuration = (mins) => { d.endTime = timeOf(Math.min(1439, minutes(d.startTime) + mins)); endInput.value = d.endTime; };
  const onStart = () => {
    const length = Math.max(15, minutes(endInput.value || d.endTime) - minutes(d.startTime));
    d.startTime = startInput.value || d.startTime;
    setDuration(length);
  };
  const setTimed = (on) => {
    d.timed = on;
    timeBox.hidden = !on;
    timeBox.previousSibling.replaceWith(timeToggle());
    if (on) startInput.focus();
  };
  const timeToggle = () => h('button', { type: 'button', class: 'time-toggle', 'aria-expanded': d.timed ? 'true' : 'false',
    onclick: () => setTimed(!d.timed) }, [icon('clock'), d.timed ? 'Remove time' : 'Add a time']);

  editorDom = h('form', { class: 'editor', onsubmit: (e) => { e.preventDefault(); saveEditor(); } }, [
    h('div', { class: 'error', role: 'alert', text: state.editor.error }),
    field('Title', bind('title', h('input', { id: 'editor-title', class: 'input', value: d.title, required: true, maxlength: 200, placeholder: 'What needs doing?', autocomplete: 'off' }))),
    field('Notes', bind('notes', h('textarea', { id: 'editor-notes', class: 'input', placeholder: 'A little context', text: d.notes }))),
    h('div', { class: 'row' }, [
      field('Date', bind('date', h('input', { id: 'editor-date', class: 'input', type: 'date', value: d.date, required: true }))),
      field('Category', bind('category', h('input', { id: 'editor-cat', class: 'input', value: d.category || '', placeholder: 'Optional', autocomplete: 'off' }))),
    ]),
    timeToggle(),
    timeBox = h('div', { style: 'display:flex;flex-direction:column;gap:10px', hidden: !d.timed }, [
      h('div', { class: 'row' }, [
        field('Start', startInput = h('input', { id: 'editor-start', class: 'input', type: 'time', value: d.startTime, oninput: onStart })),
        field('End', endInput = bind('endTime', h('input', { id: 'editor-end', class: 'input', type: 'time', value: d.endTime }))),
      ]),
      h('div', { class: 'presets' }, [15, 30, 60, 90, 120].map((m) =>
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => setDuration(m), text: fmtMinutes(m) }))),
    ]),
    h('div', { class: 'field' }, [h('label', { text: 'Steps' }), stepsBox = h('div', { style: 'display:flex;flex-direction:column;gap:6px' })]),
    h('div', { class: 'foot' }, [
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeEditor }, ['Cancel']),
      h('button', { type: 'submit', class: 'btn btn-primary' }, [state.editor.id ? 'Save' : 'Add todo']),
    ]),
  ]);
  editorDom.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveEditor(); } });
  renderSteps();
  return editorDom;
}

/* ------------------------------------------------------------ dialogs */

function ideaDialog() {
  const idea = state.ideaDialog.id ? ideaById(state.ideaDialog.id) : null;
  let title, desc, cat;
  const close = () => { state.ideaDialog = null; render(); };
  return h('div', { class: 'scrim', onclick: (e) => { if (e.target === e.currentTarget) close(); } }, [
    h('form', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'idea-heading', onsubmit: (e) => {
      e.preventDefault();
      if (!title.value.trim()) { title.focus(); return; }
      if (idea) { Object.assign(idea, { title: title.value.trim(), description: desc.value.trim(), category: cat.value.trim() }); touch(idea); }
      else state.doc.ideas.push({ id: uid(), title: title.value.trim(), description: desc.value.trim(), category: cat.value.trim(),
                                  expanded: false, createdAt: stamp(), updatedAt: stamp() });
      state.ideaDialog = null;
      announce(idea ? 'Idea updated' : 'Idea added');
      commit();
    } }, [
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [
        h('h3', { id: 'idea-heading', text: idea ? 'Edit idea' : 'New idea' }),
        h('button', { type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': 'Close', onclick: close }, [icon('x')]),
      ]),
      h('div', { class: 'field' }, [h('label', { for: 'idea-title', text: 'Title' }), title = h('input', { id: 'idea-title', class: 'input', required: true, maxlength: 200, value: idea ? idea.title : '', autocomplete: 'off', placeholder: 'Name the idea' })]),
      h('div', { class: 'field' }, [h('label', { for: 'idea-desc', text: 'Description' }), desc = h('textarea', { id: 'idea-desc', class: 'input', text: idea ? idea.description : '', placeholder: 'Optional' })]),
      h('div', { class: 'field' }, [h('label', { for: 'idea-cat', text: 'Category' }), cat = h('input', { id: 'idea-cat', class: 'input', placeholder: 'Optional', value: idea ? idea.category : '', autocomplete: 'off' })]),
      h('div', { class: 'foot' }, [
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, ['Cancel']),
        h('button', { type: 'submit', class: 'btn btn-primary' }, [idea ? 'Save' : 'Add idea']),
      ]),
    ]),
  ]);
}

function helpDialog() {
  const close = () => { state.help = false; render(); };
  const rows = [
    ['← →', 'Previous and next period'], ['+ −', 'Zoom in and out'], ['T', 'Jump to today'],
    ['N', 'Focus the quick add'], ['E', 'Edit the selected todo'], ['Space', 'Complete or reopen it'],
    ['⌫', 'Delete it, with undo'], ['Esc', 'Close whatever is open'], ['?', 'This list'],
  ];
  return h('div', { class: 'scrim', onclick: (e) => { if (e.target === e.currentTarget) close(); } }, [
    h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-heading' }, [
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [
        h('h3', { id: 'help-heading', text: 'Shortcuts' }),
        h('button', { type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': 'Close', onclick: close }, [icon('x')]),
      ]),
      h('div', { class: 'keys' }, rows.flatMap(([k, v]) => [h('kbd', { text: k }), h('span', { text: v })])),
      h('p', { class: 'muted', style: 'font-size:12.5px', text: 'With a mouse: double-click a date to open it, right-click empty space to zoom out, Ctrl + wheel to zoom, drag ideas and todos onto dates. Hold Alt while dropping an idea to move it out of the inbox.' }),
    ]),
  ]);
}

/* ------------------------------------------------------------ toasts */

const toastBox = h('div', { class: 'toasts' });

function toast(text, kind, action) {
  const node = h('div', { class: 'toast' + (kind === 'bad' ? ' bad' : ''), role: 'status' }, [
    h('i'), h('span', { text }),
    action ? h('button', { type: 'button', class: 'btn btn-tint', onclick: () => { node.remove(); action.run(); } }, [action.label]) : null,
  ]);
  toastBox.appendChild(node);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
  setTimeout(() => node.remove(), action ? 8000 : 4500);
}

/* ------------------------------------------------------------ shell */

const root = document.getElementById('app');

/* What a redraw must not lose: text typed into any field, and where the
   caret was. The page is rebuilt on every change, and a save completing or
   another device syncing must never blank what is being typed. */
function snapshotTyping() {
  const values = {};
  root.querySelectorAll('input[id], textarea[id]').forEach((el) => {
    if (el.type === 'checkbox' || el.type === 'radio') return;
    if (el.value) values[el.id] = el.value;
  });
  const active = document.activeElement;
  let caret = null;
  if (active && active.id && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    try { caret = { id: active.id, start: active.selectionStart, end: active.selectionEnd }; } catch (err) { caret = { id: active.id }; }
  }
  return { values, caret };
}

function restoreTyping(typing) {
  Object.keys(typing.values).forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.value === '') el.value = typing.values[id];
  });
  const caret = typing.caret;
  const el = caret && document.getElementById(caret.id);
  if (el && document.activeElement === el && caret.start !== undefined && caret.start !== null) {
    try { el.setSelectionRange(caret.start, caret.end); } catch (err) { /* date and time inputs refuse */ }
  }
}

function render() {
  document.documentElement.dataset.theme = prefs().theme === 'light' ? 'light' : 'dark';
  const typing = snapshotTyping();
  const active = document.activeElement;
  const keepFocus = active && active.id && !state.focus ? active.id : null;
  const stageEl = root.querySelector('.stage');
  const scroll = stageEl ? { top: stageEl.scrollTop, left: stageEl.scrollLeft } : null;
  const wasView = root.dataset.view;

  const app = h('div', { class: 'app', 'data-sheet': state.sheet }, [
    ideasRail(),
    h('section', { class: 'panel glass canvas', 'aria-label': 'Calendar' }, [toolbar(), stage()]),
    inspector(),
    state.sheet ? h('div', { class: 'sheet-scrim', onclick: () => { state.sheet = null; render(); } }) : null,
    h('nav', { class: 'dock', 'aria-label': 'Panels' }, [
      h('button', { type: 'button', class: 'btn', 'aria-pressed': state.sheet === 'ideas' ? 'true' : 'false', onclick: () => openSheet('ideas') }, [icon('bulb'), 'Ideas']),
      h('button', { type: 'button', class: 'btn', onclick: goToday }, [icon('cal'), 'Today']),
      h('button', { type: 'button', class: 'btn', onclick: () => openEditor(null, { date: state.selected }) }, [icon('plus'), 'Add']),
      h('button', { type: 'button', class: 'btn', 'aria-pressed': state.sheet === 'inspector' ? 'true' : 'false', onclick: () => openSheet('inspector') }, [icon('list'), 'Details']),
    ]),
  ]);
  root.textContent = '';
  root.appendChild(app);
  root.dataset.view = state.view;
  root.setAttribute('aria-busy', 'false');
  if (state.ideaDialog) { root.appendChild(ideaDialog()); const first = root.querySelector('#idea-title'); if (first) first.focus(); }
  else if (state.help) root.appendChild(helpDialog());
  if (!toastBox.parentNode) document.body.appendChild(toastBox);

  const newStage = root.querySelector('.stage');
  if (newStage) {
    if (scroll && wasView === state.view) { newStage.scrollTop = scroll.top; newStage.scrollLeft = scroll.left; }
    else if (state.view === 'week' || state.view === 'day') {
      /* Land on now when today is on screen, else on the working morning. */
      const now = new Date();
      newStage.scrollTop = sameView(today()) ? Math.max(0, (now.getHours() - 1.5) * HOUR_PX) : 7 * HOUR_PX;
    }
  }
  if (state.focus) {
    const target = document.getElementById(state.focus);
    if (target) target.focus();
    state.focus = null;
  } else if (keepFocus) {
    const target = document.getElementById(keepFocus);
    if (target) target.focus();
  }
  restoreTyping(typing);
}

/* The red line in the week and day views moves without a redraw. */
function tickNowLine() {
  const now = new Date();
  const top = ((now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_PX) + 'px';
  root.querySelectorAll('.now').forEach((line) => { line.style.top = top; });
}

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  if (e.key === 'Escape') {
    if (state.ideaDialog) { state.ideaDialog = null; render(); }
    else if (state.help) { state.help = false; render(); }
    else if (state.editor) closeEditor();
    else if (state.sheet) { state.sheet = null; render(); }
    else if (state.selectedTodo) { state.selectedTodo = null; render(); }
    return;
  }
  if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
  const selected = state.selectedTodo && !state.editor ? todoById(state.selectedTodo) : null;
  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === '+' || e.key === '=') zoom(1);
  else if (e.key === '-') zoom(-1);
  else if (e.key === '?') { state.help = !state.help; render(); }
  else if (e.key === 't') goToday();
  else if (e.key === 'n') { e.preventDefault(); state.focus = 'quick'; if (NARROW()) state.sheet = 'inspector'; render(); }
  else if (selected && e.key === 'e') { e.preventDefault(); openEditor(selected.id); }
  else if (selected && e.key === ' ') { e.preventDefault(); toggleTodo(selected.id); }
  else if (selected && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removeTodo(selected.id); }
});

/* ------------------------------------------------------------ start */

loadLocal();
state.view = prefs().defaultView;
/* A link can carry a view, a date and a ground: ?view=week&date=2026-09-16&theme=light */
const params = new URLSearchParams(location.search);
if (VIEWS.includes(params.get('view'))) state.view = params.get('view');
if (/^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '')) { state.cursor = params.get('date'); state.selected = params.get('date'); }
if (params.get('theme') === 'light' || params.get('theme') === 'dark') themeOverride = params.get('theme');
if (/^[A-Za-z0-9_-]{1,64}$/.test(params.get('todo') || '')) { wantTodo = params.get('todo'); claimWanted(); }
render();
pull(true);
if (API) {
  setInterval(() => { if (!pending) pull(false); }, PULL_EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(false); });
}
setInterval(tickNowLine, 60000);
