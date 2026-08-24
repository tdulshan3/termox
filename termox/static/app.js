/* termox dashboard ----------------------------------------------------
   Polls /api/state and redraws. Charts are hand-built SVG: single-series
   sparklines carry no legend (the card title names them), the two-series
   network chart carries a legend plus end labels, and every plotted value
   is also readable as text so nothing is gated behind a tooltip.        */

'use strict';

const POLL_MS = 2000;
const TOKEN = new URLSearchParams(location.search).get('token');

// A ?view= parameter wins over the remembered selection, so a page can be
// linked to directly -- useful for sharing "look at this machine" and for
// screenshotting a specific page.
const state = {
  data: null,
  selected: new URLSearchParams(location.search).get('view')
    || sessionStorage.getItem('termox.selected')
    || 'host',
  failures: 0,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------ formatting */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

function bytes(value, digits) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  let n = Number(value), i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i += 1; }
  const d = digits === undefined ? (n < 10 && i > 0 ? 1 : 0) : digits;
  return n.toFixed(d) + ' ' + UNITS[i];
}

function rate(value) {
  if (value === null || value === undefined) return '--';
  if (value < 1024) return Math.round(value) + ' B/s';
  return bytes(value, 1) + '/s';
}

function pct(value, digits) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  return Number(value).toFixed(digits === undefined ? 0 : digits) + '%';
}

/* A bare number for stat tiles, which carry their unit in a separate span. */
function num(value, digits) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  return Number(value).toFixed(digits === undefined ? 0 : digits);
}

function duration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '--';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

function ago(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return 'never';
  if (seconds < 60) return Math.round(seconds) + 's ago';
  return duration(seconds) + ' ago';
}

/* Meter fill severity. Status colour never travels alone -- every meter
   prints its own value beside it, and pills carry a word as well. */
function severity(percent, warn, serious, critical) {
  if (percent === null || percent === undefined) return '';
  if (percent >= (critical || 95)) return 'critical';
  if (percent >= (serious || 85)) return 'serious';
  if (percent >= (warn || 70)) return 'warning';
  return '';
}

/* ------------------------------------------------------------------ dom */

function h(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const key in props) {
      if (key === 'class') node.className = props[key];
      else if (key === 'text') node.textContent = props[key];
      else if (key === 'html') node.innerHTML = props[key];
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), props[key]);
      else if (props[key] !== null && props[key] !== undefined)
        node.setAttribute(key, props[key]);
    }
  }
  (children || []).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return node;
}

function svg(tag, props) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const key in props) {
    if (props[key] !== null && props[key] !== undefined) node.setAttribute(key, props[key]);
  }
  return node;
}

function card(title, note, children) {
  const head = h('div', { class: 'card-head' }, [
    h('div', { class: 'card-title', text: title }),
    note ? (typeof note === 'string' ? h('div', { class: 'card-note', text: note }) : note) : null,
  ]);
  return h('section', { class: 'card' }, [head].concat(children || []));
}

function rows(pairs) {
  return h('dl', { class: 'rows' }, pairs.filter(Boolean).map(([label, value]) =>
    h('div', { class: 'row' }, [
      h('dt', { text: label }),
      typeof value === 'string' || typeof value === 'number'
        ? h('dd', { text: String(value) })
        : h('dd', {}, [value]),
    ])));
}

function tile(label, value, unit, sub, lead) {
  return h('div', { class: 'tile' + (lead ? ' lead' : '') }, [
    h('div', { class: 'tile-label', text: label }),
    h('div', { class: 'tile-value' }, [
      String(value),
      unit ? h('span', { class: 'unit', text: unit }) : null,
    ]),
    h('div', { class: 'tile-sub', text: sub || '' }),
  ]);
}

function meter(label, value, percent, opts) {
  const options = opts || {};
  const level = options.severity === false ? '' : severity(percent, options.warn,
    options.serious, options.critical);
  const width = Math.max(0, Math.min(100, percent === null || percent === undefined ? 0 : percent));
  const bar = h('div', { class: 'meter' }, [
    h('i', { class: level, style: 'width:' + width.toFixed(1) + '%' }),
  ]);
  const row = h('div', { class: 'meter-row' }, [
    h('div', { class: 'meter-label', text: label }),
    h('div', { class: 'meter-value', text: value }),
    bar,
  ]);
  if (options.tip) attachTip(row, options.tip);
  return row;
}

function pill(text, level) {
  return h('span', { class: 'pill ' + (level || '') }, [h('i'), text]);
}

/* -------------------------------------------------------------- tooltip */

let tipNode = null;

function showTip(html, x, y) {
  if (!tipNode) {
    tipNode = h('div', { class: 'tip' });
    document.body.appendChild(tipNode);
  }
  tipNode.innerHTML = html;
  tipNode.style.display = 'block';
  const box = tipNode.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - box.width / 2), innerWidth - box.width - 8);
  const top = y - box.height - 12 < 8 ? y + 16 : y - box.height - 12;
  tipNode.style.left = left + 'px';
  tipNode.style.top = top + 'px';
}

function hideTip() { if (tipNode) tipNode.style.display = 'none'; }

function attachTip(node, html) {
  node.addEventListener('pointerenter', (e) => showTip(html, e.clientX, e.clientY));
  node.addEventListener('pointermove', (e) => showTip(html, e.clientX, e.clientY));
  node.addEventListener('pointerleave', hideTip);
}

/* ------------------------------------------------------------ sparkline */

const VIEW_W = 300;
const VIEW_H = 64;

/* series: [{values, color, label, format}] on ONE axis -- callers only ever
   pass series that share a unit. */
function sparkline(series, opts) {
  const options = opts || {};
  const clean = series.filter((s) => (s.values || []).some((v) => v !== null && v !== undefined));
  const wrap = h('div', { class: 'spark-wrap' });
  if (!clean.length) {
    wrap.appendChild(h('div', { class: 'empty', text: 'no samples yet' }));
    return wrap;
  }

  const count = Math.max.apply(null, clean.map((s) => s.values.length));
  let max = options.max;
  if (max === undefined) {
    max = 0;
    clean.forEach((s) => s.values.forEach((v) => { if (v > max) max = v; }));
    max = max <= 0 ? 1 : max * 1.15;
  }

  const x = (i) => (count < 2 ? VIEW_W : (i / (count - 1)) * VIEW_W);
  const y = (v) => VIEW_H - (Math.max(0, Math.min(max, v)) / max) * (VIEW_H - 4) - 2;

  const chart = svg('svg', {
    class: 'spark', viewBox: '0 0 ' + VIEW_W + ' ' + VIEW_H,
    preserveAspectRatio: 'none', role: 'img',
    'aria-label': options.label || 'trend',
  });

  [0.5, 1].forEach((frac) => {
    chart.appendChild(svg('line', {
      x1: 0, x2: VIEW_W, y1: y(max * frac), y2: y(max * frac),
      stroke: 'var(--grid)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke',
    }));
  });

  clean.forEach((s) => {
    const points = [];
    s.values.forEach((v, i) => { if (v !== null && v !== undefined) points.push([x(i), y(v)]); });
    if (!points.length) return;
    const line = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');

    if (clean.length === 1) {
      chart.appendChild(svg('path', {
        d: line + ' L' + points[points.length - 1][0].toFixed(2) + ' ' + VIEW_H +
           ' L' + points[0][0].toFixed(2) + ' ' + VIEW_H + ' Z',
        fill: s.color, 'fill-opacity': 0.1, stroke: 'none',
      }));
    }
    chart.appendChild(svg('path', {
      d: line, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke',
    }));
    const last = points[points.length - 1];
    chart.appendChild(svg('circle', {
      cx: last[0], cy: last[1], r: 4, fill: s.color,
      stroke: 'var(--surface)', 'stroke-width': 2,
      'vector-effect': 'non-scaling-stroke',
    }));
  });

  const cross = svg('line', {
    y1: 0, y2: VIEW_H, stroke: 'var(--axis)', 'stroke-width': 1,
    'vector-effect': 'non-scaling-stroke', opacity: 0,
  });
  chart.appendChild(cross);
  wrap.appendChild(chart);

  const fmt = options.format || ((v) => pct(v, 1));
  chart.addEventListener('pointermove', (event) => {
    const box = chart.getBoundingClientRect();
    const frac = (event.clientX - box.left) / box.width;
    const index = Math.max(0, Math.min(count - 1, Math.round(frac * (count - 1))));
    cross.setAttribute('x1', x(index));
    cross.setAttribute('x2', x(index));
    cross.setAttribute('opacity', 1);
    const when = (count - 1 - index) * (options.step || 1);
    const lines = clean.map((s) => {
      const v = s.values[index + (s.values.length - count)];
      return '<span style="color:var(--ink-2)">' + s.label + '</span> <b>' +
        (v === null || v === undefined ? '--' : fmt(v)) + '</b>';
    });
    lines.push('<span style="color:var(--muted)">' +
      (when === 0 ? 'now' : Math.round(when) + 's ago') + '</span>');
    showTip(lines.join('<br>'), event.clientX, box.top);
  });
  chart.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); hideTip(); });

  const foot = h('div', { class: 'spark-foot' });
  if (clean.length > 1) {
    foot.appendChild(h('div', { class: 'legend' }, clean.map((s) =>
      h('span', {}, [
        h('i', { style: 'background:' + s.color }),
        s.label + ' ' + fmt(s.values[s.values.length - 1]),
      ]))));
  } else {
    const values = clean[0].values.filter((v) => v !== null && v !== undefined);
    foot.appendChild(h('div', { text: 'now ' + fmt(values[values.length - 1]) }));
    foot.appendChild(h('div', {
      text: 'peak ' + fmt(Math.max.apply(null, values)) +
            '  ·  ' + Math.round(count * (options.step || 1)) + 's window',
    }));
  }
  wrap.appendChild(foot);
  return wrap;
}

/* ---------------------------------------------------------------- views */

function hostTiles(host, nodes) {
  const cpu = host.cpu || {};
  const mem = host.memory || {};
  const battery = host.battery || {};
  const hottest = (host.thermals || [])[0];
  const running = nodes.filter((n) => n.state === 'running').length;

  const tiles = [
    tile('Processor', num(cpu.total), '%',
         (cpu.count || 0) + ' cores · ' + (cpu.governor || 'unknown governor'), true),
    tile('Memory', num(mem.percent), '%',
         bytes(mem.used) + ' of ' + bytes(mem.total)),
    tile('Machines', running + ' / ' + nodes.length, '',
         nodes.length === 1 ? '1 registered' : nodes.length + ' registered'),
  ];
  if (hottest) {
    tiles.push(tile('Hottest zone', hottest.celsius.toFixed(1), '°C', hottest.zone));
  }
  if (battery.available) {
    tiles.push(tile('Battery', battery.percentage === null ? '--' : battery.percentage, '%',
      [battery.status, battery.celsius ? battery.celsius.toFixed(1) + ' °C' : null]
        .filter(Boolean).join(' · ')));
  }
  tiles.push(tile('Uptime', duration(host.uptime), '',
    host.load ? 'load ' + host.load.one.toFixed(2) : ''));
  return h('div', { class: 'tiles' }, tiles);
}

function cpuCard(host, history) {
  const cpu = host.cpu || {};
  const byId = {};
  (cpu.cores || []).forEach((core) => { byId[core.id] = core; });

  const clusters = (cpu.clusters || []).map((cluster) => {
    const cores = cluster.cores.map((id) => {
      const core = byId[id] || { id: id };
      const label = h('div', { class: 'core' }, [
        h('div', { class: 'core-label' }, [
          h('span', { text: 'cpu' + id }),
          h('span', { text: pct(core.percent) }),
        ]),
        meter('', '', core.percent, {
          tip: '<b>cpu' + id + '</b><br>' + pct(core.percent, 1) +
               (core.mhz ? '<br>' + core.mhz + ' MHz' : ''),
        }).lastChild,
      ]);
      return label;
    });
    return h('div', { class: 'cluster' }, [
      h('div', { class: 'cluster-name' },
        [cluster.label + (cluster.max_mhz ? ' · ' + (cluster.max_mhz / 1000).toFixed(2) + ' GHz' : '')]),
      h('div', { class: 'cores' }, cores),
    ]);
  });

  const limits = host.limits || {};
  const note = host.load
    ? 'load ' + host.load.one.toFixed(2) + ' · ' + host.load.five.toFixed(2) +
      ' · ' + host.load.fifteen.toFixed(2)
    : limits.load ? 'no load average' : null;
  return card('Processor', note, [
    sparkline([{ values: history.cpu, color: 'var(--s1)', label: 'total' }],
      { max: 100, label: 'processor load over the last 90 seconds' }),
    h('div', { style: 'margin-top:16px' }, clusters),
    limits.cpu_source === 'cpuidle'
      ? h('div', { class: 'empty', style: 'margin-top:14px',
          text: 'Measured from per-core idle residency in sysfs: this device denies '
            + '/proc/stat to apps, so utilisation is derived from how long each core '
            + 'stayed in an idle state.' })
      : null,
    limits.load
      ? h('div', { class: 'empty', text: limits.load })
      : null,
  ]);
}

function memoryCard(host, history) {
  const mem = host.memory || {};
  return card('Memory', bytes(mem.total) + ' installed', [
    sparkline([{ values: history.memory, color: 'var(--s1)', label: 'in use' }],
      { max: 100, label: 'memory in use over the last 90 seconds' }),
    h('div', { class: 'meters', style: 'margin-top:16px' }, [
      meter('In use', bytes(mem.used) + ' · ' + pct(mem.percent), mem.percent),
      mem.swap_total ? meter('Swap', bytes(mem.swap_used) + ' of ' + bytes(mem.swap_total),
        mem.swap_percent) : null,
    ].filter(Boolean)),
    rows([
      ['Available', bytes(mem.available)],
      ['Cached', bytes(mem.cached)],
    ]),
  ]);
}

function networkCard(host, history) {
  const interfaces = host.network || [];
  const note = interfaces.length
    ? interfaces.length + (interfaces.length === 1 ? ' interface' : ' interfaces')
    : 'unavailable';
  return card('Network', note, [
    interfaces.length ? sparkline([
      { values: history.rx, color: 'var(--s1)', label: 'down' },
      { values: history.tx, color: 'var(--s2)', label: 'up' },
    ], { format: rate, label: 'network throughput over the last 90 seconds' }) : null,
    !interfaces.length && (host.limits || {}).network
      ? h('div', { class: 'later', style: 'margin-top:14px' }, [(host.limits || {}).network])
      : null,
    interfaces.length ? h('div', { class: 'table-scroll', style: 'margin-top:14px' }, [
      h('table', {}, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Interface' }), h('th', { text: 'Down' }), h('th', { text: 'Up' }),
          h('th', { text: 'Received' }), h('th', { text: 'Sent' }),
        ])]),
        h('tbody', {}, interfaces.map((n) => h('tr', {}, [
          h('td', { text: n.iface }),
          h('td', { text: rate(n.rx_rate) }),
          h('td', { text: rate(n.tx_rate) }),
          h('td', { text: bytes(n.rx_bytes) }),
          h('td', { text: bytes(n.tx_bytes) }),
        ]))),
      ]),
    ]) : (host.limits || {}).network
      ? null
      : h('div', { class: 'empty', text: 'no interfaces with traffic' }),
  ]);
}

function storageCard(host) {
  const volumes = host.storage || [];
  if (!volumes.length) return card('Storage', null, [h('div', { class: 'empty', text: 'nothing readable' })]);
  return card('Storage', null, [
    h('div', { class: 'meters' }, volumes.map((v) =>
      meter(v.label, bytes(v.free) + ' free', v.percent, {
        tip: '<b>' + v.path + '</b><br>' + bytes(v.used) + ' of ' + bytes(v.total) +
             ' used<br>' + pct(v.percent, 1),
      }))),
  ]);
}

function gpuCard(host) {
  const gpu = host.gpu || {};
  if (!gpu.available) {
    return card('Graphics', null, [
      h('div', { class: 'empty', text: gpu.reason || 'unavailable' }),
    ]);
  }
  const clockNote = gpu.clock_mhz && gpu.max_clock_mhz && gpu.clock_percent < 95
    ? 'The driver is holding the clock below its ' + gpu.max_clock_mhz +
      ' MHz ceiling. Raising that needs root.'
    : null;
  return card('Graphics', gpu.model || null, [
    h('div', { class: 'tiles', style: 'margin-bottom:14px' }, [
      tile('Utilisation', num(gpu.percent), '%', 'of the whole GPU', true),
      tile('Clock', num(gpu.clock_mhz), ' MHz',
           gpu.max_clock_mhz ? 'ceiling ' + gpu.max_clock_mhz + ' MHz' : ''),
    ]),
    h('div', { class: 'meters' }, [
      meter('Busy', pct(gpu.percent, 1), gpu.percent),
      gpu.clock_percent === null || gpu.clock_percent === undefined ? null
        : meter('Clock of maximum', pct(gpu.clock_percent, 0), gpu.clock_percent,
            { severity: false }),
    ].filter(Boolean)),
    clockNote ? h('div', { class: 'empty', text: clockNote }) : null,
  ]);
}

function dnsTiles(service) {
  const runtime = service.runtime || {};
  const stats = service.dns_stats;
  const tiles = [
    tile('Resolver', service.dns_open ? 'up' : 'down',
         '', 'port ' + (service.dns_port || '--'), true),
    tile('Protection', service.protection === undefined ? '--'
      : service.protection ? 'on' : 'off', '',
      service.dns_version ? 'AdGuard ' + service.dns_version : ''),
  ];
  if (stats) {
    tiles.push(tile('Queries', num(stats.queries), '', 'answered'));
    tiles.push(tile('Blocked', num(stats.blocked), '',
      stats.blocked_percent === null ? '' : pct(stats.blocked_percent, 1) + ' of queries'));
    tiles.push(tile('Latency', num(stats.avg_ms, 1), ' ms', 'average'));
  }
  tiles.push(tile('Processor', num(runtime.cpu_percent), '%',
    'of one phone core' + (runtime.pid ? ' · pid ' + runtime.pid : '')));
  tiles.push(tile('Resident', bytes(runtime.rss), '',
    runtime.threads ? runtime.threads + ' threads' : ''));
  tiles.push(tile('Uptime', duration(runtime.uptime), '', ''));
  return h('div', { class: 'tiles' }, tiles);
}

function dnsCard(service, host) {
  const address = ((host || {}).identity || {}).address || 'this-phone';
  return card('Resolver', 'point clients here', [
    rows([
      ['DNS', h('span', { class: 'mono',
        text: address + ':' + (service.dns_port || '--') })],
      ['Admin', h('span', { class: 'mono', text: (service.endpoint || '')
        .replace('127.0.0.1', address) })],
      ['Status', service.dns_open ? 'answering queries' : 'not answering'],
    ]),
    service.dns_stats ? null : h('div', { class: 'empty',
      text: 'Query counts need the AdGuard web password, so they are not shown.' }),
    h('div', { class: 'empty',
      text: 'Port 53 needs root, so the resolver runs on '
        + (service.dns_port || '5300') + '. Clients must be pointed at that port.' }),
  ]);
}

function serviceTiles(service) {
  const runtime = service.runtime || {};
  const metrics = service.metrics || {};
  // The per-second gauge is reset by llama.cpp whenever /metrics is read, so
  // it is usually zero by the time the UI sees it. The lifetime average,
  // derived from monotonic counters, is the number that is always true.
  const live = metrics.tokens_per_second;
  const rate = live ? live : metrics.average_tps;
  return h('div', { class: 'tiles' }, [
    tile('Generation', num(rate, 1), ' tok/s',
         live ? 'last request' : (metrics.average_tps ? 'average since start' : 'no requests yet'), true),
    tile('Prompt', num(metrics.prompt_per_second || metrics.average_prompt_tps, 1),
         ' tok/s',
         metrics.prompt_cached ? num(metrics.prompt_cached) + ' tokens cached'
           : (metrics.prompt_per_second ? 'last request' : 'average since start')),
    tile('Processor', num(runtime.cpu_percent), '%',
         'of one phone core' + (runtime.pid ? ' · pid ' + runtime.pid : '')),
    tile('Resident', bytes(runtime.rss), '',
         runtime.threads ? runtime.threads + ' threads' : ''),
    tile('Served', num(metrics.tokens_total), '',
         'tokens generated since start'),
    tile('Uptime', duration(runtime.uptime), '',
         metrics.processing ? num(metrics.processing) + ' in flight' : 'idle'),
  ]);
}

function serviceTrendCard(service) {
  const history = service.history || {};
  if (!(history.rate || []).some((v) => v !== null && v !== undefined)) return null;
  return card('Trend', 'last ' + Math.round((history.rate || []).length * 3) + ' seconds', [
    h('div', { class: 'grid two', style: 'gap:22px' }, [
      h('div', {}, [
        h('div', { class: 'card-title', style: 'margin-bottom:8px', text: 'Generation rate' }),
        sparkline([{ values: history.rate, color: 'var(--s1)', label: 'tok/s' }],
          { step: 3, format: (v) => num(v, 1) + ' tok/s',
            label: 'generation rate over time' }),
      ]),
      h('div', {}, [
        h('div', { class: 'card-title', style: 'margin-bottom:8px', text: 'Processor' }),
        sparkline([{ values: history.cpu, color: 'var(--s2)', label: 'cpu' }],
          { step: 3, label: 'processor use by the model server' }),
      ]),
    ]),
  ]);
}

function endpointCard(service, host) {
  const address = ((host || {}).identity || {}).address || 'this-phone';
  const base = (service.endpoint || '').replace('127.0.0.1', address);
  return card('Endpoints', 'reachable from anything on the network', [
    rows([
      ['OpenAI-compatible', h('span', { class: 'mono', text: base + '/v1' })],
      ['Native', h('span', { class: 'mono', text: base })],
      ['Model id', h('span', { class: 'mono',
        text: service.served_model || '(unknown)' })],
    ]),
    h('div', { class: 'empty',
      text: 'Point Page Assist or any OpenAI-compatible client at the /v1 URL. '
        + 'No API key is checked, so keep it on the LAN.' }),
  ]);
}

function serviceDetailCard(service, host) {
  const runtime = service.runtime || {};
  const gpu = (host || {}).gpu || {};
  if (service.id === 'dns') {
    return card('Runtime', service.kind || null, [
      rows([
        service.dns_version ? ['Version', service.dns_version] : null,
        ['Binary', h('span', { class: 'mono',
          text: (runtime.binary || '--').split('/').pop() })],
        ['Directory', h('span', { class: 'mono', text: runtime.directory || '--' })],
        runtime.cores ? ['Cores', runtime.cores.join(', ')] : null,
        runtime.nice === null || runtime.nice === undefined
          ? null : ['Priority', 'nice ' + runtime.nice],
      ]),
    ]);
  }
  return card('Runtime', service.kind || null, [
    rows([
      ['Model', service.model ? service.model.split('/').pop() : 'unknown'],
      service.context ? ['Context', num(service.context) + ' tokens'] : null,
      ['Accelerator', service.uses_gpu
        ? (gpu.available
            ? (gpu.model || 'GPU') + ' · ' + pct(gpu.percent) + ' busy · ' +
              (gpu.clock_mhz || '--') + ' MHz'
            : 'GPU requested but unreadable')
        : 'processor only'],
      runtime.cores ? ['Cores', runtime.cores.join(', ')] : null,
      runtime.nice === null || runtime.nice === undefined
        ? null : ['Priority', 'nice ' + runtime.nice],
    ]),
  ]);
}

function renderService(data, service) {
  const stage = $('stage');
  stage.textContent = '';
  const running = service.state === 'running';
  const isDns = service.id === 'dns';

  stage.appendChild(h('div', { class: 'stage-head' }, [
    h('h1', { class: 'stage-title', text: service.name }),
    pill(service.state, running ? 'good'
      : service.state === 'starting' ? 'warning' : 'idle'),
    h('span', { class: 'stage-note',
      text: running ? '' : 'the process is not answering on its port' }),
  ]));

  if (!running) {
    stage.appendChild(h('div', { class: 'later' }, [
      'Start it with ~/llm.sh on the phone, or reboot -- it is in the boot script.',
    ]));
  }

  stage.appendChild(isDns ? dnsTiles(service) : serviceTiles(service));
  const trend = serviceTrendCard(service);
  if (trend) stage.appendChild(trend);
  stage.appendChild(h('div', { class: 'grid two' }, [
    serviceDetailCard(service, data.host),
    isDns ? dnsCard(service, data.host) : endpointCard(service, data.host),
  ]));
}

function sensorsCard(host) {
  const battery = host.battery || {};
  const thermals = host.thermals || [];
  return card('Sensors', null, [
    thermals.length
      ? h('div', { class: 'chips' }, thermals.map((z) =>
          pill(z.zone + ' ' + z.celsius.toFixed(1) + ' °C',
               z.celsius >= 60 ? 'critical' : z.celsius >= 48 ? 'warning' : 'good')))
      : h('div', { class: 'empty', text: 'no readable thermal zones' }),
    h('div', { style: 'margin-top:14px' }, [rows([
      ['Battery', battery.available
        ? [battery.percentage + '%', battery.status, battery.health,
           battery.celsius ? battery.celsius.toFixed(1) + ' °C' : null].filter(Boolean).join(' · ')
        : battery.reason || 'unavailable'],
    ])]),
  ]);
}

function pathsCard(data) {
  const rows = data.paths || [];
  if (!rows.length) return null;
  return card('Where things run', 'binaries and working directories, read from /proc', [
    h('div', { class: 'table-scroll' }, [h('table', {}, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'App' }), h('th', { text: 'Kind' }),
        h('th', { text: 'Binary' }), h('th', { text: 'Directory' }),
        h('th', { text: 'Data' }),
      ])]),
      h('tbody', {}, rows.map((r) => h('tr', {}, [
        h('td', {}, [
          h('span', { class: 'pill ' + (r.state === 'running' ? 'good' : 'idle') },
            [h('i'), r.name]),
        ]),
        h('td', { text: r.kind || '--' }),
        h('td', { class: 'mono wrap', text: r.binary || 'not running' }),
        h('td', { class: 'mono wrap', text: r.directory || '--' }),
        h('td', { class: 'mono wrap', text: r.detail || '--' }),
      ]))),
    ])]),
  ]);
}

function deviceCard(host) {
  const id = host.identity || {};
  return card('Device', null, [rows([
    ['Model', id.device || 'unknown'],
    id.soc ? ['Chipset', id.soc] : null,
    id.android ? ['Android', id.android + (id.sdk ? ' (API ' + id.sdk + ')' : '')] : null,
    ['Kernel', id.kernel],
    ['Architecture', id.arch],
    ['Hostname', id.hostname],
    ['Address', id.address || 'unknown'],
  ])]);
}

function renderHost(data) {
  const host = data.host;
  const stage = $('stage');
  stage.textContent = '';
  if (!host) {
    stage.appendChild(h('div', { class: 'empty', text: 'waiting for the first sample' }));
    return;
  }
  const id = host.identity || {};
  stage.appendChild(h('div', { class: 'stage-head' }, [
    h('h1', { class: 'stage-title', text: id.device || id.hostname || 'This phone' }),
    h('span', { class: 'stage-note', text: 'the machine everything else runs on' }),
  ]));
  stage.appendChild(hostTiles(host, data.nodes || []));

  const pairs = [
    [cpuCard(host, data.history), memoryCard(host, data.history)],
    [gpuCard(host), storageCard(host)],
    [networkCard(host, data.history), sensorsCard(host)],
    [deviceCard(host), null],
    [pathsCard(data), null],
  ];
  pairs.forEach((row) => {
    const cards = row.filter(Boolean);
    if (cards.length) stage.appendChild(h('div', { class: 'grid two' }, cards));
  });
}

/* ------------------------------------------------------------------- vm */

function vmTiles(node, guest) {
  const runtime = node.runtime || {};
  const spec = node.spec || {};
  const tiles = [
    tile('Emulator load', num(runtime.cpu_percent), '%',
         'of one phone core' + (runtime.pid ? ' · pid ' + runtime.pid : ''), true),
  ];
  if (guest && guest.ok && guest.cpu) {
    tiles.push(tile('Guest processor', num(guest.cpu.total), '%',
      (guest.cpu.count || spec.cores || 0) + ' virtual cores'));
    if (guest.memory) {
      tiles.push(tile('Guest memory', num(guest.memory.percent), '%',
        bytes(guest.memory.used) + ' of ' + bytes(guest.memory.total)));
    }
  } else {
    tiles.push(tile('Allocated', spec.cores || '--', ' cores',
      spec.memory_mb ? bytes(spec.memory_mb * 1024 * 1024) + ' of memory' : ''));
  }
  tiles.push(tile('Resident', bytes(runtime.rss), '',
    runtime.threads ? runtime.threads + ' threads' : ''));
  tiles.push(tile('Uptime', duration(runtime.uptime), '',
    node.boots ? node.boots + (node.boots === 1 ? ' boot seen' : ' boots seen') : ''));
  return h('div', { class: 'tiles' }, tiles);
}

function vmTrendCard(node, guest) {
  const history = node.history || {};
  const hasGuest = (history.guest || []).some((v) => v !== null && v !== undefined);
  const cards = [
    h('div', {}, [
      h('div', { class: 'card-title', style: 'margin-bottom:8px', text: 'Emulator load' }),
      sparkline([{ values: history.cpu, color: 'var(--s1)', label: 'emulator' }],
        { step: 2, label: 'phone cost of running this machine' }),
    ]),
  ];
  if (hasGuest) {
    cards.push(h('div', {}, [
      h('div', { class: 'card-title', style: 'margin-bottom:8px', text: 'Guest processor' }),
      sparkline([{ values: history.guest, color: 'var(--s2)', label: 'guest' }],
        { step: 2, max: 100, label: 'load inside the guest' }),
    ]));
  }
  return card('Trend', 'last ' + Math.round((history.cpu || []).length * 2) + ' seconds', [
    h('div', { class: 'grid two', style: 'gap:22px' }, cards),
    h('div', { class: 'empty',
      text: hasGuest
        ? 'Two scales, two charts: emulator load is a share of one phone core and can pass 100%, '
          + 'while guest load is a share of the machine\'s own cores.'
        : 'Guest load appears here once the dashboard can read inside the machine.' }),
  ]);
}

function specCard(node) {
  const spec = node.spec || {};
  return card('Machine', spec.binary, [rows([
    ['Architecture', spec.arch || 'unknown'],
    ['Machine type', spec.machine || 'default'],
    ['Processor model', spec.cpu || 'default'],
    ['Virtual cores', spec.cores === null ? 'unset' : String(spec.cores)],
    ['Memory', spec.memory_mb ? bytes(spec.memory_mb * 1024 * 1024) : 'unset'],
    ['Acceleration', spec.accel === 'tcg'
      ? pill('tcg · full emulation', 'warning') : pill(spec.accel, 'good')],
    ['Console', spec.display || 'default'],
    spec.cwd ? ['Started in', h('span', { class: 'mono', text: spec.cwd })] : null,
  ])]);
}

function disksCard(node) {
  const spec = node.spec || {};
  const disks = (spec.disks || []).concat(spec.cdroms || []);
  if (!disks.length) return null;
  return card('Storage', null, [
    h('div', { class: 'meters' }, disks.map((d) => {
      if (d.missing) {
        return meter(d.name, 'file is missing', 0, { severity: false });
      }
      const percent = d.virtual ? (d.allocated / d.virtual) * 100 : null;
      return meter(d.name,
        bytes(d.allocated) + (d.virtual ? ' of ' + bytes(d.virtual) : ''),
        percent === null ? 0 : percent, {
          warn: 80, serious: 90, critical: 96,
          tip: '<b>' + d.path + '</b><br>' + (d.format || 'raw') +
               (d.interface ? ' · ' + d.interface : '') +
               '<br>allocated ' + bytes(d.allocated) +
               (d.virtual ? '<br>virtual ' + bytes(d.virtual) : ''),
        });
    })),
    h('div', { class: 'empty', text: 'qcow2 images grow as the guest writes' }),
  ]);
}

function portsCard(node) {
  const ports = node.ports || [];
  if (!ports.length) {
    return card('Ports', null, [h('div', { class: 'empty',
      text: 'no forwards on the command line, so nothing on the phone reaches this guest' })]);
  }
  return card('Ports', 'forwarded from the phone', [
    h('div', { class: 'chips' }, ports.map((p) => {
      const label = p.proto + ' ' + p.host_port + ' → ' + p.guest_port +
        (p.label ? ' · ' + p.label : '');
      if (p.proto !== 'tcp') return pill(label, 'idle');
      return pill(label + (p.open ? ' · open' : ' · closed'), p.open ? 'good' : 'idle');
    })),
  ]);
}

function guestCard(node, guest) {
  if (!guest) {
    return card('Inside the guest', null, [h('div', { class: 'empty', text: 'not sampled yet' })]);
  }
  if (!guest.ok) {
    return card('Inside the guest', guest.endpoint || null, [
      h('div', { class: 'empty', text: guest.reason || 'unreachable' }),
      guest.configured === false ? null : h('pre', { class: 'cmdline',
        text: 'python3 -m termox setup-guest' }),
    ]);
  }
  const mem = guest.memory || {};
  return card('Inside the guest', guest.endpoint + ' · ' + guest.latency_ms + ' ms', [
    rows([
      ['Hostname', guest.hostname || '--'],
      ['System', guest.os || '--'],
      ['Kernel', guest.kernel || '--'],
      ['Uptime', duration(guest.uptime)],
      ['Load', guest.load ? guest.load.map((v) => v.toFixed(2)).join(' · ') : '--'],
    ]),
    h('div', { class: 'meters', style: 'margin-top:14px' }, [
      meter('Memory', bytes(mem.used) + ' of ' + bytes(mem.total), mem.percent),
    ].concat((guest.filesystems || []).map((fs) =>
      meter(fs.mount, bytes(fs.free) + ' free', fs.percent, {
        tip: '<b>' + fs.device + '</b> on ' + fs.mount + '<br>' +
             bytes(fs.used) + ' of ' + bytes(fs.total),
      })))),
  ]);
}

function containersCard(guest) {
  if (!guest || !guest.ok || !guest.docker) return null;
  const docker = guest.docker;
  if (!docker.installed) return null;
  const list = docker.containers || [];
  const note = docker.age === null || docker.age < 0
    ? 'first reading on the way'
    : 'read ' + ago(docker.age) + ' · refreshed every ' + Math.round(docker.refresh) + 's';

  if (!list.length) {
    return card('Containers', note, [h('div', { class: 'empty',
      text: docker.age < 0
        ? 'docker is installed; the first listing takes about twenty seconds under emulation'
        : 'no containers' })]);
  }
  return card('Containers', note, [
    h('div', { class: 'table-scroll' }, [h('table', {}, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'Name' }), h('th', { text: 'Image' }), h('th', { text: 'State' }),
        h('th', { text: 'Processor' }), h('th', { text: 'Memory' }), h('th', { text: 'Network' }),
      ])]),
      h('tbody', {}, list.map((c) => h('tr', {}, [
        h('td', { text: c.name }),
        h('td', { class: 'wrap', text: c.image }),
        h('td', {}, [pill(c.state, c.state === 'running' ? 'good' : 'idle')]),
        h('td', { text: c.cpu_percent === null ? '--' : pct(c.cpu_percent, 1) }),
        h('td', { text: c.mem_used === null ? '--' : bytes(c.mem_used) +
          (c.mem_percent === null ? '' : ' · ' + pct(c.mem_percent, 1)) }),
        h('td', { text: c.net_io || '--' }),
      ]))),
    ])]),
  ]);
}

function renderVm(data, node) {
  const guest = (data.guests || {})[node.key];
  const stage = $('stage');
  stage.textContent = '';

  const running = node.state === 'running';
  stage.appendChild(h('div', { class: 'stage-head' }, [
    h('h1', { class: 'stage-title', text: node.name }),
    pill(running ? 'running' : 'stopped', running ? 'good' : 'idle'),
    h('span', { class: 'stage-note',
      text: running ? '' : 'last seen ' + (node.last_seen
        ? ago((Date.now() / 1000) - node.last_seen) : 'never') }),
  ]));

  if (!running) {
    stage.appendChild(h('div', { class: 'later' }, [
      'This machine is remembered but not running. Starting it from here is the next '
      + 'piece of work; for now bring it up the way you always have.',
    ]));
  }

  stage.appendChild(vmTiles(node, guest));
  if (running && (node.history || {}).cpu) stage.appendChild(vmTrendCard(node, guest));
  stage.appendChild(h('div', { class: 'grid two' }, [specCard(node), portsCard(node)]));
  const disks = disksCard(node);
  stage.appendChild(h('div', { class: 'grid two' }, [guestCard(node, guest), disks].filter(Boolean)));
  const containers = containersCard(guest);
  if (containers) stage.appendChild(containers);
  stage.appendChild(card('Command line', node.controllable
    ? 'a monitor socket is exposed'
    : 'no -qmp socket, so this machine cannot be controlled remotely yet', [
    h('pre', { class: 'cmdline', text: node.cmdline || '--' }),
  ]));
}

/* ----------------------------------------------------------------- rail */

function renderRail(data) {
  const rail = $('rail');
  rail.textContent = '';
  const host = data.host || {};
  const id = host.identity || {};

  rail.appendChild(h('div', { class: 'rail-heading', text: 'Host' }));
  rail.appendChild(h('button', {
    class: 'node', type: 'button', 'aria-current': state.selected === 'host',
    onclick: () => select('host'),
  }, [
    h('span', { class: 'dot host' }),
    h('span', { class: 'node-name', text: id.device || id.hostname || 'phone' }),
    h('span', { class: 'node-metric', text: pct((host.cpu || {}).total) }),
    h('span', { class: 'node-sub', text: (host.memory ? pct(host.memory.percent) + ' memory' : '') +
      (host.battery && host.battery.available ? ' · ' + host.battery.percentage + '% battery' : '') }),
  ]));

  const nodes = data.nodes || [];
  rail.appendChild(h('div', { class: 'rail-heading',
    text: nodes.length ? 'Machines' : 'No machines found' }));
  nodes.forEach((node) => {
    const guest = (data.guests || {})[node.key] || {};
    const runtime = node.runtime || {};
    const guestLoad = guest.ok && guest.cpu ? guest.cpu.total : null;
    const sub = node.state !== 'running'
      ? 'stopped'
      : guestLoad !== null && guestLoad !== undefined
        ? pct(guestLoad) + ' guest load'
        : (node.spec.cores || '?') + ' cores · ' +
          (node.spec.memory_mb ? bytes(node.spec.memory_mb * 1024 * 1024) : '?');
    rail.appendChild(h('button', {
      class: 'node', type: 'button', 'aria-current': state.selected === node.key,
      onclick: () => select(node.key),
    }, [
      h('span', { class: 'dot ' + node.state }),
      h('span', { class: 'node-name', text: node.name }),
      h('span', { class: 'node-metric',
        text: node.state === 'running' ? pct(runtime.cpu_percent) : '' }),
      h('span', { class: 'node-sub', text: sub }),
    ]));
  });

  if (!nodes.length) {
    rail.appendChild(h('div', { class: 'later' }, [
      'Start a qemu-system VM and it appears here on its own.',
    ]));
  }

  const services = data.services || [];
  if (services.length) {
    rail.appendChild(h('div', { class: 'rail-heading', text: 'Services' }));
    services.forEach((service) => {
      const key = 'svc:' + service.id;
      const metrics = service.metrics || {};
      const runtime = service.runtime || {};
      const rate = metrics.tokens_per_second || metrics.average_tps;
      rail.appendChild(h('button', {
        class: 'node', type: 'button', 'aria-current': state.selected === key,
        onclick: () => select(key),
      }, [
        h('span', { class: 'dot ' + (service.state === 'running' ? 'running' : 'stopped') }),
        h('span', { class: 'node-name', text: service.name }),
        h('span', { class: 'node-metric',
          text: service.state === 'running' ? pct(runtime.cpu_percent) : '' }),
        h('span', { class: 'node-sub',
          text: service.state !== 'running' ? service.state
            : service.id === 'dns'
              ? (service.dns_open ? 'resolving on ' + service.dns_port : 'port closed')
                + ' · ' + bytes(runtime.rss)
            : metrics.processing ? 'answering now'
            : rate ? num(rate, 1) + ' tok/s · ' + bytes(runtime.rss) : bytes(runtime.rss) }),
      ]));
    });
  }
}

/* --------------------------------------------------------------- render */

function select(key) {
  state.selected = key;
  sessionStorage.setItem('termox.selected', key);
  const url = new URL(location.href);
  if (key === 'host') url.searchParams.delete('view');
  else url.searchParams.set('view', key);
  history.replaceState(null, '', url);
  render();
  $('stage').focus();
}

function render() {
  const data = state.data;
  if (!data) return;
  renderRail(data);

  const service = state.selected.startsWith('svc:')
    ? (data.services || []).find((s) => 'svc:' + s.id === state.selected)
    : null;
  const node = (data.nodes || []).find((n) => n.key === state.selected);
  if (service) renderService(data, service);
  else if (state.selected === 'host' || !node) renderHost(data);
  else renderVm(data, node);

  const host = data.host || {};
  const id = host.identity || {};
  const meta = $('topbar-meta');
  meta.textContent = '';
  [
    ['host', id.address || id.hostname || '--'],
    ['up', duration(host.uptime)],
    ['machines', (data.nodes || []).filter((n) => n.state === 'running').length +
      ' / ' + (data.nodes || []).length],
  ].forEach(([label, value]) => {
    meta.appendChild(h('span', {}, [label + ' ', h('b', { text: value })]));
  });
}

/* ----------------------------------------------------------------- poll */

async function poll() {
  try {
    const response = await fetch('/api/state', {
      headers: TOKEN ? { 'X-Termox-Token': TOKEN } : {},
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    state.data = await response.json();
    state.failures = 0;
    document.body.classList.remove('stale-data');
    $('pulse').classList.remove('stale');
    $('banner').hidden = true;
    render();
  } catch (err) {
    state.failures += 1;
    if (state.failures > 1) {
      document.body.classList.add('stale-data');
      $('pulse').classList.add('stale');
      const banner = $('banner');
      banner.textContent = 'lost the dashboard · retrying (' + state.failures + ')';
      banner.hidden = false;
    }
  }
}

/* ---------------------------------------------------------------- theme */

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

$('theme').addEventListener('click', () => {
  const current = localStorage.getItem('termox.theme');
  const next = current === 'dark' ? 'light' : current === 'light' ? '' : 'dark';
  if (next) localStorage.setItem('termox.theme', next);
  else localStorage.removeItem('termox.theme');
  applyTheme(next);
});

applyTheme(localStorage.getItem('termox.theme'));
poll();
setInterval(poll, POLL_MS);
