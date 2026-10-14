// The browser app: a live plant with a choice of outer loop, and a side-by-side comparison.
// UI built with the Rohan Builders design system (see src/ui/rb.js and src/ui/rohan/).
import { World, MIN_PER_DAY, REVIEW_MINUTE, MODE, ECON } from '../sim/world.js';
import { Harness, TRUST, describe } from '../agent/harness.js';
import { ruleBrain } from '../agent/rule-brain.js';
import { makeClaudeBrain, CLAUDE_MODELS, explainError } from '../agent/claude-brain.js';
import { engineerReview, engineerAfterDescale, runStrategy, summarize, STRATEGIES } from '../strategies.js';
import { drawChart } from './charts.js';
import { plantSvg, updatePlant } from './plant.js';
import * as rb from './rb.js';

const { el } = rb;
const $ = (id) => document.getElementById(id);
const DAYS = 90;
const WINDOW = 3 * MIN_PER_DAY;
const TS = '\u202F'; // narrow no-break space before a unit
const STRAT_COLOR = { none: '--line-strong', engineer: '--ink', agent: '--agent' };
const STRAT_SW = { none: 'sw-strong', engineer: 'sw-ink', agent: 'sw-agent' };
const LOOP_HINT = {
  none: 'The autopilot keeps its day-one model, sensor correction and target for ever.',
  engineer: 'A generous review: perfect diagnosis, sensor recalibrated, element descaled when needed, model updated, operators back on the autopilot.',
  agent: 'Every morning at 06:00 the agent reviews yesterday with four read-only tools and tests each idea on a digital twin. The harness checks it again and decides what goes live.',
};
const TOOL_TITLE = {
  get_daily_report: 'Read yesterday from the historian',
  check_sensor: 'Compared the sensor with handheld readings',
  identify_model: 'Re-identified the heater model from an energy balance',
  backtest_change: 'Tested a change on the digital twin',
};
const SOURCES = {
  get_daily_report: { label: 'historian/last-24h', detail: 'temperatures, heater power, alarms' },
  check_sensor: { label: 'handheld-readings/7d', detail: 'operators’ daily thermometer checks' },
  identify_model: { label: 'energy-balance/24h', detail: 'heater efficiency fit' },
  backtest_change: { label: 'digital-twin/replay-24h', detail: 'yesterday replayed with new settings' },
};

const state = {
  strategy: 'agent',
  trust: 'autopilot',
  brain: 'rules',
  model: CLAUDE_MODELS[0].id,
  apiKey: '',
  engineerEvery: 30,
  speed: 1440,
  running: false,
  truth: true,
  pauseOnApproval: true,
  tab: 'live',
  world: null,
  harness: null,
  baseline: [],
  baseMinute: null,
  reviewing: false,
  ffwd: false,
  reviewedAt: -1,
  review: null,
  carry: 0,
  last: 0,
  dirty: true,
  evSeen: 0,
  dayGroups: new Map(),
  statKeys: {},
  modeShown: -1,
  compared: false,
  cmp: null,
};

// ------------------------------------------------------------------ formatting

const inr = (x) => `${x < 0 ? '−' : ''}₹${TS}${Math.round(Math.abs(x)).toLocaleString('en-IN')}`;
const grp = (x) => `${x < 0 ? '−' : ''}${Math.round(Math.abs(x)).toLocaleString('en-IN')}`;
const lakhAxis = (v) => `${Math.round(v / 1e5)}`;
const signed = (x, d) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const hhmm = (minute) => {
  const m = ((minute % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const brainLabel = () => (state.brain === 'rules' ? 'built-in rules' : CLAUDE_MODELS.find((m) => m.id === state.model)?.label || 'Claude');

function scenario() {
  return { fouling: $('sc-fouling').checked, drift: $('sc-drift').checked, winter: $('sc-winter').checked };
}
function seed() {
  const s = Math.round(Number(state.seedInput?.value));
  return Number.isFinite(s) && s > 0 ? s : 7;
}

// ------------------------------------------------------------------ setup and reset

function reset() {
  setRunning(false);
  const sc = scenario();
  state.world = new World({ seed: seed(), days: DAYS, scenario: sc });
  state.harness = null;
  state.reviewing = false;
  state.ffwd = false;
  state.reviewedAt = -1;
  state.review = null;
  state.evSeen = 0;
  state.dayGroups = new Map();
  state.modeShown = -1;
  $('activity').replaceChildren();
  ensureHarness();
  // the same plant, weather and demand with nobody looking after the autopilot, minute by minute
  const base = new World({ seed: seed(), days: DAYS, scenario: sc });
  const perMinute = new Float64Array(DAYS * MIN_PER_DAY + 1);
  while (!base.done) {
    base.stepMinute();
    const a = base.acc;
    perMinute[base.minute] = base.profit + a.value - a.energy - a.penalties - a.maintenance;
  }
  let cum = 0;
  state.baseline = [0, ...base.daily.map((d) => (cum += d.profit))];
  state.baseMinute = perMinute;
  state.compared = false;
  renderPanel();
  state.dirty = true;
}

function ensureHarness() {
  if (state.strategy !== 'agent') return;
  if (!state.harness) {
    const h = new Harness(state.world, { brain: currentBrain(), trust: state.trust, onEvent: (e) => { if (state.harness === h) onAudit(e); } });
    state.harness = h;
  } else {
    state.harness.brain = currentBrain();
    state.harness.trust = state.trust;
  }
}

function currentBrain() {
  if (state.brain === 'rules') return ruleBrain;
  return async (ctx) => {
    if (!state.apiKey.trim()) throw new Error('add your Anthropic API key under the outer-loop settings, or switch the brain to the built-in rules');
    const w = state.world;
    const brain = makeClaudeBrain({ apiKey: state.apiKey.trim(), model: state.model, onStep: (s) => { if (state.world === w) onThought(s.text); } });
    try {
      return await brain(ctx);
    } catch (err) {
      throw new Error(explainError(err));
    }
  };
}

// ------------------------------------------------------------------ simulation

/** Step one minute, unless the agent's 06:00 review is due first (then return 'review'). */
function stepOne(w) {
  if (w.minute % MIN_PER_DAY === REVIEW_MINUTE && w.minute > 0 && state.reviewedAt !== w.minute) {
    state.reviewedAt = w.minute;
    if (state.strategy === 'engineer') engineerReview(w, state.engineerEvery);
    if (state.strategy === 'agent') return 'review';
  }
  if (state.strategy === 'engineer') engineerAfterDescale(w);
  w.stepMinute();
  return null;
}

function advance(n) {
  const w = state.world;
  for (let k = 0; k < n && !w.done; k++) {
    if (stepOne(w) === 'review') {
      review();
      break;
    }
  }
  pullPlantEvents();
  if (w.done) {
    setRunning(false);
    addActivity(w.minute - 1, rb.badge('info', 'Run complete'), `End of the ${DAYS}-day run. Profit ${inr(w.profit)}; with no outer loop ${inr(state.baseline[DAYS])}.`);
  }
  state.dirty = true;
}

async function review() {
  const h = state.harness;
  const w = state.world;
  state.reviewing = true;
  const before = new Set(h.pending.map((p) => p.id));
  renderReview();
  await h.review();
  if (w !== state.world) return; // the plant was reset while the agent was thinking
  state.reviewing = false;
  if (state.review) state.review.running = false;
  pullPlantEvents();
  renderPanel();
  state.dirty = true;
  const fresh = h.pending.some((p) => !before.has(p.id));
  if (state.pauseOnApproval && fresh) {
    setRunning(false);
    for (const c of $('approvals').querySelectorAll('.rb-approval.is-pending')) c.classList.add('is-flash');
  }
}

/** Run straight to a given minute (used by "Run to next review" and by ?day= links). */
async function fastForward(to) {
  if (state.ffwd || state.reviewing) return;
  const w = state.world;
  state.ffwd = true;
  try {
    while (w.minute < to && !w.done && w === state.world) {
      if (stepOne(w) === 'review') await review();
    }
  } finally {
    state.ffwd = false;
  }
  pullPlantEvents();
  state.dirty = true;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = state.last ? Math.min(0.1, (now - state.last) / 1000) : 0;
  state.last = now;
  if (state.running && !state.reviewing && !state.ffwd && !state.world.done) {
    state.carry += state.speed * dt;
    const n = Math.floor(state.carry);
    state.carry -= n;
    if (n > 0) advance(n);
  }
  if (state.dirty && state.tab === 'live') render();
}

function setRunning(on) {
  state.running = on && !state.world?.done;
  state.carry = 0;
  const b = state.playBtn;
  if (b) b.replaceWith((state.playBtn = playButton()));
}

function playButton() {
  return rb.button(state.running ? 'Pause plant' : 'Run plant', { variant: 'primary', icon: state.running ? 'pause' : 'play', onClick: () => setRunning(!state.running) });
}

// ------------------------------------------------------------------ the agent's review, as a timeline

function callText(name, input = {}) {
  const args = Object.entries(input).map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}`);
  return `${name}(${args.join(', ')})`;
}

const CAND_TEXT = {
  target_temperature_c: (v) => `target ${v}${TS}°C`,
  model_efficiency: (v) => `model η ${v}`,
  sensor_offset_correction_c: (v) => `correction ${v}${TS}°C`,
  release_operator_reductions: (v) => (v ? 'operators back on the autopilot' : ''),
  descale: (v) => (v ? 'element descaled' : ''),
};

function toolSummary(name, input, r) {
  if (!r) return '';
  if (r.error) return r.error;
  switch (name) {
    case 'get_daily_report':
      return `Average ${r.measured_temperature_c.mean}${TS}°C ± ${r.measured_temperature_c.sd}, ${r.high_temperature_alarms} alarm${r.high_temperature_alarms === 1 ? '' : 's'}, full power ${r.heater.minutes_at_full_power_pct}${TS}% of the time, ${r.autopilot_mode === 'AUTO' ? 'autopilot on' : 'operators in manual'}${r.operator_setpoint_reduction_c ? `, setpoint cut by ${r.operator_setpoint_reduction_c}${TS}°C` : ''}.`;
    case 'check_sensor':
      return r.readings_compared < 3 ? cap(r.interpretation) + '.' : `Sensor minus handheld ${r.sensor_minus_handheld_last3_c}${TS}°C: ${r.interpretation}.`;
    case 'identify_model':
      return r.ok ? `Efficiency about ${r.heater_efficiency_estimate}; the model says ${r.controller_model_efficiency} (${signed(r.mismatch_pct, 1)}${TS}%).` : cap(r.reason) + '.';
    case 'backtest_change': {
      const what = Object.entries(input || {}).filter(([k]) => CAND_TEXT[k]).map(([k, v]) => CAND_TEXT[k](v)).filter(Boolean).join(', ') || 'no change';
      return `${cap(what)}: twin maximum ${r.candidate_settings.max_temp_c}${TS}°C, ${inr(r.candidate_settings.profit_inr_per_day)}/day against ${inr(r.current_settings.profit_inr_per_day)} now. ${r.verdict}.`;
    }
    default:
      return '';
  }
}

function step(s) {
  const r = state.review;
  if (!r) return;
  const now = performance.now();
  const d = now - r.tLast;
  r.tLast = now;
  r.steps.push({ duration: d >= 100 ? `${(d / 1000).toFixed(1)}${TS}s` : '', ...s });
}

function onThought(text) {
  step({ status: 'done', title: 'Reasoned about the evidence', detail: text.length > 600 ? `${text.slice(0, 600)}…` : text });
  renderReview();
}

function onAudit(e) {
  const inReview = state.reviewing && state.review?.running;
  switch (e.kind) {
    case 'review':
      state.review = { day: e.day, minute: e.minute, steps: [], message: null, running: true, tLast: performance.now(), open: false, tools: new Set(), brain: brainLabel(), error: null };
      break;
    case 'tool':
      state.review?.tools.add(e.text);
      step({ status: 'done', title: TOOL_TITLE[e.text] || e.text, tool: callText(e.text, e.data?.input), detail: toolSummary(e.text, e.data?.input, e.data?.result) });
      break;
    case 'monitor':
      step({ status: 'done', title: 'Checked yesterday’s automatic changes', detail: 'No harm in the 24 hours since: kept.' });
      addActivity(e.minute, rb.badge('success', 'Kept'), 'Yesterday’s automatic changes held up.');
      break;
    case 'rollback':
      if (inReview) step({ status: 'failed', title: 'Checked yesterday’s automatic changes', detail: e.text });
      addActivity(e.minute, rb.badge('danger', e.text.startsWith('Engineer undid') ? 'Undone' : 'Rolled back'), e.text);
      break;
    case 'summary':
      if (state.review) state.review.message = { text: e.text, confidence: e.data?.confidence, assumptions: e.data?.assumptions || [] };
      addActivity(e.minute, rb.badge('agent', 'Agent'), e.text);
      break;
    case 'twin-check':
      step({ status: /boiling/.test(e.text) ? 'failed' : 'done', title: 'Harness: independent twin check', detail: e.text.replace(/^Harness twin check of today's software changes: /, 'Result: ') });
      break;
    case 'rejected':
      if (inReview) step({ status: 'failed', title: 'Harness blocked a proposal', detail: e.text });
      addActivity(e.minute, rb.badge('danger', inReview ? 'Blocked' : 'Rejected'), e.text);
      break;
    case 'approval':
      step({ status: 'waiting', title: cap(describe(e.data)), detail: e.data?.rationale });
      addActivity(e.minute, rb.badge('pending', 'Needs you'), cap(describe(e.data)));
      break;
    case 'applied':
      if (inReview) step({ status: 'done', title: `Applied automatically: ${describe(e.data)}`, detail: 'Inside the approved envelope and passed the twin check.' });
      addActivity(e.minute, rb.badge('success', 'Applied'), e.text.replace(/^agent \(autopilot\) applied:/, 'Agent applied by policy:').replace(/^engineer applied:/, 'You approved:'));
      break;
    case 'decision':
      step({ status: 'done', title: 'No changes today' });
      break;
    case 'withdrawn':
      step({ status: 'done', title: 'Withdrew an out-of-date proposal', detail: e.text });
      addActivity(e.minute, rb.badge('neutral', 'Withdrawn'), e.text);
      break;
    case 'error':
      step({ status: 'failed', title: 'Review failed', detail: e.text });
      if (state.review) state.review.error = e.text;
      addActivity(e.minute, rb.badge('danger', 'Failed'), e.text);
      break;
    default:
      break;
  }
  if (state.reviewing) renderReview();
  else renderPanel();
}

// ------------------------------------------------------------------ the agent panel

function renderPanel() {
  renderNeeds();
  renderReview();
  renderMemory();
  renderTabs();
}

function changeFor(p, from) {
  const w = state.world;
  const cfg = w.ctrl.cfg;
  switch (p.kind) {
    case 'target_temperature':
      return { title: `Change the target temperature to ${p.value.toFixed(1)}${TS}°C`, risk: p.value > (from ?? cfg.setpoint) ? 'medium' : 'low',
        changes: [{ field: 'Target temperature (°C)', from: (from ?? cfg.setpoint).toFixed(1), to: p.value.toFixed(1) }] };
    case 'model_efficiency':
      return { title: 'Update the autopilot’s heater model', risk: 'low',
        changes: [{ field: 'Heating efficiency in the model', from: (from ?? cfg.etaModel).toFixed(3), to: p.value.toFixed(3) }] };
    case 'sensor_offset':
      return { title: 'Correct the temperature sensor in software', risk: 'low',
        changes: [{ field: 'Sensor correction (°C)', from: signed(from ?? cfg.offset, 2), to: signed(p.value, 2) }] };
    case 'restore_autopilot':
      return { title: 'Return operators to the autopilot', risk: 'medium', approve: 'Approve return to autopilot',
        changes: [{ field: 'Operator setpoint cut (°C)', from: String(w.op.clamp), to: '0' }, { field: 'Control mode', from: w.op.manual ? 'Manual' : 'Auto', to: 'Auto' }],
        impact: 'Operators release their setpoint cuts and hand control back to the autopilot.' };
    case 'maintenance':
      return p.job === 'descale'
        ? { title: 'Raise a work order to descale the heating element', risk: 'medium', approve: 'Approve work order',
          changes: [{ field: 'Work order', from: 'None', to: 'Descale element' }, { field: 'Heater', from: 'Online', to: `Offline ${ECON.descaleHours}${TS}h at 10:00` }],
          impact: `Costs ${inr(ECON.descaleCost)} plus ${ECON.descaleHours} hours of lost production.` }
        : { title: 'Raise a work order to replace the temperature sensor', risk: 'low', approve: 'Approve work order',
          changes: [{ field: 'Work order', from: 'None', to: 'Replace sensor' }, { field: 'Sensor correction (°C)', from: signed(cfg.offset, 2), to: '+0.00' }],
          impact: `Costs ${inr(ECON.recalCost)}. The technician clears the software correction when the new sensor is fitted.` };
    default:
      return { title: describe(p), risk: 'medium', changes: [] };
  }
}

function renderNeeds() {
  const box = $('approvals');
  box.replaceChildren();
  const h = state.harness;
  const pending = h?.pending || [];
  const autos = h?.watch?.proposals || [];
  $('needs-count').replaceChildren(pending.length ? rb.badge('pending', `${pending.length} waiting`) : '');
  if (!h) {
    box.append(el('div', 'empty', state.strategy === 'engineer'
      ? 'The engineer applies changes directly at each review. Only the AI agent asks for approval.'
      : 'Nobody is looking after the autopilot, so nothing will ask for approval.'));
    return;
  }
  if (!pending.length && !autos.length) {
    box.append(el('div', 'empty', 'Nothing waiting. Maintenance, larger steps and anything outside the agent’s envelope will appear here for you.'));
    return;
  }
  for (const p of pending) {
    const c = changeFor(p);
    const sw = p.kind !== 'maintenance' && p.kind !== 'restore_autopilot';
    const why = sw && state.trust === 'autopilot' && p.withinStep === false ? ' This is a bigger step than the agent may take on its own.' : '';
    box.append(rb.approvalCard({
      title: c.title,
      agent: 'Outer-loop agent',
      risk: c.risk,
      description: `${p.rationale || ''}${why}`,
      changes: c.changes,
      impact: c.impact || 'Goes live on the autopilot as soon as you approve it.',
      actions: [
        rb.button(state.trust === 'advisor' ? 'Apply change' : c.approve || 'Approve change', { variant: 'primary', icon: 'check', onClick: () => decide(p.id, 'approve') }),
        rb.button('Reject', { variant: 'ghost', onClick: () => decide(p.id, 'reject') }),
      ],
    }));
  }
  for (const p of autos) {
    const c = changeFor(p, p.from);
    box.append(rb.approvalCard({
      title: c.title,
      agent: 'Outer-loop agent',
      risk: c.risk,
      state: 'auto',
      changes: c.changes,
      impact: 'Live since 06:00. Tomorrow the harness compares alarms and control error with the day before and rolls back if they got worse.',
      decidedBy: 'By policy: bounded autopilot',
      actions: [rb.button('Undo change', { size: 'sm', onClick: () => { state.harness.undo(p.id); pullPlantEvents(); renderPanel(); state.dirty = true; } })],
    }));
  }
}

function decide(id, act) {
  if (!state.harness) return;
  if (act === 'approve') state.harness.approve(id);
  else state.harness.reject(id);
  pullPlantEvents();
  renderPanel();
  state.dirty = true;
}

function renderReview() {
  const box = $('review');
  const r = state.review;
  box.replaceChildren();
  $('review-meta').textContent = r ? `Day ${r.day}, ${hhmm(r.minute)}` : '';
  if (!r) {
    box.append(el('div', 'empty', state.strategy === 'agent'
      ? 'The agent reviews yesterday every morning at 06:00. Run the plant to see its first review.'
      : 'Daily reviews run only when the AI agent looks after the autopilot.'));
    return;
  }
  if (r.running) {
    box.append(el('div', 'reviewing', rb.icon('spinner', 16, { spin: true }), `Reviewing yesterday with ${r.brain}`));
    box.append(el('div', 'timeline-wrap', rb.timeline([...r.steps, { status: 'running', title: 'Working' }])));
    return;
  }
  const n = r.steps.length;
  const toggle = rb.button(r.open ? (n === 1 ? 'Hide the step' : 'Hide the steps') : n === 1 ? 'Show the step' : `Show the ${n} steps`, { variant: 'ghost', size: 'sm', onClick: () => { r.open = !r.open; renderReview(); } });
  if (r.message) {
    box.append(rb.agentMessage({
      agent: `Outer-loop agent · ${r.brain}`,
      time: `Day ${r.day}, ${hhmm(r.minute)}`,
      confidence: r.message.confidence,
      paragraphs: [r.message.text],
      assumptions: r.message.assumptions,
      sources: [...r.tools].map((t) => ({ ...SOURCES[t], onClick: () => { r.open = true; renderReview(); } })).filter((s) => s.label),
      actions: [toggle],
    }));
  } else {
    box.append(rb.alert('danger', 'The review did not finish', r.error || 'The autopilot keeps running on its current settings.', toggle));
  }
  if (r.open) box.append(el('div', 'timeline-wrap', rb.timeline(r.steps)));
}

function renderMemory() {
  const box = $('memory');
  box.replaceChildren();
  const mem = (state.harness?.memory || []).slice(-12).reverse();
  if (!mem.length) {
    box.append(el('div', 'empty', state.harness ? 'Nothing changed yet.' : 'The agent is not running.'));
    return;
  }
  const outcome = (m) => {
    const o = m.outcome;
    if (o === 'pending') return m.by.startsWith('agent') ? rb.badge('pending', 'Checked tomorrow') : rb.badge('success', 'Applied');
    if (o.startsWith('kept')) return rb.badge('success', 'Kept');
    if (o.startsWith('rolled back')) return rb.badge('danger', 'Rolled back');
    if (o.startsWith('undone')) return rb.badge('warning', 'Undone');
    if (o.startsWith('rejected')) return rb.badge('danger', 'Rejected');
    return rb.badge('neutral', o);
  };
  const by = { 'agent (autopilot)': 'Agent, by policy', engineer: 'You', 'engineer (simulated)': 'Engineer' };
  box.append(rb.dataTable([
    { key: 'day', label: 'Day', align: 'right', mono: true },
    { key: 'change', label: 'Change', render: (m) => el('div', null, el('div', null, cap(m.change)), el('div', 'hint', by[m.by] || m.by)) },
    { key: 'outcome', label: 'Outcome', render: outcome },
  ], mem));
}

function dayGroup(day) {
  let g = state.dayGroups.get(day);
  if (g) return g;
  g = { root: el('div'), list: el('div') };
  g.root.append(el('div', 'act-day', `Day ${day}`), g.list);
  const box = $('activity');
  // groups are kept newest first
  const later = [...state.dayGroups.entries()].filter(([d]) => d > day).sort((a, b) => a[0] - b[0])[0];
  if (later) later[1].root.after(g.root);
  else box.prepend(g.root);
  state.dayGroups.set(day, g);
  if (state.dayGroups.size > 40) {
    const oldest = Math.min(...state.dayGroups.keys());
    state.dayGroups.get(oldest).root.remove();
    state.dayGroups.delete(oldest);
  }
  return g;
}

function addActivity(minute, badgeEl, text) {
  const g = dayGroup(Math.floor(Math.max(0, minute) / MIN_PER_DAY));
  g.list.prepend(el('div', 'act-row', el('span', 'time', hhmm(minute)), badgeEl, el('span', 'txt', text)));
}

const PLANT_BADGE = {
  trip: () => rb.badge('danger', 'Boil trip'),
  operator: () => rb.badge('warning', 'Operators'),
  maintenance: () => rb.badge('info', 'Maintenance'),
  change: () => rb.badge('neutral', 'Engineer'),
};

function pullPlantEvents() {
  const ev = state.world.events;
  while (state.evSeen < ev.length) {
    const e = ev[state.evSeen++];
    // changes made through the harness are already logged, in the harness's own words
    if (e.kind === 'change' && /^(agent \(|engineer:|engineer \(simulated\))/.test(e.text)) continue;
    addActivity(e.minute, (PLANT_BADGE[e.kind] || PLANT_BADGE.change)(), e.text.replace(/^engineer \(monthly review\): /, 'Engineer review: '));
  }
}

// ------------------------------------------------------------------ live rendering

function outerText() {
  if (state.strategy === 'none') return 'Nobody · day-one settings';
  if (state.strategy === 'engineer') return `Engineer · every ${state.engineerEvery} days`;
  return `AI agent · daily · ${{ advisor: 'advisor', copilot: 'co-pilot', autopilot: 'bounded autopilot' }[state.trust]}`;
}

function modeRuns(h, i0, i1) {
  const out = [];
  let cur = null;
  for (let i = i0; i < i1; i++) {
    const m = h.mode[i];
    const kind = m === MODE.offline ? 'off' : m === MODE.manual || m === MODE.trip ? 'man' : null;
    if (cur && cur.kind === kind) cur.x1 = (i + 1) / MIN_PER_DAY;
    else {
      if (cur && cur.kind) out.push(cur);
      cur = { kind, x0: i / MIN_PER_DAY, x1: (i + 1) / MIN_PER_DAY };
    }
  }
  if (cur && cur.kind) out.push(cur);
  return out.map((r) => ({ x0: r.x0, x1: r.x1, color: r.kind === 'off' ? '--surface-sunken' : '--warning-soft' }));
}

function setStat(id, props) {
  const key = JSON.stringify(props);
  if (state.statKeys[id] === key) return;
  state.statKeys[id] = key;
  $(id).replaceWith(rb.stat({ ...props, id }));
}

function render() {
  state.dirty = false;
  const w = state.world;
  const h = w.hist;
  const now = w.minute;
  const last = Math.max(0, now - 1);

  state.clock.textContent = `Day ${Math.floor(w.day)} · ${hhmm(now)}${w.done ? ' · run complete' : ''}`;
  const mode = now ? h.mode[last] : MODE.auto;
  if (mode !== state.modeShown) {
    state.modeShown = mode;
    $('mode-badge').replaceChildren([rb.badge('success', 'Autopilot on'), rb.badge('danger', 'Manual'), rb.badge('danger', 'Boil trip'), rb.badge('neutral', 'Offline: descaling')][mode]);
  }

  const cfg = w.ctrl.cfg;
  updatePlant($('plant-svg'), {
    strategy: state.strategy, outerText: outerText(), truth: state.truth,
    T: w.plant.T, measured: now ? h.meas[last] : w.plant.T, Q: now ? h.Q[last] : 0, F: now ? h.F[last] : 0.15, Tin: now ? h.Tin[last] : 16,
    mode, eta: w.plant.eta(w.day), etaModel: cfg.etaModel, offset: cfg.offset, setpoint: cfg.setpoint, clamp: w.op.clamp, manual: w.op.manual,
  });

  // stats
  const a = w.acc;
  const profit = w.profit + a.value - a.energy - a.penalties - a.maintenance;
  const gap = profit - state.baseMinute[now];
  setStat('st-profit', {
    label: 'Profit so far', value: inr(profit),
    trend: state.strategy !== 'none' && now >= MIN_PER_DAY ? { direction: gap >= 0 ? 'up' : 'down', label: `${inr(Math.abs(gap))} ${gap >= 0 ? 'more' : 'less'} than no outer loop`, tone: gap >= 0 ? 'success' : 'danger' } : undefined,
    caption: state.strategy === 'none' ? 'This run is the baseline' : undefined,
  });
  let sa = 0, sm = 0, n = 0;
  for (let i = Math.max(0, now - MIN_PER_DAY); i < now; i++) if (h.mode[i] !== MODE.offline) { sa += h.act[i]; sm += h.meas[i]; n++; }
  setStat('st-temp', state.truth
    ? { label: 'Actual water, last 24 h', value: n ? (sa / n).toFixed(1) : '–', unit: '°C', caption: n ? `The sensor says ${(sm / n).toFixed(1)}${TS}°C` : undefined }
    : { label: 'Sensor average, last 24 h', value: n ? (sm / n).toFixed(1) : '–', unit: '°C' });
  const alarms = w.totals.alarms + a.alarms;
  const trips = w.totals.trips + a.trips;
  setStat('st-alarms', { label: '99 °C alarms', value: String(alarms), caption: 'Operators take 2 °C off each time' });
  setStat('st-trips', { label: 'Boil trips', value: String(trips), caption: trips ? 'The safety system cut the heater' : 'The water has never boiled' });
  const manualH = w.daily.reduce((s, x) => s + (x.manualPct * 24) / 100, 0) + a.manual / 60;
  setStat('st-manual', { label: 'Time in manual', value: String(Math.round(manualH)), unit: 'h', caption: w.op.manual ? 'Operators are running it by hand' : 'The autopilot is in control' });

  // temperature, last 3 days
  const i1 = now;
  const i0 = Math.max(0, i1 - WINDOW);
  const x0 = i0 / MIN_PER_DAY;
  const xr = [x0, x0 + WINDOW / MIN_PER_DAY];
  let lo = 92;
  for (let i = i0; i < i1; i++) {
    if (h.mode[i] === MODE.offline) continue;
    lo = Math.min(lo, h.meas[i], state.truth ? h.act[i] : 99);
  }
  lo = Math.max(80, Math.floor(lo - 0.5));
  const vb = modeRuns(h, i0, i1);
  const xLabel = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? `day ${Math.round(v)}` : hhmm(Math.round(v * MIN_PER_DAY)));
  const minuteSeries = (arr, color, extra = {}) => ({ n: i1 - i0, x: (k) => (i0 + k) / MIN_PER_DAY, y: (k) => (h.mode[i0 + k] === MODE.offline ? NaN : arr[i0 + k]), color, ...extra });
  const series = [minuteSeries(h.sp, '--ink-muted', { dash: [5, 4], width: 1.3 }), minuteSeries(h.meas, '--primary', { width: 1.4 })];
  if (state.truth) series.push(minuteSeries(h.act, '--ink', { width: 1.3 }));
  drawChart($('c-temp'), {
    height: 208, x: xr, y: [lo, 101], xStep: 0.5, xLabel, yLabel: (v) => `${v}`,
    vbands: vb, bands: [{ y0: 99, y1: 101, color: '--danger-soft' }],
    hlines: [{ y: 99, color: '--danger', dash: [5, 3], label: '99 °C alarm', below: true }, { y: 100, color: '--danger', label: '100 °C boils', width: 1.6 }],
    series,
  });
  drawChart($('c-power'), {
    height: 128, x: xr, y: [0, 100], yStep: 30, xStep: 0.5, xLabel, yLabel: (v) => `${v}`,
    vbands: vb, hlines: [{ y: 90, color: '--line-strong', dash: [3, 3], label: 'full power', below: true }],
    series: [{ n: i1 - i0, x: (k) => (i0 + k) / MIN_PER_DAY, y: (k) => h.Q[i0 + k], color: '--ink-muted', width: 1.2 }],
  });

  // cumulative profit vs the same plant with no outer loop
  const runCum = [0];
  for (const x of w.daily) runCum.push(runCum[runCum.length - 1] + x.profit);
  const runX = runCum.map((_, i) => i);
  if (!w.done && now > 0) { runCum.push(profit); runX.push(w.day); }
  const hi = Math.max(...state.baseline, ...runCum, 1e5);
  const loP = Math.min(0, ...runCum, ...state.baseline);
  $('lg-run').className = `sw ${STRAT_SW[state.strategy]}`;
  drawChart($('c-profit'), {
    height: 152, x: [0, DAYS], y: [loP, hi * 1.05], xStep: 15, xLabel: (v) => `day ${v}`, yLabel: lakhAxis, yStep: 5e5,
    series: [
      { n: state.baseline.length, x: (i) => i, y: (i) => state.baseline[i], color: '--line-strong', dash: [5, 4], width: 1.5 },
      { n: runCum.length, x: (i) => runX[i], y: (i) => runCum[i], color: STRAT_COLOR[state.strategy], width: 2.4 },
    ],
    cursor: w.day,
  });

  // the autopilot's picture of the plant vs the truth (daily points + now)
  const pts = [{ x: 0, eta: 1, etaModel: 1, bias: 0, offset: 0 }];
  for (const x of w.daily) pts.push({ x: x.day + 1, eta: x.eta, etaModel: x.etaModel, bias: x.bias, offset: x.offset });
  if (!w.done && now > 0) pts.push({ x: w.day, eta: w.plant.eta(w.day), etaModel: cfg.etaModel, bias: w.plant.bias(w.day), offset: cfg.offset });
  const etaLo = Math.min(0.8, ...pts.map((p) => Math.min(state.truth ? p.eta : 1, p.etaModel))) - 0.03;
  const etaSeries = [{ n: pts.length, x: (i) => pts[i].x, y: (i) => pts[i].etaModel, color: '--primary', width: 2 }];
  if (state.truth) etaSeries.push({ n: pts.length, x: (i) => pts[i].x, y: (i) => pts[i].eta, color: '--ink', dash: [5, 4], width: 1.5 });
  drawChart($('c-eta'), { height: 128, x: [0, DAYS], y: [etaLo, 1.05], xStep: 30, xLabel: (v) => `day ${v}`, yLabel: (v) => v.toFixed(2), series: etaSeries, cursor: w.day });
  const sVals = pts.flatMap((p) => (state.truth ? [p.bias, p.offset, p.bias + p.offset] : [p.offset]));
  const sSeries = [{ n: pts.length, x: (i) => pts[i].x, y: (i) => pts[i].offset, color: '--primary', width: 2 }];
  if (state.truth) {
    sSeries.unshift({ n: pts.length, x: (i) => pts[i].x, y: (i) => pts[i].bias, color: '--ink', dash: [5, 4], width: 1.5 });
    sSeries.push({ n: pts.length, x: (i) => pts[i].x, y: (i) => pts[i].bias + pts[i].offset, color: '--danger', width: 2 });
  }
  drawChart($('c-sensor'), {
    height: 128, x: [0, DAYS], y: [Math.min(-1, ...sVals) - 0.3, Math.max(1, ...sVals) + 0.3], xStep: 30, xLabel: (v) => `day ${v}`, yLabel: (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0'),
    hlines: [{ y: 0, color: '--line-strong' }], series: sSeries, cursor: w.day,
  });
}

// ------------------------------------------------------------------ controls

function renderSettings() {
  const box = $('loop-settings');
  box.replaceChildren();
  const who = rb.select({
    label: 'Who looks after the autopilot', value: state.strategy, hint: LOOP_HINT[state.strategy],
    options: [{ value: 'none', label: 'Nobody: day-one settings' }, { value: 'engineer', label: 'An engineer, every few weeks' }, { value: 'agent', label: 'An AI agent, every morning' }],
    onChange: (e) => { state.strategy = e.target.value; ensureHarness(); renderSettings(); renderPanel(); state.dirty = true; },
  });
  box.append(who.root);
  if (state.strategy === 'engineer') {
    box.append(rb.select({
      label: 'Review interval', value: state.engineerEvery,
      options: [15, 30, 60].map((d) => ({ value: d, label: `Every ${d} days` })),
      onChange: (e) => { state.engineerEvery = Number(e.target.value); state.dirty = true; },
    }).root);
  }
  if (state.strategy !== 'agent') return;
  box.append(rb.select({
    label: 'Agent brain', value: state.brain,
    options: [{ value: 'rules', label: 'Built-in rules (free, offline)' }, { value: 'claude', label: 'Claude (your API key)' }],
    hint: state.brain === 'rules' ? 'Deterministic rules that do what a good APC engineer does each morning.' : 'Claude gets the same tools and decides for itself what to check and propose.',
    onChange: (e) => { state.brain = e.target.value; ensureHarness(); renderSettings(); },
  }).root);
  box.append(rb.select({
    label: 'Trust level', value: state.trust, hint: TRUST[state.trust],
    options: [{ value: 'advisor', label: 'Advisor' }, { value: 'copilot', label: 'Co-pilot' }, { value: 'autopilot', label: 'Bounded autopilot' }],
    onChange: (e) => { state.trust = e.target.value; ensureHarness(); renderSettings(); renderPanel(); state.dirty = true; },
  }).root);
  const pause = el('input');
  pause.type = 'checkbox';
  pause.checked = state.pauseOnApproval;
  pause.addEventListener('change', () => { state.pauseOnApproval = pause.checked; });
  box.append(el('label', 'check', pause, 'Pause the plant when something needs you'));
  if (state.brain !== 'claude') return;
  const key = rb.textField({ label: 'Anthropic API key', type: 'password', value: state.apiKey, attrs: { placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: 'false' } });
  key.input.addEventListener('input', () => { state.apiKey = key.input.value; });
  const info = CLAUDE_MODELS.find((m) => m.id === state.model);
  const model = rb.select({
    label: 'Model', value: state.model,
    options: CLAUDE_MODELS.map((m) => ({ value: m.id, label: `${m.label} (${m.note})` })),
    onChange: (e) => { state.model = e.target.value; ensureHarness(); renderSettings(); },
  });
  box.append(key.root, model.root, rb.alert('info', 'Your key stays in this tab',
    `It is never saved and is sent only to api.anthropic.com. Use your own key on your own computer. Each daily review is one short agent run of 5–8 API calls.${info?.fallbacks ? ' Server-side fallbacks are on: if a request is declined, Anthropic retries it on a suitable model.' : ''}`));
  if (!state.apiKey) setTimeout(() => key.input.focus(), 0);
}

function renderTabs() {
  const pending = state.harness?.pending.length || 0;
  state.tabs.items[0].attention = pending > 0;
  state.tabs.items[0].count = pending || null;
  state.tabs.render(state.tab);
}

function showTab(name) {
  state.tab = name;
  renderTabs();
  for (const v of document.querySelectorAll('main > .view')) v.hidden = v.id !== `view-${name}`;
  if (name === 'live') state.dirty = true;
  if (name === 'compare') {
    if (!state.compared) runCompare();
    else if (state.cmp) drawCompare();
  }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('ols-theme', theme); } catch { /* private mode */ }
  const b = rb.button(theme === 'dark' ? 'Use light theme' : 'Use dark theme', { variant: 'ghost', size: 'sm', onClick: () => setTheme(theme === 'dark' ? 'light' : 'dark') });
  $('theme-slot').replaceChildren(b);
  state.dirty = true;
  if (state.cmp && state.tab === 'compare') drawCompare();
}

function wire() {
  $('plant-svg').innerHTML = plantSvg();
  state.tabs = rb.tabs([{ value: 'live', label: 'Live plant' }, { value: 'compare', label: 'Compare strategies' }, { value: 'how', label: 'How it works' }], 'live', showTab);
  $('tabs-slot').append(state.tabs.root);

  // run toolbar
  state.clock = el('span', 'clock', 'Day 0 · 00:00');
  state.playBtn = playButton();
  const speed = rb.select({
    label: 'Speed', value: state.speed,
    options: [[60, '1 hour per second'], [360, '6 hours per second'], [1440, '1 day per second'], [4320, '3 days per second'], [14400, '10 days per second']].map(([v, l]) => ({ value: v, label: l })),
    onChange: (e) => { state.speed = Number(e.target.value); },
  });
  const next = rb.button('Run to next review', { icon: 'skip', onClick: async () => {
    setRunning(false);
    const w = state.world;
    let to = Math.floor(w.minute / MIN_PER_DAY) * MIN_PER_DAY + REVIEW_MINUTE + 1;
    if (to <= w.minute) to += MIN_PER_DAY;
    await fastForward(to);
  } });
  const resetBtn = rb.button('Reset plant', { variant: 'ghost', icon: 'reset', onClick: reset });
  $('run-toolbar').append(state.clock, speed.root, state.playBtn, next, resetBtn);

  // stats placeholders
  for (const id of ['st-profit', 'st-temp', 'st-alarms', 'st-trips', 'st-manual']) {
    const s = el('div');
    s.id = id;
    $('stats').append(s);
  }

  // scenario
  const sd = rb.textField({ label: 'Seed', type: 'number', value: '7', hint: 'Same seed, same weather and demand', attrs: { min: '1', max: '9999' } });
  state.seedInput = sd.input;
  sd.input.addEventListener('change', reset);
  $('scenario-fields').append(sd.root);
  for (const id of ['sc-fouling', 'sc-drift', 'sc-winter']) $(id).addEventListener('change', reset);
  $('truth').addEventListener('change', (e) => { state.truth = e.target.checked; document.body.classList.toggle('no-truth', !state.truth); state.dirty = true; });

  // compare toolbar
  state.cmpEvery = rb.select({
    label: 'Engineer reviews', value: 30,
    options: [[15, 'Every 15 days'], [30, 'Every 30 days'], [60, 'Every 60 days'], [90, 'Never (90 days)']].map(([v, l]) => ({ value: v, label: l })),
    onChange: runCompare,
  });
  state.cmpBtn = rb.button('Run comparison', { variant: 'primary', onClick: runCompare });
  $('cmp-toolbar').append(state.cmpEvery.root, state.cmpBtn);
  $('cmp-note').append(rb.alert('info', 'How this comparison is run',
    'The same seed, weather, demand and sensor noise for all three, taken from the Live plant scenario. The agent uses the built-in brain at the bounded-autopilot trust level, and a simulated engineer approves its valid maintenance requests on the day.'));
  $('how-note').append(rb.alert('warning', 'A teaching model, not a design tool',
    'The numbers are realistic in shape but not calibrated to any real plant. The simulated engineer is deliberately generous; in real plants the gap between every few months and every day is usually wider.'));

  window.addEventListener('resize', () => { state.dirty = true; if (state.cmp && state.tab === 'compare') drawCompare(); });
}

// ------------------------------------------------------------------ compare

async function runCompare() {
  state.compared = true;
  const every = Number(state.cmpEvery.select.value);
  const btn = rb.button('Run comparison', { variant: 'primary', loading: true });
  state.cmpBtn.replaceWith(btn);
  state.cmpBtn = btn;
  await new Promise((r) => setTimeout(r, 30));
  const runs = {};
  for (const k of Object.keys(STRATEGIES)) runs[k] = await runStrategy(k, { seed: seed(), days: DAYS, scenario: scenario(), engineerEvery: every });
  state.cmp = { runs, every };
  const done = rb.button('Run comparison', { variant: 'primary', onClick: runCompare });
  state.cmpBtn.replaceWith(done);
  state.cmpBtn = done;
  drawCompare();
}

function label(k, every) {
  if (k === 'engineer') return every >= DAYS ? 'Engineer (never got to it)' : `Engineer every ${every} days`;
  return { none: 'Nobody', agent: 'AI agent every day' }[k];
}

function drawCompare() {
  const { runs, every } = state.cmp;
  const keys = Object.keys(runs);
  const sums = Object.fromEntries(keys.map((k) => [k, summarize(runs[k])]));
  const ag = sums.agent, no = sums.none, en = sums.engineer;
  const pct = (a, b) => `${a >= b ? '+' : '−'}${Math.abs((100 * (a - b)) / Math.abs(b || 1)).toFixed(1)}${TS}%`;
  const vsStat = (lbl, a, b) => ({
    label: lbl, value: inr(Math.abs(a - b)),
    trend: { direction: a >= b ? 'up' : 'down', label: `${pct(a, b)} ${a >= b ? 'more' : 'less'} profit`, tone: a >= b ? 'success' : 'danger' },
  });
  $('cmp-stats').replaceChildren(
    rb.stat({ label: 'AI agent, 90-day profit', value: inr(ag.profit), caption: `Average water ${ag.meanT}${TS}°C` }),
    rb.stat(vsStat('Agent against nobody', ag.profit, no.profit)),
    rb.stat(vsStat(`Agent against ${label('engineer', every).toLowerCase()}`, ag.profit, en.profit)),
    rb.stat({ label: 'Boil trips with the agent', value: String(ag.trips), caption: `99 °C alarms: ${ag.alarms} with the agent, ${en.alarms} with the engineer, ${no.alarms} with nobody` }),
  );

  const cums = {};
  for (const k of keys) {
    let c = 0;
    cums[k] = [0, ...runs[k].daily.map((d) => (c += d.profit))];
  }
  const hi = Math.max(...keys.map((k) => Math.max(...cums[k])));
  drawChart($('cmp-profit'), {
    height: 260, x: [0, DAYS], y: [0, hi * 1.05], xStep: 10, xLabel: (v) => `day ${v}`, yLabel: lakhAxis, yStep: 5e5,
    series: keys.map((k) => ({ n: cums[k].length, x: (i) => i, y: (i) => cums[k][i], color: STRAT_COLOR[k], width: 2.4 })),
  });
  $('cmp-legend').replaceChildren(...keys.map((k) => el('span', null, el('i', `sw ${STRAT_SW[k]}`), label(k, every))));

  // where the water actually was: share of online minutes per 0.25 °C bin
  const B0 = 86, B1 = 100.5, BW = 0.25;
  const nb = Math.round((B1 - B0) / BW);
  const hists = {};
  let top = 0;
  for (const k of keys) {
    const h = runs[k].hist;
    const bins = new Float64Array(nb);
    let n = 0;
    for (let i = 0; i < h.act.length; i++) {
      if (h.mode[i] === MODE.offline) continue;
      n++;
      const b = Math.floor((h.act[i] - B0) / BW);
      if (b >= 0 && b < nb) bins[b]++;
    }
    for (let b = 0; b < nb; b++) bins[b] = (100 * bins[b]) / Math.max(1, n);
    hists[k] = bins;
    top = Math.max(top, ...bins);
  }
  drawChart($('cmp-hist'), {
    height: 260, x: [B0, B1], y: [0, top * 1.1], xStep: 2, xLabel: (v) => `${v}${TS}°C`, yLabel: (v) => `${v}`,
    vbands: [{ x0: 99, x1: B1, color: '--danger-soft' }, { x0: 99, x1: 99.04, color: '--danger' }, { x0: 99.97, x1: 100.03, color: '--danger' }],
    series: keys.map((k) => ({ n: nb * 2, x: (i) => B0 + (Math.floor(i / 2) + (i % 2)) * BW, y: (i) => hists[k][Math.floor(i / 2)], color: STRAT_COLOR[k], width: 2 })),
  });

  const best = keys.reduce((b, k) => (sums[k].profit > sums[b].profit ? k : b), keys[0]);
  const rows = keys.map((k) => ({ id: k, ...sums[k], _selected: k === best }));
  $('cmp-table').replaceChildren(rb.dataTable([
    { key: 'name', label: 'Outer loop', render: (r) => el('span', 'name-cell', el('i', `sw ${STRAT_SW[r.id]}`), label(r.id, every), r.id === best ? rb.badge('success', 'Highest profit') : null) },
    { key: 'profit', label: 'Profit (₹)', align: 'right', mono: true, render: (r) => grp(r.profit) },
    { key: 'value', label: 'Value of hot water (₹)', align: 'right', mono: true, render: (r) => grp(r.value) },
    { key: 'energy', label: 'Electricity (₹)', align: 'right', mono: true, render: (r) => grp(r.energy) },
    { key: 'maintenance', label: 'Maintenance (₹)', align: 'right', mono: true, render: (r) => grp(r.maintenance) },
    { key: 'penalties', label: 'Trip penalties (₹)', align: 'right', mono: true, render: (r) => grp(r.penalties) },
    { key: 'alarms', label: '99 °C alarms', align: 'right', mono: true },
    { key: 'trips', label: 'Boil trips', align: 'right', mono: true },
    { key: 'manualDays', label: 'Manual (days)', align: 'right', mono: true, render: (r) => r.manualDays.toFixed(1) },
    { key: 'meanT', label: 'Average water (°C)', align: 'right', mono: true, render: (r) => r.meanT.toFixed(1) },
  ], rows, { density: 'default' }));
}

// ------------------------------------------------------------------ start

wire();
const q = new URLSearchParams(location.search);
let theme = q.get('theme');
if (!theme) { try { theme = localStorage.getItem('ols-theme'); } catch { theme = null; } }
setTheme(theme === 'dark' ? 'dark' : 'light');
if (q.has('seed')) state.seedInput.value = q.get('seed');
if (STRATEGIES[q.get('strategy')]) state.strategy = q.get('strategy');
if (TRUST[q.get('trust')]) state.trust = q.get('trust');
if (q.get('truth') === '0') { state.truth = false; $('truth').checked = false; document.body.classList.add('no-truth'); }
renderSettings();
reset();
requestAnimationFrame(frame);
if (q.has('day')) fastForward(Math.round(Number(q.get('day')) * MIN_PER_DAY)).then(() => {
  if (q.has('open') && state.review) { state.review.open = true; renderReview(); }
  state.dirty = true;
});
if (q.has('tab')) showTab(q.get('tab'));
