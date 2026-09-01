/* termox — the Modernist panel from the Claude Design project, wired to the
   real readings.

   The design is a set of screens over one polled snapshot: Everything, the
   host, each machine, each service, and the access screen. Markup here follows
   the design's own structure and inline styling so the two stay comparable;
   the system's classes (.btn, .tag, .table, .input, .seg) come from ds.css and
   are never redefined.                                                        */

'use strict';

const POLL_MS = 2000;
const TOKEN = new URLSearchParams(location.search).get('token');

const state = {
  data: null,
  view: new URLSearchParams(location.search).get('view')
        || sessionStorage.getItem('termox.view') || 'overview',
  window: sessionStorage.getItem('termox.window') || '90s',
  /* ?theme= wins over the stored choice, so a link can carry the ground it
     was meant to be read on. */
  theme: new URLSearchParams(location.search).get('theme')
         || localStorage.getItem('termox.theme') || 'dark',
  failures: 0,
  chat: [],
  draft: '',
  sending: false,
  logs: {},
};

/* ------------------------------------------------------------ formatting */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

function bytes(value, digits) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  let n = Number(value), i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i += 1; }
  const d = digits === undefined ? (n < 10 && i > 0 ? 1 : 0) : digits;
  return n.toFixed(d) + ' ' + UNITS[i];
}

function num(value, digits) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  const n = Number(value);
  const d = digits === undefined ? 0 : digits;
  return n >= 1000 && d === 0 ? n.toLocaleString('en-US') : n.toFixed(d);
}

function pct(value, digits) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  return Number(value).toFixed(digits === undefined ? 0 : digits) + '%';
}

function duration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '--';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

function ago(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return 'never';
  return duration(seconds) + ' ago';
}

/* ------------------------------------------------------------------- dom */

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

function svg(tag, props, children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const key in props || {}) {
    if (props[key] !== null && props[key] !== undefined) {
      node.setAttribute(key, props[key]);
    }
  }
  (children || []).forEach((c) => c && node.appendChild(c));
  return node;
}

const DIV = '2px solid var(--color-divider)';

/* --------------------------------------------------------------- charts */

/* The design draws every reading the same way: a 1000x200 viewBox stretched
   to the column, a mid rule and a top rule for scale, an ink area under a
   hue-coloured line, and an optional dashed threshold. Stroke width is held
   at 2px through the stretch with vector-effect. */
function chart(values, opts) {
  const options = opts || {};
  const points = (values || []).slice();
  const clean = points.filter((v) => v !== null && v !== undefined);
  if (clean.length < 2) {
    return h('div', {
      class: 'text-muted',
      style: 'height:148px;display:flex;align-items:center;justify-content:center;'
           + 'border:1px dashed var(--color-divider);font-size:12px',
      text: clean.length ? 'one sample so far' : 'nothing recorded for this window yet',
    });
  }

  const max = options.max !== undefined ? options.max
    : Math.max.apply(null, clean) * 1.15 || 1;
  const W = 1000, H = 200;
  const x = (i) => (points.length < 2 ? W : (i / (points.length - 1)) * W);
  const y = (v) => H - Math.max(0, Math.min(max, v)) / max * (H - 6) - 3;

  /* Build one subpath per contiguous run of samples. Doing it in a single
     path was drawing a wedge from the origin whenever a gap split the data,
     because the close-to-baseline was applied once at the end rather than per
     run. */
  const runs = [];
  let run = null;
  points.forEach((v, i) => {
    if (v === null || v === undefined) { run = null; return; }
    if (!run) { run = []; runs.push(run); }
    run.push([x(i), y(v)]);
  });

  const line = runs.map((r) =>
    r.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')
  ).join(' ');

  const area = runs.filter((r) => r.length > 1).map((r) =>
    r.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')
    + ' L' + r[r.length - 1][0].toFixed(1) + ' ' + H
    + ' L' + r[0][0].toFixed(1) + ' ' + H + ' Z'
  ).join(' ');

  const kids = [
    svg('line', { x1: 0, x2: W, y1: H / 2, y2: H / 2, stroke: 'var(--color-neutral-300)',
                  'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    svg('line', { x1: 0, x2: W, y1: 3, y2: 3, stroke: 'var(--color-neutral-300)',
                  'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
  ];
  if (options.threshold !== undefined && options.threshold !== null) {
    kids.push(svg('line', {
      x1: 0, x2: W, y1: y(options.threshold), y2: y(options.threshold),
      stroke: 'var(--color-accent)', 'stroke-width': 1, 'stroke-dasharray': '6 5',
      'vector-effect': 'non-scaling-stroke',
    }));
  }
  kids.push(svg('path', { class: 'tx-area', d: area }));
  kids.push(svg('path', {
    class: 'tx-line', d: line, fill: 'none', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
  }));

  return svg('svg', {
    viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img',
    'aria-label': options.label || 'reading',
    'data-tx-hue': options.hue || 'blue',
    style: 'display:block;width:100%;height:148px',
  }, kids);
}

function figure(title, readout, values, opts) {
  const options = opts || {};
  return h('figure', { style: 'margin:0;min-width:0' }, [
    h('div', {
      style: 'display:flex;align-items:baseline;justify-content:space-between;gap:12px;'
           + 'border-bottom:' + DIV + ';padding-bottom:8px;margin-bottom:14px',
    }, [
      h('h6', { style: 'margin:0', text: title }),
      h('span', { style: 'font-size:12px;font-variant-numeric:tabular-nums' }, [readout]),
    ]),
    chart(values, options),
    h('div', {
      style: 'display:flex;justify-content:space-between;gap:12px;font-size:11px;'
           + 'margin-top:8px;border-top:1px solid var(--color-divider);padding-top:6px',
    }, [
      h('span', { class: 'text-muted', text: state.window + ' ago' }),
      options.note ? h('span', { class: 'text-muted', style: 'text-align:center', text: options.note }) : null,
      h('span', { class: 'text-muted', text: 'now' }),
    ]),
  ]);
}

function readout(now, rest) {
  return h('span', {}, [now, ' ', h('span', { class: 'text-muted', text: rest })]);
}

/* ---------------------------------------------------------------- pieces */

function stat(label, value, unit, sub, hue) {
  return h('div', {
    style: 'background:var(--color-bg);padding:13px 18px 18px;border-top:3px solid '
         + (hue ? 'var(--tx-' + hue + ')' : 'var(--color-neutral-400)'),
  }, [
    h('h6', { style: 'margin:0 0 6px' + (hue ? ';color:var(--tx-' + hue + '-ink)' : ''), text: label }),
    h('div', {
      style: 'font-family:var(--font-heading);font-weight:800;font-size:40px;'
           + 'line-height:1;letter-spacing:-.02em',
    }, [value, unit ? h('span', { style: 'font-size:17px', text: unit }) : null]),
    h('div', { class: 'text-muted', style: 'font-size:11.5px;margin-top:4px', text: sub || '' }),
  ]);
}

function tile(label, value, unit, sub) {
  return h('div', { style: 'background:var(--color-bg);padding:16px 18px 18px' }, [
    h('h6', { style: 'margin:0 0 6px', text: label }),
    h('div', {
      style: 'font-family:var(--font-heading);font-weight:800;font-size:32px;'
           + 'line-height:1;letter-spacing:-.02em',
    }, [value, unit ? h('span', { style: 'font-size:17px', text: unit }) : null]),
    h('div', { class: 'text-muted', style: 'font-size:11.5px;margin-top:4px', text: sub || '' }),
  ]);
}

function dl(pairs) {
  const kids = [];
  pairs.filter(Boolean).forEach(([term, value]) => {
    kids.push(h('dt', {
      class: 'text-muted',
      style: 'font-size:12px;padding:7px 0;border-bottom:1px solid var(--color-divider)',
      text: term,
    }));
    kids.push(h('dd', {
      style: 'margin:0;font-size:13px;text-align:right;padding:7px 0;'
           + 'border-bottom:1px solid var(--color-divider);min-width:0;overflow-wrap:anywhere',
    }, [typeof value === 'string' ? value : value]));
  });
  return h('dl', {
    style: 'margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);'
         + 'align-items:baseline;column-gap:16px',
  }, kids);
}

function bar(percent, hue) {
  const width = Math.max(0, Math.min(100, percent || 0));
  return h('div', { style: 'height:8px;background:var(--color-neutral-300)' }, [
    h('i', {
      style: 'display:block;height:100%;width:' + width.toFixed(1) + '%;background:'
           + (hue === 'accent' ? 'var(--color-accent)'
              : hue ? 'var(--tx-' + hue + ')' : 'var(--color-text)'),
    }),
  ]);
}

function sectionHead(title, note, right) {
  return h('div', {
    style: 'display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:16px',
  }, [
    h('h3', { style: 'margin:0', text: title }),
    note ? h('span', { class: 'text-muted', style: 'font-size:12px;flex:1;min-width:200px', text: note }) : null,
    right || null,
  ]);
}

function stateTag(label, kind) {
  const hue = kind === 'up' ? 'green' : kind === 'busy' ? null : 'red';
  return h('span', {
    class: 'tag tag-outline', 'data-tx-hue': hue || undefined,
    style: hue ? 'gap:6px' : 'gap:6px;border-color:var(--color-accent);color:var(--color-accent)',
  }, [
    kind === 'busy' ? h('span', { class: 'tx-spin' }) : null,
    label,
  ]);
}

/* -------------------------------------------------------------- control */

const pendingTargets = new Set();

async function act(target, action, label) {
  if (pendingTargets.has(target)) return;
  pendingTargets.add(target);
  toast('work', label, action + 'ing');
  render();
  try {
    const response = await fetch('/api/control', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' },
                             TOKEN ? { 'X-Termox-Token': TOKEN } : {}),
      body: JSON.stringify({ target: target, action: action }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'refused');
    if (data.note) toast('work', label, data.note);
  } catch (err) {
    toast('bad', label, err.message);
  } finally {
    pendingTargets.delete(target);
    poll();
  }
}

function transitional(s) { return s === 'starting' || s === 'stopping'; }

function actions(target, itemState, job, label, size) {
  const busy = !!job || pendingTargets.has(target) || transitional(itemState);
  const small = size === 'small'
    ? 'font-size:11px;padding:3px 9px;justify-content:flex-start'
    : 'justify-content:flex-start';

  if (busy) {
    return [h('button', { type: 'button', class: 'btn btn-secondary', disabled: true, style: small }, [
      h('span', { class: 'tx-spin' }),
      itemState === 'stopping' ? 'Stopping' : 'Starting',
    ])];
  }
  if (itemState !== 'running') {
    return [h('button', {
      type: 'button', class: 'btn btn-primary', style: small,
      onclick: (e) => { e.stopPropagation(); act(target, 'start', label); },
    }, ['Start'])];
  }
  return [
    h('button', {
      type: 'button', class: 'btn btn-secondary', style: small,
      onclick: (e) => { e.stopPropagation(); act(target, 'restart', label); },
    }, ['Restart']),
    h('button', {
      type: 'button', class: 'btn btn-secondary', style: small,
      onclick: (e) => { e.stopPropagation(); act(target, 'stop', label); },
    }, ['Stop']),
  ];
}

function activity(job, itemState) {
  if (!job && !transitional(itemState)) return null;
  const phase = job && job.phase;
  const verb = job
    ? (phase === 'stopping' ? 'Stopping'
       : job.action === 'restart' ? 'Restarting' : 'Starting')
    : (itemState === 'stopping' ? 'Stopping' : 'Starting');
  const detail = job ? job.message : 'up but not answering on its port yet';
  return h('div', {
    style: 'display:flex;align-items:center;gap:10px;padding:12px 24px;'
         + 'background:var(--color-accent-100);border-bottom:' + DIV,
  }, [
    h('span', { 'data-tx-dot': 'busy', style: 'flex:none' }),
    h('span', { style: 'font-family:var(--font-heading);font-weight:800;font-size:14px', text: verb }),
    h('span', { class: 'text-muted', style: 'font-size:13px', text: detail }),
  ]);
}

/* --------------------------------------------------------------- toasts */

const toastBox = h('div', { class: 'tx-toasts' });
const seenJobs = new Map();

function toast(level, title, detail, ttl) {
  const node = h('div', { class: 'tx-toast ' + level }, [
    h('i'),
    h('div', { style: 'min-width:0' }, [
      h('div', { style: 'font-family:var(--font-heading);font-weight:800', text: title }),
      detail ? h('div', { class: 'text-muted', style: 'margin-top:2px', text: detail }) : null,
    ]),
  ]);
  toastBox.appendChild(node);
  setTimeout(() => node.remove(), ttl || (level === 'work' ? 4000 : 7000));
}

function announceJobs(jobs) {
  (jobs || []).forEach((job) => {
    const was = seenJobs.get(job.id);
    seenJobs.set(job.id, job.state);
    if (was && was !== job.state && job.state !== 'running') {
      toast(job.state === 'done' ? 'good' : 'bad', job.label, job.message);
    }
  });
}

/* ------------------------------------------------------------ navigation */

function go(view) {
  state.view = view;
  sessionStorage.setItem('termox.view', view);
  const url = new URL(location.href);
  if (view === 'overview') url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  history.replaceState(null, '', url);
  render();
  const main = document.querySelector('main');
  if (main) { main.focus(); window.scrollTo(0, 0); }
}

function setWindow(label) {
  state.window = label;
  sessionStorage.setItem('termox.window', label);
  render();
}

function readingFor(name) {
  const all = (state.data && state.data.readings) || {};
  return (all[name] || {})[state.window] || [];
}

function serviceReading(id, kind) {
  const all = (state.data && state.data.serviceReadings) || {};
  return (all[id + '.' + kind] || {})[state.window] || [];
}

function latest(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null && values[i] !== undefined) return values[i];
  }
  return null;
}

function peak(values) {
  const clean = values.filter((v) => v !== null && v !== undefined);
  return clean.length ? Math.max.apply(null, clean) : null;
}

/* ---------------------------------------------------------------- header */

function header(data) {
  const host = data.host || {};
  const id = host.identity || {};
  const nodes = data.nodes || [];
  const services = data.services || [];
  const up = (list) => list.filter((x) => x.state === 'running').length;
  const control = data.control || {};

  /* The chip stays ink in both grounds, which is what lets the mark keep its
     paper stroke without a second asset. */
  const chip = h('span', {
    style: 'width:30px;height:30px;flex:none;display:grid;place-items:center;background:#1c1a19',
  }, [
    h('img', { src: 'termox-logo.svg', alt: '', width: '24', height: '24',
               style: 'display:block' }),
  ]);

  return h('header', {
    'data-tx-head': 'true',
    style: 'display:flex;align-items:center;gap:24px;padding:12px 24px;border-bottom:' + DIV
         + ';background:var(--color-bg);position:sticky;top:0;z-index:30;flex-wrap:wrap',
  }, [
    h('div', { style: 'display:flex;align-items:center;gap:10px' }, [
      chip,
      h('span', {
        style: 'font-family:var(--font-heading);font-weight:800;font-size:18px;letter-spacing:-.015em',
        text: 'termox',
      }),
    ]),
    h('div', { style: 'display:flex;gap:20px;font-size:12px;flex-wrap:wrap;min-width:0' }, [
      h('span', {}, [h('span', { class: 'text-muted', text: 'host ' }), id.address || '--']),
      h('span', {}, [h('span', { class: 'text-muted', text: 'up ' }), duration(host.uptime)]),
      h('span', {}, [h('span', { class: 'text-muted', text: 'machines ' }),
                     up(nodes) + ' / ' + nodes.length]),
      h('span', {}, [h('span', { class: 'text-muted', text: 'services ' }),
                     up(services) + ' / ' + services.length]),
    ]),
    h('div', { style: 'margin-left:auto;display:flex;align-items:center;gap:12px' }, [
      h('span', {
        class: 'tag tag-outline tx-live', 'data-tx-hue': state.failures ? 'red' : 'green',
        style: 'gap:6px',
      }, [
        h('i', {
          style: 'width:6px;height:6px;background:var(--tx-'
               + (state.failures ? 'red' : 'green') + ');animation:tx-beat 2.4s ease-in-out infinite',
        }),
        state.failures ? 'RETRYING' : 'LIVE · 2s',
      ]),
      h('button', {
        type: 'button', class: 'btn btn-secondary', style: 'justify-content:flex-start',
        onclick: () => go('access'),
      }, [control.token_required ? 'Token required' : 'Unauthenticated']),
      h('button', {
        type: 'button', class: 'btn btn-secondary', style: 'justify-content:flex-start',
        'aria-pressed': state.theme === 'dark' ? 'true' : 'false',
        onclick: toggleTheme,
      }, [state.theme === 'dark' ? 'Light' : 'Dark']),
    ]),
  ]);
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('termox.theme', state.theme);
  render();
}

/* ------------------------------------------------------------------ rail */

function railEntry(opts) {
  const on = state.view === opts.view;
  return h('div', {
    'data-tx-entry': 'true', 'data-tx-on': on ? 'true' : 'false',
  }, [
    h('button', {
      type: 'button',
      style: 'display:block;width:100%;text-align:left;padding:12px 16px'
           + (opts.actions ? ' 6px' : '') + ';background:transparent;border:0;'
           + 'cursor:pointer;font:inherit;color:inherit',
      onclick: () => go(opts.view),
    }, [
      h('span', { style: 'display:flex;align-items:baseline;gap:8px' }, [
        opts.dot ? h('span', { 'data-tx-dot': opts.dot, style: 'flex:none' }) : null,
        h('span', {
          style: 'font-family:var(--font-heading);font-weight:800;font-size:15px;flex:1;min-width:0',
          text: opts.name,
        }),
        opts.metric ? h('span', {
          style: 'font-size:13px;font-variant-numeric:tabular-nums', text: opts.metric,
        }) : null,
      ]),
      h('span', {
        class: 'text-muted',
        style: 'display:block;font-size:11.5px;padding-left:' + (opts.dot ? '16px' : '0'),
        text: opts.sub,
      }),
    ]),
    opts.actions ? h('div', { style: 'display:flex;gap:6px;padding:0 16px 12px' }, opts.actions) : null,
  ]);
}

function rail(data) {
  const host = data.host || {};
  const id = host.identity || {};
  const battery = host.battery || {};
  const hottest = (host.thermals || [])[0];
  const nodes = data.nodes || [];
  const services = data.services || [];
  const kids = [];

  kids.push(h('div', { 'data-tx-entry': 'true', 'data-tx-on': state.view === 'overview' ? 'true' : 'false' }, [
    h('button', {
      type: 'button',
      style: 'display:block;width:100%;text-align:left;padding:15px 16px;background:transparent;'
           + 'border:0;cursor:pointer;font:inherit;color:inherit',
      onclick: () => go('overview'),
    }, [
      h('span', { style: 'display:block;font-family:var(--font-heading);font-weight:800;font-size:16px', text: 'Everything' }),
      h('span', { class: 'text-muted', style: 'display:block;font-size:11.5px', text: 'the whole stack on one page' }),
    ]),
  ]));

  kids.push(h('div', { 'data-tx-group': 'true' }, [
    h('span', { text: 'Host' }), h('span', { 'data-tx-count': 'true', text: '1' }),
  ]));
  kids.push(railEntry({
    view: 'host', dot: 'live', name: id.device || id.hostname || 'this phone',
    metric: pct((host.cpu || {}).total),
    sub: [pct((host.memory || {}).percent) + ' memory',
          battery.available ? battery.percentage + '% battery' : null,
          hottest ? hottest.celsius.toFixed(1) + ' °C' : null].filter(Boolean).join(' · '),
  }));

  const upNodes = nodes.filter((n) => n.state === 'running').length;
  kids.push(h('div', { 'data-tx-group': 'true' }, [
    h('span', { text: 'Machines' }),
    h('span', { 'data-tx-count': 'true', text: upNodes + ' of ' + nodes.length + ' up' }),
  ]));
  nodes.forEach((node) => {
    const runtime = node.runtime || {};
    const spec = node.spec || {};
    kids.push(railEntry({
      view: 'node:' + node.key, name: node.name,
      dot: transitional(node.state) ? 'busy' : node.state === 'running' ? 'up' : 'down',
      metric: node.state === 'running' ? pct(runtime.cpu_percent) : null,
      sub: node.state === 'running'
        ? [(spec.cores || '?') + ' cores', bytes((spec.memory_mb || 0) * 1024 * 1024)].join(' · ')
        : ['stopped', (spec.cores || '?') + ' cores',
           bytes((spec.memory_mb || 0) * 1024 * 1024)].join(' · '),
      actions: actions(node.key, node.state, node.job, node.name, 'small'),
    }));
  });

  const upServices = services.filter((s) => s.state === 'running').length;
  kids.push(h('div', { 'data-tx-group': 'true' }, [
    h('span', { text: 'Services' }),
    h('span', { 'data-tx-count': 'true', text: upServices + ' of ' + services.length + ' up' }),
  ]));
  services.forEach((service) => {
    const runtime = service.runtime || {};
    const metrics = service.metrics || {};
    let sub;
    if (service.state !== 'running') {
      sub = service.state;
    } else if (service.id === 'dns') {
      sub = [(service.dns_open ? 'resolving on ' + service.dns_port : 'port closed'),
             bytes(runtime.rss)].join(' · ');
    } else if (service.id === 'autoclaim') {
      const c = service.claim_profiles || {};
      const waiting = compensationPending(service);
      sub = [(c.auto ? c.settled + ' of ' + c.auto + ' claimed' : 'no profiles'),
             waiting ? waiting + ' compensation waiting' : null,
             bytes(runtime.rss)].filter(Boolean).join(' · ');
    } else {
      const rate = metrics.tokens_per_second || metrics.average_tps;
      sub = [rate ? num(rate, 1) + ' tok/s' : 'no requests yet',
             bytes(runtime.rss)].filter(Boolean).join(' · ');
    }
    kids.push(railEntry({
      view: 'svc:' + service.id, name: service.name,
      dot: transitional(service.state) ? 'busy' : service.state === 'running' ? 'up' : 'down',
      metric: service.state === 'running' ? pct(runtime.cpu_percent) : null,
      sub: sub,
      actions: actions('svc:' + service.id, service.state, service.job, service.name, 'small'),
    }));
  });

  kids.push(h('div', { style: 'border-top:' + DIV }));

  return h('nav', {
    'aria-label': 'Machines and services', 'data-tx-rail': 'true',
    style: 'border-right:' + DIV + ';position:sticky;top:59px;align-self:start',
  }, kids);
}

/* -------------------------------------------------------------- overview */

function poster(data) {
  const alerts = data.alerts || [];
  if (!alerts.length) {
    return h('div', {
      'data-tx-poster': 'true',
      style: 'background:var(--color-accent);padding:20px 24px',
    }, [
      h('div', { style: 'display:flex;align-items:baseline;gap:16px;flex-wrap:wrap' }, [
        h('span', {
          style: 'font-family:var(--font-heading);font-weight:800;font-size:25px;line-height:1.12',
          text: 'Nothing wants you',
        }),
        h('span', { style: 'font-size:12px',
                    text: 'every service up, nothing over its threshold' }),
      ]),
    ]);
  }
  return h('div', {
    'data-tx-poster': 'true', style: 'background:var(--color-accent);padding:20px 24px',
  }, [
    h('div', { style: 'display:flex;align-items:baseline;gap:16px;flex-wrap:wrap' }, [
      h('span', {
        style: 'font-family:var(--font-heading);font-weight:800;font-size:25px;line-height:1.12',
        text: alerts.length + (alerts.length === 1 ? ' thing wants you' : ' things want you'),
      }),
      h('span', { style: 'font-size:12px',
                  text: alerts.length > 3
                    ? 'derived from what was just sampled · ' + (alerts.length - 3) + ' more below'
                    : 'derived from what was just sampled' }),
      h('span', { style: 'margin-left:auto;display:flex;gap:8px' }, [
        h('button', {
          type: 'button', class: 'btn btn-secondary', style: 'justify-content:flex-start',
          onclick: () => go('host'),
        }, ['Look at the host']),
      ]),
    ]),
    h('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:2px;'
           + 'margin-top:16px;background:color-mix(in srgb,var(--tx-on-accent) 28%,transparent)',
    }, alerts.slice(0, 3).map((alert) => h('div', {
      style: 'background:var(--color-accent);padding:12px 14px',
    }, [
      h('div', { style: 'font-family:var(--font-heading);font-weight:800;font-size:15px', text: alert.title }),
      h('div', { style: 'font-size:12px', text: alert.detail }),
    ]))),
  ]);
}

function windowPicker() {
  return h('div', { style: 'display:flex;align-items:center;gap:12px' }, [
    h('span', { class: 'text-muted',
                style: 'font-size:11px;letter-spacing:.08em;text-transform:uppercase', text: 'Window' }),
    h('div', { class: 'seg' }, ['90s', '15m', '1h', '24h'].map((label) =>
      h('label', { class: 'seg-opt' }, [
        h('input', {
          type: 'radio', name: 'tx-range', checked: state.window === label,
          onchange: () => setWindow(label),
        }),
        label,
      ]))),
  ]);
}

function renderOverview(data) {
  const host = data.host || {};
  const cpu = host.cpu || {};
  const memory = host.memory || {};
  const gpu = host.gpu || {};
  const battery = host.battery || {};
  const hottest = (host.thermals || [])[0];
  const storage = (host.storage || [])[0];
  const nodes = data.nodes || [];
  const services = data.services || [];
  const best = services.map((s) => (s.metrics || {}).tokens_per_second
                                || (s.metrics || {}).average_tps || 0);
  const fastest = Math.max.apply(null, best.concat([0]));
  const out = [poster(data)];

  out.push(h('div', {
    'data-tx-pad': 'true',
    style: 'display:flex;align-items:flex-end;justify-content:space-between;gap:24px;'
         + 'flex-wrap:wrap;padding:24px 24px 16px;border-bottom:' + DIV,
  }, [
    h('div', {}, [
      h('h1', { style: 'margin:0;font-size:42px', text: 'Everything' }),
      h('div', { class: 'text-muted', style: 'font-size:13px',
                 text: 'One phone. ' + nodes.length + (nodes.length === 1 ? ' machine. ' : ' machines. ')
                     + services.length + ' services. Read every two seconds.' }),
    ]),
    windowPicker(),
  ]));

  out.push(h('div', {
    'data-tx-strip': 'true',
    style: 'display:grid;grid-template-columns:minmax(0,1fr) 232px;border-bottom:' + DIV,
  }, [
    h('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:2px;'
           + 'background:var(--color-divider);border-right:' + DIV,
    }, [
      stat('Processor', num(cpu.total), '%',
           (cpu.count || 0) + ' cores · ' + (cpu.governor || 'unknown'), 'blue'),
      stat('Memory', num(memory.percent), '%',
           bytes(memory.used) + ' of ' + bytes(memory.total), 'violet'),
      hottest ? stat('Hottest zone', hottest.celsius.toFixed(1), '°C', hottest.zone, 'red') : null,
      battery.available
        ? stat('Battery', num(battery.percentage), '%',
               [(battery.status || '').toLowerCase().replace(/_/g, ' '),
                battery.celsius ? battery.celsius.toFixed(1) + ' °C' : null]
                 .filter(Boolean).join(' · '), 'green')
        : null,
      stat('Generating', fastest ? num(fastest, 1) : '--', fastest ? ' tok/s' : '',
           fastest ? 'fastest model server' : 'no requests yet', 'teal'),
      storage ? stat('Storage', bytes(storage.free).split(' ')[0],
                     ' ' + bytes(storage.free).split(' ')[1],
                     'free of ' + bytes(storage.total)) : null,
    ].filter(Boolean)),
    deviceFigure(host),
  ]));

  const cpuValues = readingFor('cpu');
  const memValues = readingFor('memory');
  const gpuValues = readingFor('gpu');
  const tempValues = readingFor('temp');

  out.push(h('section', { style: 'padding:24px;border-bottom:' + DIV }, [
    h('div', {
      'data-tx-charts': 'true',
      style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:32px',
    }, [
      figure('Processor load',
             readout(pct(latest(cpuValues), 1), 'now · ' + pct(peak(cpuValues), 1) + ' peak'),
             cpuValues, { hue: 'blue', max: 100, threshold: 85,
                          label: 'processor load', note: 'alert above 85%' }),
      figure('Memory in use',
             readout(pct(latest(memValues), 1), 'now · ' + pct(peak(memValues), 1) + ' peak'),
             memValues, { hue: 'violet', max: 100, threshold: 90,
                          label: 'memory in use', note: bytes(memory.available) + ' free' }),
      gpu.available
        ? figure('Graphics · ' + (gpu.model || 'GPU'),
                 readout(pct(latest(gpuValues), 1), 'now · ' + pct(peak(gpuValues), 1) + ' peak'),
                 gpuValues, { hue: 'teal', max: 100, label: 'graphics load',
                              note: 'clock held at ' + (gpu.clock_mhz || '--') + ' of '
                                  + (gpu.max_clock_mhz || '--') + ' MHz' })
        : null,
      (host.thermals || []).length
        ? figure('Hottest thermal zone',
                 readout(num(latest(tempValues), 1) + ' °C',
                         'now · ' + (host.thermals || []).length + ' zones'),
                 tempValues, { hue: 'red', label: 'hottest thermal zone',
                               note: 'the driver throttles hard above 55' })
        : null,
    ].filter(Boolean)),
  ]));

  out.push(h('section', { style: 'border-bottom:' + DIV }, [
    h('div', { style: 'padding:20px 24px 14px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap' }, [
      h('h3', { style: 'margin:0', text: 'Machines and services' }),
      h('span', { class: 'text-muted', style: 'font-size:12px',
                  text: 'Every control is one click. Nothing here is behind a menu.' }),
    ]),
    h('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:2px;'
           + 'background:var(--color-divider);border-top:' + DIV,
    }, nodes.map(nodeCard).concat(services.map(serviceCard))),
  ]));

  out.push(wiringSection(data));
  out.push(pathsSection(data));
  return out;
}

/* The architecture, drawn from what is actually configured rather than from a
   diagram that can drift: the ports come from the services, the guest row only
   appears when a machine forwards ssh. */
function wiringSection(data) {
  const host = data.host || {};
  const gpu = host.gpu || {};
  const rows = [];
  rows.push(['/proc + /sys', 'the phone'
    + (gpu.available ? ', incl. ' + (gpu.model || 'the GPU') : '')]);
  if ((data.nodes || []).length) rows.push(['/proc/<pid>', 'each qemu process']);
  (data.services || []).forEach((service) => {
    const port = (service.endpoint || '').split(':').pop();
    rows.push([':' + port + (service.id === 'dns' ? ' /control' : ' /metrics'), service.name]);
  });
  const sshPort = ((data.nodes || [])[0] || {}).ports &&
    ((data.nodes || [])[0].ports.find((p) => p.guest_port === 22) || {}).host_port;
  if (sshPort) rows.push(['ssh 127.0.0.1:' + sshPort, 'inside each guest']);

  return h('section', { style: 'padding:24px;border-bottom:' + DIV }, [
    sectionHead('What talks to what',
                'Stdlib only on both ends. Nothing installed inside the guests.'),
    h('div', { style: 'display:flex;flex-direction:column;gap:2px;background:var(--color-divider)' }, [
      h('div', { style: 'background:var(--color-bg);padding:12px 14px' }, [
        h('div', { style: 'font-family:var(--font-heading);font-weight:800;font-size:15px', text: 'browser' }),
        h('div', { class: 'text-muted', style: 'font-size:11.5px', text: 'anywhere on the LAN' }),
      ]),
      h('div', { style: 'background:var(--color-bg);padding:12px 14px' }, [
        h('div', { style: 'font-family:var(--font-heading);font-weight:800;font-size:15px',
                   text: (((host.identity || {}).address) || 'phone') + ':8080' }),
        h('div', { style: 'font-size:13px', text: 'termox' }),
        h('div', { class: 'text-muted', style: 'font-size:11.5px', text: 'Termux, native, stdlib only' }),
      ]),
      h('div', { style: 'background:var(--color-bg);padding:12px 14px 14px 34px' }, [
        dl(rows.map(([k, v]) => [k, v])),
      ]),
    ]),
  ]);
}

/* The design puts the device itself beside the readings. The photo is a
   Wikimedia Commons render under CC BY 4.0, which is why the credit is in the
   caption rather than buried in a comment. */
function deviceFigure(host) {
  const id = host.identity || {};
  return h('figure', { style: 'margin:0;padding:16px 18px' }, [
    h('div', {
      class: 'grayscale',
      style: 'width:100%;height:196px;display:grid;place-items:center;overflow:hidden;'
           + 'background:var(--color-surface)',
    }, [
      h('img', { src: 'phone.png', alt: id.device || 'the phone', width: 74, height: 168,
                 style: 'height:168px;width:auto;display:block' }),
    ]),
    h('figcaption', { style: 'margin-top:6px' }, [
      [id.device, id.soc, 'running everything natively'].filter(Boolean).join(' · '),
      h('br'),
      h('a', {
        href: 'https://commons.wikimedia.org/wiki/File:Galaxy_S20_(cropped).png',
        target: '_blank', rel: 'noreferrer', text: 'Photo: GadgetsGuy, CC BY 4.0',
      }),
    ]),
  ]);
}

function nodeCard(node) {
  const runtime = node.runtime || {};
  const spec = node.spec || {};
  const running = node.state === 'running';
  return h('article', {
    style: 'background:var(--color-bg);padding:18px 20px 20px;display:flex;'
         + 'flex-direction:column;gap:14px;min-width:0',
  }, [
    h('div', { style: 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap' }, [
      h('button', {
        type: 'button',
        style: 'background:transparent;border:0;padding:0;cursor:pointer;font:inherit;color:inherit;'
             + 'font-family:var(--font-heading);font-weight:800;font-size:20px;text-align:left',
        onclick: () => go('node:' + node.key),
      }, [node.name]),
      stateTag(node.state, transitional(node.state) ? 'busy' : running ? 'up' : 'down'),
      h('span', { class: 'text-muted', style: 'font-size:12px;margin-left:auto',
                  text: 'virtual machine' }),
    ]),
    h('div', { class: 'text-muted', style: 'font-size:12.5px',
               text: running
                 ? 'Emulated aarch64 under TCG. ' + pct(runtime.cpu_percent) + ' of one phone core.'
                 : 'Remembered but not running. ' + (spec.cores || '?') + ' cores, '
                   + bytes((spec.memory_mb || 0) * 1024 * 1024) + ' when it is up.' }),
    running ? dl([
      ['Processor', pct(runtime.cpu_percent)],
      ['Resident', bytes(runtime.rss)],
      ['Uptime', duration(runtime.uptime)],
    ]) : null,
    h('div', { style: 'display:flex;gap:8px;margin-top:auto' },
      actions(node.key, node.state, node.job, node.name)),
  ]);
}

function serviceCard(service) {
  const runtime = service.runtime || {};
  const metrics = service.metrics || {};
  const running = service.state === 'running';
  const rate = metrics.tokens_per_second || metrics.average_tps;
  return h('article', {
    style: 'background:var(--color-bg);padding:18px 20px 20px;display:flex;'
         + 'flex-direction:column;gap:14px;min-width:0',
  }, [
    h('div', { style: 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap' }, [
      h('button', {
        type: 'button',
        style: 'background:transparent;border:0;padding:0;cursor:pointer;font:inherit;color:inherit;'
             + 'font-family:var(--font-heading);font-weight:800;font-size:20px;text-align:left',
        onclick: () => go('svc:' + service.id),
      }, [service.name]),
      stateTag(service.state, transitional(service.state) ? 'busy' : running ? 'up' : 'down'),
      h('span', { class: 'text-muted', style: 'font-size:12px;margin-left:auto',
                  text: service.kind || '' }),
    ]),
    service.id === 'dns'
      ? dl([
          ['Resolver', service.dns_open ? 'answering on ' + service.dns_port : 'not answering'],
          ['Resident', bytes(runtime.rss)],
          ['Uptime', duration(runtime.uptime)],
        ])
      : service.id === 'autoclaim'
      ? dl([
          ['Claimed today', claimSummary(service)],
          ['This month', monthSummary(service)],
          ['Compensation', compensationSummary(service)],
          ['Day', (service.claim_day || '--')
                  + (service.claim_timezone ? ' · ' + service.claim_timezone : '')],
        ])
      : dl([
          ['Generation', rate ? num(rate, 1) + ' tok/s' : 'no requests yet'],
          ['Served', num(metrics.tokens_total) + ' tokens'],
          ['Resident', bytes(runtime.rss)],
        ]),
    h('div', { style: 'display:flex;gap:8px;margin-top:auto;flex-wrap:wrap' },
      actions('svc:' + service.id, service.state, service.job, service.name)
        .concat(service.id === 'autoclaim' && running ? [openAutoclaim('Open')] : [])),
  ]);
}

function claimTrouble(service) {
  const o = (service.claim_profiles || {}).outcomes || {};
  return Object.keys(o)
    .filter((k) => k !== 'claimed' && k !== 'already')
    .reduce((n, k) => n + o[k], 0);
}


function claimTroubleNote(service) {
  const o = (service.claim_profiles || {}).outcomes || {};
  const bad = Object.keys(o).filter((k) => k !== 'claimed' && k !== 'already');
  if (!bad.length) return 'every profile settled';
  return bad.map((k) => o[k] + ' ' + k).join(' · ');
}


// The dashboard proxies AutoClaim at this path (see _proxy_autoclaim in
// server.py). It is a same-origin link on purpose: the app's own address is
// loopback-only on the phone, so a direct link would resolve to whatever
// machine the browser is running on and fail.
const AUTOCLAIM_PATH = '/autoclaim/';

function openAutoclaim(label, kind) {
  return h('a', {
    class: 'btn btn-' + (kind || 'secondary'),
    style: 'justify-content:flex-start',
    href: AUTOCLAIM_PATH, target: '_blank', rel: 'noreferrer',
    text: label || 'Open',
  });
}

function compensationPending(service) {
  return (((service.claim_rewards || {}).compensation) || {}).pending || 0;
}

/**
 * Downtime compensation is a fixed award that expires, so an unclaimed one is
 * a deadline rather than a status. AutoClaim takes it on the next tick, which
 * means seeing one here usually just means the tick has not come round yet -
 * unless the session is dead, and the alert covers that.
 */
function compensationSummary(service) {
  const c = ((service.claim_rewards || {}).compensation) || {};
  if (!c.pending) {
    return c.date ? 'nothing waiting · last offer ' + c.date : 'nothing waiting';
  }
  return [c.pending + (c.pending === 1 ? ' account' : ' accounts'),
          c.amount ? num(c.amount) + ' pts each' : null,
          c.expires ? 'expires ' + c.expires : null].filter(Boolean).join(' · ');
}

function compensationHeadline(service) {
  const c = ((service.claim_rewards || {}).compensation) || {};
  return c.pending ? String(c.pending) : 'none';
}

function compensationNote(service) {
  const c = ((service.claim_rewards || {}).compensation) || {};
  if (!c.pending) return c.date ? 'last offer ' + c.date : 'nothing on offer';
  return (c.amount ? num(c.amount) + ' pts each' : 'waiting')
       + (c.expires ? ' · expires ' + c.expires : '');
}

/**
 * The month is context, not a button: the whole-month bonus is granted by the
 * daily claim that completes the month, so there is nothing to press. The
 * weakest account is the one shown, because it is the one that will miss it.
 */
function monthRows(service) {
  return ((service.claim_rewards || {}).profiles || [])
    .filter((p) => p.claimed !== null && p.claimed !== undefined);
}

function monthSummary(service) {
  const rows = monthRows(service);
  const total = (service.claim_rewards || {}).days_in_month;
  if (!rows.length) return 'not read yet';
  return rows.map((p) => p.name + ' ' + p.claimed + (total ? '/' + total : '')
                         + (p.streak ? ' · ' + p.streak + 'd streak' : '')
                         + (p.bonus ? ' · bonus in' : ''))
             .join(' · ');
}

function monthHeadline(service) {
  const rows = monthRows(service);
  if (!rows.length) return '--';
  return String(Math.min.apply(null, rows.map((p) => p.claimed)));
}

function monthHeadlineUnit(service) {
  const total = (service.claim_rewards || {}).days_in_month;
  return total ? ' of ' + total : '';
}

function monthNote(service) {
  const rows = monthRows(service);
  if (!rows.length) return 'the month has not been read yet';
  const done = rows.filter((p) => p.bonus).length;
  const streak = Math.min.apply(null, rows.map((p) => p.streak || 0));
  if (done === rows.length) return 'month bonus claimed';
  return streak + (streak === 1 ? ' day streak' : ' day streak')
       + ' · bonus at ' + ((service.claim_rewards || {}).days_in_month || '--') + ' days';
}

function claimSummary(service) {
  // "1 of 3" is the honest headline. An account whose game is not linked is
  // finished for the day but has earned nothing, so counting "done" would show
  // 3 of 3 while two of them quietly collect nothing.
  const c = service.claim_profiles || {};
  if (!c.auto) return 'no profiles set to auto-claim';
  const parts = [c.settled + ' of ' + c.auto];
  const trouble = Object.keys(c.outcomes || {})
    .filter((k) => k !== 'claimed' && k !== 'already')
    .map((k) => c.outcomes[k] + ' ' + k);
  if (trouble.length) parts.push(trouble.join(', '));
  return parts.join(' · ');
}


function pathsSection(data) {
  const rows = data.paths || [];
  if (!rows.length) return null;
  return h('section', { style: 'padding:24px 24px 40px' }, [
    sectionHead('Where things run',
                'Binaries and working directories, read from /proc rather than inferred '
              + 'from the launchers.'),
    h('div', { 'data-tx-bleed': 'true', style: 'overflow-x:auto;margin:0 -24px;padding:0 24px' }, [
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'App' }), h('th', { text: 'Kind' }),
          h('th', { text: 'Binary' }), h('th', { text: 'Directory' }), h('th', { text: 'Data' }),
        ])]),
        h('tbody', {}, rows.map((row) => h('tr', {}, [
          h('td', {}, [
            h('span', { 'data-tx-dot': row.state === 'running' ? 'up' : 'down',
                        style: 'margin-right:8px' }),
            row.name,
          ]),
          h('td', { class: 'text-muted', text: row.kind || '--' }),
          h('td', { style: 'font-family:ui-monospace,monospace;font-size:12px',
                    text: row.binary || 'not running' }),
          h('td', { style: 'font-family:ui-monospace,monospace;font-size:12px',
                    text: row.directory || '--' }),
          h('td', { style: 'font-family:ui-monospace,monospace;font-size:12px',
                    text: row.detail || '--' }),
        ]))),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------------ host */

function backButton() {
  return h('button', {
    type: 'button', class: 'btn btn-secondary', style: 'justify-content:flex-start',
    onclick: () => go('overview'),
  }, ['Back to everything']);
}

function screenHead(title, note, right) {
  return h('div', {
    'data-tx-pad': 'true',
    style: 'display:flex;align-items:flex-end;justify-content:space-between;gap:24px;'
         + 'flex-wrap:wrap;padding:24px 24px 16px;border-bottom:' + DIV,
  }, [
    h('div', { style: 'min-width:0' }, [
      h('h1', { style: 'margin:0;font-size:42px', text: title }),
      note ? h('div', { class: 'text-muted', style: 'font-size:13px', text: note }) : null,
    ]),
    right || backButton(),
  ]);
}

function renderHost(data) {
  const host = data.host || {};
  const id = host.identity || {};
  const cpu = host.cpu || {};
  const gpu = host.gpu || {};
  const battery = host.battery || {};
  const limits = host.limits || {};
  const storage = host.storage || [];
  const byId = {};
  (cpu.cores || []).forEach((core) => { byId[core.id] = core; });

  const out = [screenHead(id.device || 'This phone',
    'The machine everything else runs on. '
    + [id.android ? 'Android ' + id.android : null, 'no root, no container']
        .filter(Boolean).join(', ') + '.')];

  out.push(h('section', { style: 'padding:24px;border-bottom:' + DIV }, [
    sectionHead('Cores', limits.cpu_source === 'cpuidle'
      ? 'Measured from per-core idle residency in sysfs. This device denies /proc/stat '
        + 'to apps, so utilisation is derived from how long each core stayed idle.'
      : 'Read from /proc/stat.'),
    h('div', {}, (cpu.clusters || []).map((cluster) => h('div', { style: 'margin-bottom:22px' }, [
      h('h6', { style: 'margin:0 0 10px',
                text: cluster.label + (cluster.max_mhz
                  ? ' · ' + (cluster.max_mhz / 1000).toFixed(2) + ' GHz' : '') }),
      h('div', {
        style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px',
      }, cluster.cores.map((coreId) => {
        const core = byId[coreId] || { id: coreId };
        const hot = (core.percent || 0) >= 99;
        return h('div', {}, [
          h('div', {
            style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;'
                 + 'font-variant-numeric:tabular-nums',
          }, [
            h('span', { text: 'cpu' + coreId }),
            h('span', { style: hot ? 'color:var(--color-accent)' : '', text: pct(core.percent) }),
          ]),
          bar(core.percent, hot ? 'accent' : 'blue'),
          h('div', { class: 'text-muted', style: 'font-size:11px;margin-top:4px',
                     text: core.mhz ? 'running ' + core.mhz + ' MHz' : 'frequency unreadable' }),
        ]);
      })),
    ]))),
  ]));

  out.push(h('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:2px;'
         + 'background:var(--color-divider);border-bottom:' + DIV,
  }, [
    h('section', { style: 'background:var(--color-bg);padding:24px' }, [
      h('h3', { style: 'margin:0 0 16px', text: 'Sensors' }),
      (host.thermals || []).length
        ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px' },
            (host.thermals || []).map((zone) => h('span', {
              class: 'tag tag-neutral', text: zone.zone + ' ' + zone.celsius.toFixed(1) + ' °C',
            })))
        : h('div', { class: 'text-muted', style: 'font-size:12.5px;margin-bottom:18px',
                     text: 'no readable thermal zones' }),
      dl([
        ['Battery', battery.available
          ? [battery.percentage + '%', (battery.status || '').toLowerCase().replace(/_/g, ' '),
             (battery.health || '').toLowerCase(),
             battery.celsius ? battery.celsius.toFixed(1) + ' °C' : null]
              .filter(Boolean).join(' · ')
          : battery.reason || 'unavailable'],
      ]),
    ]),
    h('section', { style: 'background:var(--color-bg);padding:24px' }, [
      h('h3', { style: 'margin:0 0 16px', text: 'Storage and graphics' }),
      h('div', { style: 'margin-bottom:18px' }, storage.map((volume) => h('div', {
        style: 'margin-bottom:12px',
      }, [
        h('div', {
          style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;'
               + 'font-variant-numeric:tabular-nums',
        }, [
          h('span', { text: volume.label }),
          h('span', { text: bytes(volume.free) + ' free of ' + bytes(volume.total) }),
        ]),
        bar(volume.percent),
      ]))),
      gpu.available
        ? dl([
            [gpu.model || 'GPU', pct(gpu.percent) + ' busy'],
            ['Clock', (gpu.clock_mhz || '--') + ' of ' + (gpu.max_clock_mhz || '--')
                    + ' MHz · ' + pct(gpu.clock_percent)],
            ['Ceiling', 'the driver holds it down; raising it needs root'],
          ])
        : h('div', { class: 'text-muted', style: 'font-size:12.5px', text: gpu.reason || 'no GPU readings' }),
    ]),
    h('section', { style: 'background:var(--color-bg);padding:24px' }, [
      h('h3', { style: 'margin:0 0 16px', text: 'Device' }),
      dl([
        ['Model', id.device || 'unknown'],
        id.soc ? ['Chipset', id.soc] : null,
        id.android ? ['Android', id.android + (id.sdk ? ' (API ' + id.sdk + ')' : '')] : null,
        ['Kernel', id.kernel],
        ['Architecture', id.arch],
        ['Address', id.address || 'unknown'],
      ]),
    ]),
  ]));

  const missing = [
    limits.load ? ['Load average', limits.load] : null,
    limits.network ? ['Network throughput', limits.network] : null,
    !gpu.available && gpu.reason ? ['Graphics', gpu.reason] : null,
    !battery.available && battery.reason ? ['Battery', battery.reason] : null,
  ].filter(Boolean);
  if (missing.length) {
    out.push(h('section', { style: 'padding:24px 24px 40px' }, [
      sectionHead('What this device will not tell us',
                  'Every one of these is a policy denial, not a bug. Where there is no way '
                + 'through, the panel says so rather than showing a zero.'),
      dl(missing),
      h('div', { style: 'margin-top:20px' }, [backButton()]),
    ]));
  } else {
    out.push(h('section', { style: 'padding:24px 24px 40px' }, [backButton()]));
  }
  return out;
}

/* --------------------------------------------------------------- service */

function launcherPanel(target) {
  const log = state.logs[target];
  if (log === undefined) {
    fetch('/api/launchlog?target=' + encodeURIComponent(target),
          { headers: TOKEN ? { 'X-Termox-Token': TOKEN } : {} })
      .then((r) => r.json())
      .then((data) => { state.logs[target] = data; render(); })
      .catch(() => { state.logs[target] = { ok: false, reason: 'could not be read' }; });
    state.logs[target] = null;
  }
  return h('section', { style: 'background:var(--color-bg);padding:24px' }, [
    h('div', { style: 'display:flex;align-items:baseline;gap:12px;margin-bottom:14px' }, [
      h('h3', { style: 'margin:0', text: 'Launcher output' }),
      h('span', { class: 'text-muted', style: 'font-size:12px',
                  text: log && log.session ? log.session + ' · last start' : 'last start' }),
    ]),
    log === null
      ? h('div', { class: 'text-muted', style: 'font-size:12.5px', text: 'reading…' })
      : log && log.ok
        ? h('pre', { class: 'tx-log', text: log.lines.join('\n') })
        : h('div', { class: 'text-muted', style: 'font-size:12.5px',
                     text: (log && log.reason) || 'nothing recorded' }),
    h('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [
      h('button', {
        type: 'button', class: 'btn btn-secondary', style: 'justify-content:flex-start',
        onclick: () => { delete state.logs[target]; render(); },
      }, ['Refresh']),
    ]),
  ]);
}

/* One real request against the model server, so the panel can show what it
   measured rather than describing what it would measure. */
async function send(service) {
  const prompt = state.draft.trim();
  if (!prompt || state.sending) return;
  const base = (service.endpoint || '').replace('127.0.0.1', location.hostname);
  state.sending = true;
  state.chat.push({ who: 'you', text: prompt, meta: '' });
  state.draft = '';
  render();
  const started = Date.now();
  try {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: service.served_model || 'local',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 160,
      }),
    });
    const data = await response.json();
    const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const usage = data.usage || {};
    const seconds = (Date.now() - started) / 1000;
    state.chat.push({
      who: service.name,
      text: message.content || '(the model returned nothing; it may have spent the budget thinking)',
      meta: [usage.completion_tokens ? usage.completion_tokens + ' tokens' : null,
             seconds.toFixed(1) + 's',
             usage.completion_tokens ? (usage.completion_tokens / seconds).toFixed(1) + ' tok/s' : null]
              .filter(Boolean).join(' · '),
    });
  } catch (err) {
    state.chat.push({ who: 'error', text: String(err.message || err), meta: '' });
  } finally {
    state.sending = false;
    render();
  }
}

function tryItPanel(service) {
  return h('section', { style: 'background:var(--color-bg);padding:24px' }, [
    sectionHead('Try it', 'Sends one request to /v1/chat/completions and shows what it measured.'),
    h('div', { style: 'display:flex;flex-direction:column;gap:12px;margin-bottom:16px' },
      state.chat.length
        ? state.chat.map((m) => h('div', { style: 'max-width:60ch' }, [
            h('div', { class: 'text-muted',
                       style: 'font-size:11px;letter-spacing:.08em;text-transform:uppercase',
                       text: m.who }),
            h('div', { style: 'font-size:13.5px;line-height:1.5;white-space:pre-wrap', text: m.text }),
            m.meta ? h('div', { class: 'text-muted', style: 'font-size:11px;margin-top:3px', text: m.meta }) : null,
          ]))
        : [h('div', { class: 'text-muted', style: 'font-size:13px',
                      text: 'Nothing sent yet. The first request loads nothing extra, '
                          + 'the weights are already resident.' })]),
    h('div', { style: 'display:flex;gap:8px;align-items:flex-end' }, [
      h('div', { class: 'field', style: 'flex:1;min-width:0' }, [
        h('label', { text: 'Prompt' }),
        h('input', {
          class: 'input', type: 'text', value: state.draft, placeholder: 'Name three colours',
          oninput: (e) => { state.draft = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') send(service); },
        }),
      ]),
      h('button', {
        type: 'button', class: 'btn btn-primary', style: 'justify-content:flex-start',
        disabled: state.sending, onclick: () => send(service),
      }, [state.sending ? h('span', { class: 'tx-spin' }) : null, state.sending ? 'Sending' : 'Send']),
    ]),
  ]);
}

function renderService(data, service) {
  const runtime = service.runtime || {};
  const metrics = service.metrics || {};
  const gpu = (data.host || {}).gpu || {};
  const address = ((data.host || {}).identity || {}).address || location.hostname;
  const target = 'svc:' + service.id;
  const running = service.state === 'running';
  const isDns = service.id === 'dns';
  const isClaim = service.id === 'autoclaim';
  // Only the model servers get the llama.cpp treatment: throughput tiles,
  // generation-rate charts, /metrics endpoints. The other two have none of it.
  const isModel = !isDns && !isClaim;
  const out = [];

  out.push(h('div', {
    'data-tx-pad': 'true',
    style: 'display:flex;align-items:flex-end;justify-content:space-between;gap:24px;'
         + 'flex-wrap:wrap;padding:24px 24px 16px;border-bottom:' + DIV,
  }, [
    h('div', { style: 'min-width:0' }, [
      h('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' }, [
        h('h1', { style: 'margin:0;font-size:42px', text: service.name }),
        stateTag(service.state, transitional(service.state) ? 'busy' : running ? 'up' : 'down'),
      ]),
      h('div', { class: 'text-muted', style: 'font-size:13px',
                 text: isDns
                   ? 'AdGuard Home, built for this phone and running natively. '
                     + 'Port 53 needs root, so it answers on ' + (service.dns_port || 5300) + '.'
                   : isClaim
                   ? 'Claims the daily attendance points on xm100.vn, and downtime '
                     + 'compensation when the server offers it. Bound to loopback on '
                     + 'purpose: it holds live session cookies. Open it with the button '
                     + 'below, which goes through this panel rather than the open port.'
                   : (service.kind || '') + '. '
                     + (service.model ? service.model.split('/').pop() : 'no model loaded')
                     + (service.context ? ', ' + num(service.context) + ' tokens of context' : '') }),
    ]),
    h('div', { style: 'display:flex;gap:8px' },
      actions(target, service.state, service.job, service.name)),
  ]));

  const strip = activity(service.job, service.state);
  if (strip) out.push(strip);

  out.push(h('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:2px;'
         + 'background:var(--color-divider);border-bottom:' + DIV,
  }, isDns ? [
    tile('Resolver', service.dns_open ? 'up' : 'down', '', 'port ' + (service.dns_port || '--')),
    tile('Processor', num(runtime.cpu_percent), '%', 'of one phone core'),
    tile('Resident', bytes(runtime.rss), '', (runtime.threads || '--') + ' threads'),
    tile('Uptime', duration(runtime.uptime), '', 'pid ' + (runtime.pid || '--')),
  ] : isClaim ? [
    tile('Claimed today', String((service.claim_profiles || {}).settled ?? '--'),
         ' of ' + ((service.claim_profiles || {}).auto ?? '--'), 'profiles set to auto-claim'),
    tile('Needs a look', String(claimTrouble(service)), '',
         claimTroubleNote(service)),
    tile('This month', monthHeadline(service), monthHeadlineUnit(service),
         monthNote(service)),
    tile('Compensation', compensationHeadline(service), '',
         compensationNote(service)),
    tile('Day', service.claim_day || '--', '', service.claim_timezone || ''),
    tile('Uptime', duration(runtime.uptime), '', 'scheduler ticks every 5 min'),
  ] : [
    tile('Generation', num(metrics.tokens_per_second || metrics.average_tps, 1), ' tok/s',
         metrics.tokens_per_second ? 'last request' : 'average since start'),
    tile('Prompt', num(metrics.prompt_per_second || metrics.average_prompt_tps, 1), ' tok/s',
         metrics.prompt_cached ? num(metrics.prompt_cached) + ' tokens cached' : ''),
    tile('Served', num(metrics.tokens_total), '', 'tokens since start'),
    tile('Resident', bytes(runtime.rss), '',
         (runtime.threads || '--') + ' threads · pid ' + (runtime.pid || '--')),
    service.uses_gpu && gpu.available
      ? tile('Graphics', num(gpu.percent), '%', (gpu.clock_mhz || '--') + ' MHz')
      : null,
    tile('Uptime', duration(runtime.uptime), '',
         metrics.processing ? num(metrics.processing) + ' in flight' : 'idle'),
  ].filter(Boolean)));

  if (isModel) {
    const rate = serviceReading(service.id, 'rate');
    const proc = serviceReading(service.id, 'cpu');
    const gpuSeries = serviceReading(service.id, 'gpu');
    out.push(h('section', { style: 'padding:24px;border-bottom:' + DIV }, [
      h('div', {
        'data-tx-charts': 'true',
        style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:32px',
      }, [
        figure('Generation rate',
               readout(num(latest(rate), 1) + ' tok/s', 'peak ' + num(peak(rate), 1)),
               rate, { hue: 'green', label: 'generation rate',
                       note: "llama.cpp resets its per-second gauges on scrape, so this is the "
                           + "finished request's own rate" }),
        figure('Processor',
               readout(pct(latest(proc)), 'peak ' + pct(peak(proc))),
               proc, { hue: 'blue', label: 'processor use' }),
        service.uses_gpu
          ? figure('Graphics while this server works',
                   readout(pct(latest(gpuSeries)), 'peak ' + pct(peak(gpuSeries))),
                   gpuSeries, { hue: 'teal', max: 100, label: 'graphics load' })
          : null,
      ].filter(Boolean)),
    ]));
  }

  const endpointRows = isDns
    ? [['DNS server', h('span', { style: 'font-family:ui-monospace,monospace',
                                  text: address + ':' + (service.dns_port || '--') })],
       ['Admin', h('a', { href: (service.endpoint || '').replace('127.0.0.1', address),
                          target: '_blank', rel: 'noreferrer',
                          text: (service.endpoint || '').replace('127.0.0.1', address) })],
       ['Status', service.dns_open ? 'answering queries' : 'not answering']]
    : isClaim
    ? [['On the phone', h('span', { style: 'font-family:ui-monospace,monospace',
        text: service.endpoint || '' })],
       // That address is loopback-only, so it is shown rather than linked.
       // The way in from any other machine is this dashboard, which proxies it.
       ['Through this panel', h('a', { href: AUTOCLAIM_PATH, target: '_blank',
        rel: 'noreferrer', style: 'font-family:ui-monospace,monospace',
        text: location.origin + AUTOCLAIM_PATH })],
       ['Last tick', service.claim_last_tick
          ? new Date(service.claim_last_tick).toLocaleTimeString() : 'not yet'],
       ['Today', claimSummary(service)]]
    : [['OpenAI-compatible', h('span', { style: 'font-family:ui-monospace,monospace',
        text: (service.endpoint || '').replace('127.0.0.1', address) + '/v1' })],
       ['Native', h('span', { style: 'font-family:ui-monospace,monospace',
        text: (service.endpoint || '').replace('127.0.0.1', address) })],
       ['Model id', h('span', { style: 'font-family:ui-monospace,monospace',
        text: service.served_model || '(unknown)' })],
       runtime.cores ? ['Cores', runtime.cores.join(', ') + ' · nice ' + (runtime.nice === null ? '--' : runtime.nice)] : null];

  out.push(h('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:2px;'
         + 'background:var(--color-divider);border-bottom:' + DIV,
  }, [
    h('section', { style: 'background:var(--color-bg);padding:24px' }, [
      h('h3', { style: 'margin:0 0 16px',
                text: isDns ? 'Resolver' : isClaim ? 'Reaching it' : 'Endpoints' }),
      isDns
        ? h('div', { style: 'margin-bottom:16px' }, [
            h('a', { class: 'btn btn-primary', style: 'justify-content:flex-start',
                     href: (service.endpoint || '').replace('127.0.0.1', address),
                     target: '_blank', rel: 'noreferrer', text: 'Open the AdGuard admin' }),
          ])
        : isClaim && running
        ? h('div', { style: 'margin-bottom:16px' }, [openAutoclaim('Open AutoClaim', 'primary')])
        : null,
      dl(endpointRows.filter(Boolean)),
      h('div', { class: 'text-muted', style: 'font-size:12px;margin-top:12px',
                 text: isDns
                   ? 'Query and block counts live behind the AdGuard login, so they are shown '
                     + 'in the admin rather than here.'
                   : isClaim
                   ? 'Still not published to the LAN: it binds to loopback and has no login of '
                     + 'its own, so anything that could reach the port would own the accounts. '
                     + 'This panel proxies it instead, which means whoever can open the dashboard '
                     + 'can also drive it.'
                   : 'No API key is checked. Point Page Assist or any OpenAI-compatible client '
                     + 'at the /v1 URL and keep it on the LAN.' }),
    ]),
    launcherPanel(target),
  ]));

  if (isModel && running) out.push(tryItPanel(service));

  out.push(h('section', { style: 'padding:24px 24px 40px' }, [backButton()]));
  return out;
}

/* --------------------------------------------------------------- machine */

function renderNode(data, node) {
  const runtime = node.runtime || {};
  const spec = node.spec || {};
  const guest = (data.guests || {})[node.key] || {};
  const running = node.state === 'running';
  const address = ((data.host || {}).identity || {}).address || location.hostname;
  const out = [];

  out.push(h('div', {
    'data-tx-pad': 'true',
    style: 'display:flex;align-items:flex-end;justify-content:space-between;gap:24px;'
         + 'flex-wrap:wrap;padding:24px 24px 16px;border-bottom:' + DIV,
  }, [
    h('div', { style: 'min-width:0' }, [
      h('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' }, [
        h('h1', { style: 'margin:0;font-size:42px', text: node.name }),
        stateTag(node.state, transitional(node.state) ? 'busy' : running ? 'up' : 'down'),
      ]),
      h('div', { class: 'text-muted', style: 'font-size:13px',
                 text: (spec.arch || 'unknown') + ' under '
                     + (spec.accel === 'tcg' ? 'full emulation' : spec.accel)
                     + '. ' + (spec.cores || '?') + ' cores, '
                     + bytes((spec.memory_mb || 0) * 1024 * 1024) + '.'
                     + (running ? '' : ' Remembered but not running.') }),
    ]),
    h('div', { style: 'display:flex;gap:8px' },
      actions(node.key, node.state, node.job, node.name)),
  ]));

  const strip = activity(node.job, node.state);
  if (strip) out.push(strip);

  out.push(h('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:2px;'
         + 'background:var(--color-divider);border-bottom:' + DIV,
  }, [
    tile('Emulator load', num(runtime.cpu_percent), '%', 'of one phone core'),
    tile('Guest processor', guest.ok && guest.cpu ? num(guest.cpu.total) : '--', '%',
         (spec.cores || '?') + ' virtual cores'),
    tile('Guest memory', guest.ok && guest.memory ? num(guest.memory.percent) : '--', '%',
         guest.ok && guest.memory
           ? bytes(guest.memory.used) + ' of ' + bytes(guest.memory.total) : ''),
    tile('Resident', bytes(runtime.rss), '', (runtime.threads || '--') + ' threads'),
    tile('Uptime', duration(runtime.uptime), '',
         node.boots ? node.boots + ' boots seen' : ''),
  ]));

  out.push(h('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:2px;'
         + 'background:var(--color-divider);border-bottom:' + DIV,
  }, [
    h('section', { style: 'background:var(--color-bg);padding:24px' }, [
      h('h3', { style: 'margin:0 0 16px', text: 'Machine' }),
      dl([
        ['Architecture', spec.arch || 'unknown'],
        ['Machine type', spec.machine || 'default'],
        ['Processor model', spec.cpu || 'default'],
        ['Acceleration', spec.accel === 'tcg' ? 'tcg · full emulation' : (spec.accel || '--')],
        ['Console', spec.display || 'default'],
        spec.cwd ? ['Started in', h('span', { style: 'font-family:ui-monospace,monospace;font-size:12px', text: spec.cwd })] : null,
      ]),
    ]),
    h('section', { style: 'background:var(--color-bg);padding:24px' }, [
      h('h3', { style: 'margin:0 0 16px', text: 'Ports' }),
      (node.ports || []).length
        ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' }, (node.ports || []).map((port) =>
            h('span', {
              class: 'tag ' + (port.open ? 'tag-accent' : 'tag-neutral'),
              text: port.proto + ' ' + port.host_port + ' → ' + port.guest_port
                  + (port.label ? ' · ' + port.label : '')
                  + (port.proto === 'tcp' ? (port.open ? ' · open' : ' · closed') : ''),
            })))
        : h('div', { class: 'text-muted', style: 'font-size:12.5px',
                     text: 'no forwards on the command line, so nothing on the phone reaches this guest' }),
      (spec.disks || []).length
        ? h('div', { style: 'margin-top:18px' }, (spec.disks || []).map((disk) => h('div', {
            style: 'margin-bottom:12px',
          }, [
            h('div', {
              style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px',
            }, [
              h('span', { text: disk.name }),
              h('span', { style: 'font-variant-numeric:tabular-nums',
                          text: bytes(disk.allocated) + (disk.virtual ? ' of ' + bytes(disk.virtual) : '') }),
            ]),
            bar(disk.virtual ? disk.allocated / disk.virtual * 100 : 0, 'violet'),
          ])))
        : null,
    ]),
  ]));

  if (guest.ok) {
    out.push(h('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:2px;'
           + 'background:var(--color-divider);border-bottom:' + DIV,
    }, [
      h('section', { style: 'background:var(--color-bg);padding:24px' }, [
        h('h3', { style: 'margin:0 0 16px', text: 'Inside the guest' }),
        dl([
          ['Hostname', guest.hostname || '--'],
          ['System', guest.os || '--'],
          ['Kernel', guest.kernel || '--'],
          ['Uptime', duration(guest.uptime)],
          ['Load', guest.load ? guest.load.map((v) => v.toFixed(2)).join(' · ') : '--'],
        ]),
        h('div', { style: 'margin-top:16px' }, (guest.filesystems || []).map((fs) => h('div', {
          style: 'margin-bottom:12px',
        }, [
          h('div', { style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px' }, [
            h('span', { text: fs.mount }),
            h('span', { style: 'font-variant-numeric:tabular-nums', text: bytes(fs.free) + ' free' }),
          ]),
          bar(fs.percent, 'teal'),
        ]))),
      ]),
      h('section', { style: 'background:var(--color-bg);padding:24px' }, [
        h('div', { style: 'display:flex;align-items:baseline;gap:12px;margin-bottom:16px' }, [
          h('h3', { style: 'margin:0', text: 'Containers' }),
          h('span', { class: 'text-muted', style: 'font-size:12px',
                      text: (guest.docker || {}).age >= 0
                        ? 'read ' + ago((guest.docker || {}).age) + ' · refreshed every '
                          + Math.round(((guest.docker || {}).refresh || 0)) + 's'
                        : 'first reading on the way' }),
        ]),
        ((guest.docker || {}).containers || []).length
          ? h('div', { 'data-tx-bleed': 'true', style: 'overflow-x:auto;margin:0 -24px;padding:0 24px' }, [
              h('table', { class: 'table', style: 'font-size:13px' }, [
                h('thead', {}, [h('tr', {}, [
                  h('th', { text: 'Name' }), h('th', { text: 'Image' }), h('th', { text: 'State' }),
                  h('th', { style: 'text-align:right', text: 'Processor' }),
                  h('th', { style: 'text-align:right', text: 'Memory' }),
                ])]),
                h('tbody', {}, (guest.docker.containers || []).map((c) => h('tr', {}, [
                  h('td', { text: c.name }),
                  h('td', { class: 'text-muted', text: c.image }),
                  h('td', {}, [h('span', {
                    class: 'tag ' + (c.state === 'running' ? 'tag-accent' : 'tag-neutral'),
                    text: c.state,
                  })]),
                  h('td', { style: 'text-align:right;font-variant-numeric:tabular-nums',
                            text: c.cpu_percent === null ? '--' : pct(c.cpu_percent, 1) }),
                  h('td', { style: 'text-align:right;font-variant-numeric:tabular-nums',
                            text: c.mem_used === null ? '--' : bytes(c.mem_used) }),
                ]))),
              ]),
            ])
          : h('div', { class: 'text-muted', style: 'font-size:12.5px',
                       text: (guest.docker || {}).installed
                         ? 'docker is installed; the first listing takes about twenty seconds under emulation'
                         : 'no containers' }),
      ]),
    ]));
  } else if (running) {
    out.push(h('section', { style: 'padding:24px;border-bottom:' + DIV }, [
      sectionHead('Inside the guest', guest.reason || 'not sampled yet'),
    ]));
  }

  out.push(h('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:2px;'
         + 'background:var(--color-divider);border-bottom:' + DIV,
  }, [
    h('section', { style: 'background:var(--color-bg);padding:24px' }, [
      h('h3', { style: 'margin:0 0 16px', text: 'Command line' }),
      h('pre', { class: 'tx-log', text: node.cmdline || '--' }),
      h('div', { class: 'text-muted', style: 'font-size:12px;margin-top:12px',
                 text: node.controllable
                   ? 'a monitor socket is exposed'
                   : 'no -qmp socket, so this machine cannot be driven from a console yet' }),
    ]),
    launcherPanel(node.key),
  ]));

  out.push(h('section', { style: 'padding:24px 24px 40px' }, [backButton()]));
  return out;
}

/* ---------------------------------------------------------------- access */

function renderAccess(data) {
  const control = data.control || {};
  const address = ((data.host || {}).identity || {}).address || location.hostname;
  const out = [];

  out.push(h('div', {
    'data-tx-poster': 'true', style: 'background:var(--color-accent);padding:32px 24px',
  }, [
    h('h1', { style: 'margin:0;font-size:42px',
              text: control.token_required
                ? 'The panel refuses control without a token'
                : 'Anyone on this network can stop your DNS' }),
    h('div', { style: 'font-size:14px;max-width:70ch;margin-top:8px',
               text: control.token_required
                 ? 'Control endpoints check X-Termox-Token. The model servers are still open, '
                   + 'because they answer to clients that cannot send a header.'
                 : 'The dashboard binds 0.0.0.0:8080 with no authentication, and so do both '
                   + 'model servers. Set a token and the control endpoints start refusing '
                   + 'anything that does not carry it.' }),
  ]));

  out.push(h('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:2px;'
         + 'background:var(--color-divider);border-bottom:' + DIV,
  }, [
    h('section', { style: 'background:var(--color-bg);padding:24px' }, [
      h('h3', { style: 'margin:0 0 12px', text: 'Set a token' }),
      h('div', { class: 'text-muted', style: 'font-size:13px;margin-bottom:14px',
                 text: 'The panel cannot write its own boot script, so this is the line to add. '
                     + 'It survives the force-stop that installing a Termux add-on causes.' }),
      h('pre', { class: 'tx-log',
                 text: 'tmux new-session -d -s scope \\\n'
                     + '  "cd ~/termox && TERMOX_TOKEN=' + suggestToken() + ' python3 -m termox"' }),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px' }, [
        h('button', {
          type: 'button', class: 'btn btn-secondary', style: 'justify-content:flex-start',
          onclick: () => { tokenSeed = null; render(); },
        }, ['Suggest another']),
      ]),
    ]),
    h('section', { style: 'background:var(--color-bg);padding:24px' }, [
      h('h3', { style: 'margin:0 0 12px', text: 'Then reach it like this' }),
      dl([
        ['Browser', h('span', { style: 'font-family:ui-monospace,monospace;font-size:12px',
          text: 'http://' + address + ':8080/?token=' + suggestToken() })],
        ['Header', h('span', { style: 'font-family:ui-monospace,monospace;font-size:12px',
          text: 'X-Termox-Token: ' + suggestToken() })],
        ['Model servers', 'still open, keep them on the LAN or behind Tailscale'],
        ['Now', control.token_required ? 'a token is required' : 'no token is required'],
      ]),
    ]),
  ]));

  out.push(h('section', { style: 'padding:24px 24px 40px' }, [backButton()]));
  return out;
}

let tokenSeed = null;
function suggestToken() {
  if (!tokenSeed) {
    const bytes16 = new Uint8Array(12);
    crypto.getRandomValues(bytes16);
    tokenSeed = Array.from(bytes16, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  }
  return tokenSeed;
}

/* ----------------------------------------------------------------- shell */

const root = document.getElementById('root');

function render() {
  const data = state.data;
  if (!data) {
    root.textContent = '';
    root.appendChild(h('div', {
      'data-tx-theme': state.theme,
      style: 'min-height:100vh;display:grid;place-items:center;background:var(--color-bg);'
           + 'color:var(--color-text);font-family:var(--font-body)',
    }, [h('span', { class: 'text-muted', text: 'reading the phone…' })]));
    return;
  }

  const services = data.services || [];
  const nodes = data.nodes || [];
  let body;
  if (state.view === 'host') body = renderHost(data);
  else if (state.view === 'access') body = renderAccess(data);
  else if (state.view.startsWith('svc:')) {
    const service = services.find((s) => 'svc:' + s.id === state.view);
    body = service ? renderService(data, service) : renderOverview(data);
  } else if (state.view.startsWith('node:')) {
    const key = state.view.slice(5);
    const node = nodes.find((n) => n.key === key);
    body = node ? renderNode(data, node) : renderOverview(data);
  } else body = renderOverview(data);

  const shell = h('div', {
    'data-tx-theme': state.theme,
    'data-tx-narrow': state.narrow ? 'true' : null,
    style: 'min-height:100vh;background:var(--color-bg);color:var(--color-text);'
         + 'font-family:var(--font-body);font-size:15px;line-height:1.55',
  }, [
    header(data),
    h('div', {
      'data-tx-shell': 'true',
      style: 'display:grid;grid-template-columns:262px minmax(0,1fr);align-items:start',
    }, [
      rail(data),
      h('main', { tabindex: '-1', style: 'min-width:0' }, body),
    ]),
  ]);

  root.textContent = '';
  root.appendChild(shell);
  root.appendChild(toastBox);
  document.body.style.background = state.theme === 'dark' ? '#201e1d' : '#f3f2f2';
  document.body.style.color = state.theme === 'dark' ? '#f8f4f4' : '#201e1d';
}

/* The design drives its narrow layout from a measured flag rather than a media
   query, so the same rules hold in an embedded frame and on a real phone. */
function measure() {
  const narrow = root.clientWidth < 900;
  if (narrow !== state.narrow) { state.narrow = narrow; render(); }
}

/* ------------------------------------------------------------------ poll */

async function poll() {
  try {
    const response = await fetch('/api/state', {
      headers: TOKEN ? { 'X-Termox-Token': TOKEN } : {},
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const fresh = await response.json();
    state.data = fresh;
    announceJobs(fresh.jobs);
    state.failures = 0;
    render();
  } catch (err) {
    state.failures += 1;
    if (state.failures === 2) toast('bad', 'Lost the panel', 'retrying every two seconds');
    if (state.data) render();
  }
}

state.narrow = root.clientWidth < 900;
new ResizeObserver(measure).observe(root);
render();
poll();
setInterval(poll, POLL_MS);
