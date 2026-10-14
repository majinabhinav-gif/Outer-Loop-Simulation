// Rohan Builders design system components, as plain DOM builders. The markup and class names match
// the system's React bundle exactly (rohan/rohan.css styles them); only the rendering is vanilla JS.

const SVG = 'http://www.w3.org/2000/svg';
const PATHS = {
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  clock: 'M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  minus: 'M5 12h14',
  chevron: 'm6 9 6 6 6-6',
  up: 'm18 15-6-6-6 6',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  hand: 'M12 8v4m0 4h.01M8.5 2h7L22 8.5v7L15.5 22h-7L2 15.5v-7z',
  agent: 'M12 2 20.7 7v10L12 22 3.3 17V7zM12 8v8M8 10l8 4M16 10l-8 4',
  // Lucide play / pause / skip-forward / rotate-ccw, for the run controls
  play: 'M6 3l14 9-14 9z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  skip: 'M5 4l10 8-10 8zM19 5v14',
  reset: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
};

export function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}

export function icon(name, size = 16, { spin = false, className = '' } = {}) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('class', ['rb-icon', spin && 'rb-spin', className].filter(Boolean).join(' '));
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', size > 16 ? 2 : 1.75);
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', name === 'spinner' ? 'M21 12a9 9 0 1 1-6.2-8.6' : PATHS[name] || PATHS.info);
  s.append(p);
  return s;
}

/** Button: variant primary | secondary | ghost | danger | agent; size sm | md | lg. */
export function button(label, { variant = 'secondary', size = 'md', icon: ic, onClick, title, loading = false, attrs = {} } = {}) {
  const b = el('button', `rb-btn rb-btn-${variant} rb-btn-${size}${loading ? ' is-loading' : ''}`);
  b.type = 'button';
  if (loading) { b.disabled = true; b.setAttribute('aria-busy', 'true'); b.append(icon('spinner', 16, { spin: true })); }
  else if (ic) b.append(icon(ic));
  b.append(label);
  if (title) b.title = title;
  if (onClick) b.addEventListener('click', onClick);
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  return b;
}

const TONE_ICON = { success: 'check', warning: 'alert', danger: 'x', info: 'info', neutral: 'minus', pending: 'clock', agent: 'agent' };
/** StatusBadge: always an icon and a word. */
export function badge(tone, text, ic) {
  return el('span', `rb-badge rb-badge-${tone}`, icon(ic || TONE_ICON[tone], 12), text);
}

/** Stat: label, pre-formatted value, unit, trend {direction, label, tone}, caption. */
export function stat({ label, value, unit, trend, caption, id }) {
  const v = el('div', 'rb-stat-value', value);
  if (unit) v.append(el('span', 'rb-stat-unit', unit));
  const s = el('div', 'rb-stat', el('div', 'rb-stat-label', label), v);
  if (trend) s.append(el('div', `rb-stat-trend rb-text-${trend.tone || 'muted'}`, icon(trend.direction === 'down' ? 'chevron' : 'up', 14), trend.label));
  if (caption) s.append(el('div', 'rb-stat-caption', caption));
  if (id) s.id = id;
  return s;
}

let uid = 0;
function field({ label, hint, id, className = '' }, control) {
  const f = el('div', `rb-field ${className}`.trim());
  if (label) { const l = el('label', 'rb-label', label); l.htmlFor = id; f.append(l); }
  f.append(control);
  if (hint) { const h = el('div', 'rb-help', hint); h.id = `${id}-msg`; f.append(h); }
  return f;
}

/** Select: options as strings or {value, label}. Returns { root, select }. */
export function select({ label, options, value, hint, size = 'md', id, className, onChange }) {
  id = id || `rb-f${++uid}`;
  const s = el('select');
  s.id = id;
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    const e = el('option', null, opt.label);
    e.value = opt.value;
    s.append(e);
  }
  if (value != null) s.value = String(value);
  if (hint) s.setAttribute('aria-describedby', `${id}-msg`);
  if (onChange) s.addEventListener('change', onChange);
  const box = el('div', `rb-input rb-select rb-input-${size}`, s, icon('chevron', 16, { className: 'rb-select-chev' }));
  return { root: field({ label, hint, id, className }, box), select: s };
}

/** TextField with optional unit suffix. Returns { root, input }. */
export function textField({ label, hint, unit, size = 'md', id, type = 'text', value, attrs = {}, className }) {
  id = id || `rb-f${++uid}`;
  const i = el('input');
  i.id = id;
  i.type = type;
  if (value != null) i.value = value;
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  if (hint) i.setAttribute('aria-describedby', `${id}-msg`);
  const box = el('div', `rb-input rb-input-${size}`, i, unit ? el('span', 'rb-unit', unit) : null);
  return { root: field({ label, hint, id, className }, box), input: i };
}

/** InlineAlert: tone info | success | warning | danger. */
export function alert(tone, title, body, action) {
  const ic = { info: 'info', success: 'check', warning: 'alert', danger: 'hand' }[tone];
  const a = el('div', `rb-alert rb-alert-${tone}`,
    icon(ic, 16, { className: 'rb-alert-icon' }),
    el('div', 'rb-alert-body', title ? el('div', 'rb-alert-title', title) : null, body ? el('div', null, body) : null),
    action ? el('div', 'rb-alert-action', action) : null);
  a.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
  return a;
}

const STEP_ICON = { done: 'check', running: 'spinner', failed: 'x', waiting: 'hand', queued: 'minus' };
const STEP_WORD = { done: 'Done', running: 'Running', failed: 'Failed', waiting: 'Needs you', queued: 'Queued' };
/** AgentTimeline: steps [{status, title, tool?, detail?, duration?}]. */
export function timeline(steps) {
  const ol = el('ol', 'rb-timeline');
  for (const s of steps) {
    const st = s.status || 'queued';
    const mark = el('span', 'rb-step-mark', icon(STEP_ICON[st], 12, { spin: st === 'running' }));
    mark.title = STEP_WORD[st];
    const meta = st === 'waiting' || st === 'failed' ? STEP_WORD[st] : s.duration || (st === 'running' ? 'Running' : '');
    ol.append(el('li', `rb-step rb-step-${st}`, mark, el('div', 'rb-step-main',
      el('div', 'rb-step-row', el('span', 'rb-step-title', s.title), el('span', 'rb-step-meta', meta)),
      s.tool ? el('div', 'rb-step-tool rb-mono', s.tool) : null,
      s.detail ? el('div', 'rb-step-detail', s.detail) : null)));
  }
  return ol;
}

/** AgentMessage: the agent's answer with confidence, assumptions and sources. */
export function agentMessage({ agent = 'Agent', time, confidence, paragraphs = [], assumptions = [], sources = [], actions = [], streaming = false }) {
  const head = el('header', 'rb-agent-head',
    el('span', 'rb-agent-avatar', icon('agent', 14)),
    el('span', 'rb-agent-name', agent),
    time ? el('span', 'rb-agent-time', time) : null,
    confidence ? el('span', `rb-conf rb-conf-${confidence.toLowerCase()}`, `Confidence: ${confidence}`) : null);
  const body = el('div', 'rb-agent-body', ...paragraphs.map((t) => el('p', null, t)));
  if (streaming) body.append(el('span', 'rb-caret'));
  const m = el('article', `rb-agent-msg${streaming ? ' is-streaming' : ''}`, head, body);
  if (streaming) m.setAttribute('aria-busy', 'true');
  if (assumptions.length) m.append(el('div', 'rb-agent-assume', el('div', 'rb-agent-sub', 'Assumptions'), el('ul', null, ...assumptions.map((a) => el('li', null, a)))));
  if (sources.length) {
    m.append(el('div', 'rb-agent-sources', el('div', 'rb-agent-sub', 'Sources'), ...sources.map((s) => {
      const a = el('a', 'rb-source', icon('file', 14), el('span', 'rb-mono', s.label), s.detail ? el('span', 'rb-source-detail', s.detail) : null);
      a.href = s.href || '#';
      if (s.onClick) a.addEventListener('click', (e) => { e.preventDefault(); s.onClick(); });
      return a;
    })));
  }
  if (actions.length) m.append(el('footer', 'rb-agent-actions', ...actions));
  return m;
}

const RISK = { low: ['success', 'Low risk'], medium: ['warning', 'Medium risk'], high: ['danger', 'High risk'] };
/**
 * ApprovalCard. state: pending | approved | rejected | auto (applied automatically by policy, with Undo).
 * changes: [{field, from, to}]. actions: buttons for the footer (pending and auto states).
 */
export function approvalCard({ title, agent, risk = 'medium', description, changes = [], impact, state = 'pending', actions = [], decidedBy }) {
  const r = RISK[risk];
  const kicker = { pending: 'Approval needed', approved: 'Approved', rejected: 'Rejected', auto: 'Applied automatically' }[state];
  const card = el('section', `rb-approval is-${state === 'auto' ? 'approved' : state}`,
    el('header', 'rb-approval-head',
      el('span', 'rb-approval-kicker', state === 'pending' ? el('span', 'rb-dot-hivis') : null, kicker),
      badge(r[0], r[1])),
    el('div', 'rb-approval-title', title));
  if (agent) card.append(el('div', 'rb-approval-by', icon('agent', 14), 'Proposed by ', el('strong', null, agent)));
  if (description) card.append(el('p', 'rb-approval-desc', description));
  if (changes.length) {
    const t = el('table', 'rb-diff',
      el('thead', null, el('tr', null, el('th', null, 'Field'), el('th', null, 'Current'), el('th', null, 'Proposed'))),
      el('tbody', null, ...changes.map((c) => el('tr', null, el('td', null, c.field), el('td', 'rb-diff-old rb-mono', c.from), el('td', 'rb-diff-new rb-mono', c.to)))));
    card.append(t);
  }
  if (impact) card.append(el('div', 'rb-approval-impact', icon('info', 14), el('span', null, impact)));
  if (state === 'pending') card.append(el('footer', 'rb-approval-actions', ...actions));
  else {
    const word = state === 'rejected' ? badge('danger', 'Rejected') : badge('success', state === 'auto' ? 'Applied' : 'Approved');
    card.append(el('footer', 'rb-approval-done', word, el('span', null, decidedBy || 'Logged to the record'), ...actions));
  }
  return card;
}

/** DataTable (static): columns [{key, label, align, mono, render}], rows. */
export function dataTable(columns, rows, { density = 'compact', className = '' } = {}) {
  const head = el('tr', null, ...columns.map((c) => el('th', c.align === 'right' ? 'rb-num' : null, c.label)));
  const body = rows.map((r) => el('tr', r._selected ? 'is-selected' : null, ...columns.map((c) => {
    const v = c.render ? c.render(r) : r[c.key];
    return el('td', [c.align === 'right' && 'rb-num', c.mono && 'rb-mono'].filter(Boolean).join(' ') || null, v);
  })));
  return el('div', `rb-table-wrap ${className}`.trim(),
    el('table', `rb-table ${density === 'default' ? 'rb-table-default' : 'rb-table-compact'}`, el('thead', null, head), el('tbody', null, ...body)));
}

/** Tabs (page-level views here): items [{value, label, count?, attention?}]. */
export function tabs(items, value, onChange) {
  const root = el('div', 'rb-tabs');
  root.setAttribute('role', 'tablist');
  const render = (val) => {
    root.replaceChildren(...items.map((it) => {
      const b = el('button', `rb-tab${it.value === val ? ' is-on' : ''}`, it.label,
        it.count != null ? el('span', 'rb-tab-count', String(it.count)) : null,
        it.attention ? el('span', 'rb-dot-hivis') : null);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(it.value === val));
      b.addEventListener('click', () => onChange(it.value));
      return b;
    }));
  };
  render(value);
  return { root, render, items };
}
