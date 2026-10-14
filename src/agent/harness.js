// The agent harness around the outer loop.
//
// The "brain" (built-in rules, or Claude) only reasons and proposes. Everything that keeps it safe is
// plain code here: which tools exist, hard bounds and step limits, an independent digital-twin check,
// who approves what (the trust ladder), deployment, next-day monitoring with automatic rollback, an
// audit trail and a memory of what worked. There is deliberately no tool that touches the safety
// system: the boil trip and the high-temperature alarm are outside the agent's reach.
import { getDailyReport, checkSensor, identifyModel, backtest } from './tools.js';
import { MIN_PER_DAY } from '../sim/world.js';

export const TRUST = {
  advisor: 'Advisor: the agent only recommends; an engineer applies changes by hand',
  copilot: 'Co-pilot: the agent prepares changes; an engineer approves each one',
  autopilot: 'Bounded autopilot: small software changes inside the approved envelope go live automatically; maintenance and anything larger still need an engineer',
};

// The envelope an engineer has signed off. Hard limits can never be crossed; a bigger step than
// allowed needs a human even in autopilot.
export const BOUNDS = {
  target_temperature: { min: 85, max: 97, step: 1.0, unit: '°C' },
  model_efficiency: { min: 0.5, max: 1.05, step: 0.15, relative: true, unit: '' },
  sensor_offset: { min: -3, max: 3, step: 1.5, unit: '°C' },
};

export const PROPOSAL_KINDS = ['target_temperature', 'model_efficiency', 'sensor_offset', 'restore_autopilot', 'maintenance'];
const SOFTWARE = new Set(['target_temperature', 'model_efficiency', 'sensor_offset']);

/** Tool definitions shared by every brain (the Claude brain sends these to the API). */
export const TOOL_DEFS = [
  {
    name: 'get_daily_report',
    description: 'Performance of the hot-water heater over the last 24 hours from the plant historian: measured temperature statistics (after the current sensor correction), control error, heater power and how often it hit full power, alarms, boil trips, manual-mode minutes, profit, the controller model, open work orders and recent plant events. Call this first.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'check_sensor',
    description: 'Compares the temperature sensor (after the current software offset correction) with the daily handheld-thermometer readings taken by operators. A negative difference means the sensor reads LOW, so the real water is hotter than the controller thinks - a boiling risk.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'identify_model',
    description: 'Re-estimates the heating efficiency from the last 24 hours of data with an energy balance, and compares it with the efficiency the autopilot currently assumes. Scale on the heating element lowers efficiency. Pass the latest sensor error so the estimate can correct for it.',
    input_schema: {
      type: 'object',
      properties: { sensor_bias_c: { type: 'number', description: 'Sensor (after correction) minus true temperature, from check_sensor; 0 if unknown.' } },
      required: ['sensor_bias_c'],
      additionalProperties: false,
    },
  },
  {
    name: 'backtest_change',
    description: 'Replays the last 24 hours of real demand and weather on a digital twin of the heater, with the current settings and with the candidate settings, and reports the predicted temperatures, minutes at or above 99 °C, and profit per day for both. Every proposal must be backtested. Omit any setting you are not changing.',
    input_schema: {
      type: 'object',
      properties: {
        model_efficiency: { type: 'number', description: 'Candidate efficiency for the autopilot model.' },
        sensor_offset_correction_c: { type: 'number', description: 'Candidate software correction added to the sensor reading (°C).' },
        target_temperature_c: { type: 'number', description: 'Candidate target temperature (°C).' },
        release_operator_reductions: { type: 'boolean', description: 'Assume operators go back to the autopilot at the full target.' },
        descale: { type: 'boolean', description: 'Assume the heating element has just been descaled (efficiency back to 1.0).' },
        twin_efficiency: { type: 'number', description: 'Heating efficiency the twin should assume (normally the identify_model estimate).' },
        twin_sensor_bias_c: { type: 'number', description: 'Sensor error the twin should assume (normally from check_sensor).' },
      },
      required: ['twin_efficiency', 'twin_sensor_bias_c'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_proposals',
    description: 'Ends today\'s review. Submit zero or more proposed changes with a short rationale each. The harness checks every proposal against the approved envelope and its own digital-twin test, then routes it for approval. Submitting no proposals is fine when the plant is healthy.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two or three sentences for the engineer, in the first person: what you found, what you propose and why, with the numbers that matter.' },
        confidence: { type: 'string', enum: ['High', 'Medium', 'Low'], description: 'How sure you are of the diagnosis. Low or Medium must be explained in assumptions.' },
        assumptions: { type: 'array', items: { type: 'string' }, description: 'What you assumed or could not check, one short sentence each.' },
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: PROPOSAL_KINDS },
              value: { type: 'number', description: 'New value for target_temperature (°C), model_efficiency, or sensor_offset (°C, the total correction, not a delta).' },
              job: { type: 'string', enum: ['descale', 'recalibrate'], description: 'For kind = maintenance.' },
              rationale: { type: 'string' },
            },
            required: ['kind', 'rationale'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'confidence', 'proposals'],
      additionalProperties: false,
    },
  },
];

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export class Harness {
  /**
   * @param world  the simulated plant
   * @param opts.brain  async ({ call, memory, pending, day }) => { summary, proposals }
   * @param opts.trust  'advisor' | 'copilot' | 'autopilot'
   * @param opts.simulatedEngineer  approve every valid proposal at once (for batch comparisons)
   */
  constructor(world, { brain, trust = 'copilot', simulatedEngineer = false, onEvent = () => {} } = {}) {
    this.world = world;
    this.brain = brain;
    this.trust = trust;
    this.simulatedEngineer = simulatedEngineer;
    this.onEvent = onEvent;
    this.audit = []; // every tool call, decision and change
    this.memory = []; // what was changed and what happened next
    this.pending = []; // proposals waiting for a human
    this.watch = null; // yesterday's automatic changes, kept for rollback
    this.nextId = 1;
    this.busy = false;
  }

  note(kind, text, data) {
    const entry = { day: Math.floor(this.world.day), minute: this.world.minute, kind, text, data };
    this.audit.push(entry);
    this.onEvent(entry);
    return entry;
  }

  /** The only way a brain can touch the plant: read-only tools plus submit_proposals. */
  callTool(name, input = {}) {
    const w = this.world;
    switch (name) {
      case 'get_daily_report': return getDailyReport(w);
      case 'check_sensor': return checkSensor(w);
      case 'identify_model': return identifyModel(w, { sensor_bias_c: Number(input.sensor_bias_c) || 0 });
      case 'backtest_change': {
        const { twin_efficiency, twin_sensor_bias_c, ...candidate } = input;
        return backtest(w, candidate, { twin_efficiency: Number(twin_efficiency), twin_sensor_bias_c: Number(twin_sensor_bias_c) || 0 });
      }
      default: return { error: `unknown tool ${name}` };
    }
  }

  /** The daily review at 06:00: monitor yesterday's changes, ask the brain, check and route its proposals. */
  async review() {
    if (this.busy) return;
    this.busy = true;
    try {
      const day = Math.floor(this.world.day);
      this.note('review', `Daily review, day ${day}`);
      this.monitor();
      const call = (name, input) => {
        const result = this.callTool(name, input);
        this.note('tool', name, { input, result });
        return result;
      };
      const out = await this.brain({ call, memory: this.memory.slice(-12), pending: this.pending.map(describe), day, trust: this.trust });
      this.note('summary', out.summary || '(no summary)', {
        confidence: ['High', 'Medium', 'Low'].includes(out.confidence) ? out.confidence : null,
        assumptions: Array.isArray(out.assumptions) ? out.assumptions.map(String).slice(0, 6) : [],
      });
      this.process(out.proposals || []);
    } catch (err) {
      this.note('error', `Review failed: ${String(err?.message || err).replace(/\.$/, '')}. The autopilot keeps running on its current settings.`);
    } finally {
      this.busy = false;
    }
  }

  /** Check each proposal against the envelope and the twin, then apply or queue it. */
  process(proposals) {
    const w = this.world;
    const cfg = w.ctrl.cfg;
    // the brain looks at the plant afresh every morning: yesterday's unapproved software changes are
    // out of date, and a request to restore the autopilot is moot once operators are back on it
    const today = Math.floor(w.day);
    const stale = this.pending.filter((q) => (SOFTWARE.has(q.kind) && q.day < today) ||
      (q.kind === 'restore_autopilot' && !w.op.manual && w.op.clamp === 0));
    if (stale.length) {
      this.pending = this.pending.filter((q) => !stale.includes(q));
      for (const q of stale) this.note('withdrawn', `Withdrawn: ${describe(q)} (superseded by today's review)`, q);
    }
    const checked = [];
    for (const raw of proposals.slice(0, 6)) {
      const p = { ...raw, id: this.nextId++, day: Math.floor(w.day) };
      const problem = this.validate(p, cfg);
      if (problem) {
        this.note('rejected', `${describe(p)}: blocked by guardrail (${problem})`, p);
        continue;
      }
      checked.push(p);
    }
    if (!checked.length) {
      this.note('decision', 'No changes today.');
      return;
    }

    // the harness's own physics check: it does not trust the brain's numbers
    const sensor = checkSensor(w);
    const bias = sensor.readings_compared >= 3 ? sensor.sensor_minus_handheld_last3_c : 0;
    const model = identifyModel(w, { sensor_bias_c: bias });
    const twin = { twin_efficiency: model.ok ? model.heater_efficiency_estimate : cfg.etaModel, twin_sensor_bias_c: bias };
    const soft = checked.filter((p) => SOFTWARE.has(p.kind) || p.kind === 'restore_autopilot');
    const cand = {};
    for (const p of soft) {
      if (p.kind === 'target_temperature') cand.target_temperature_c = p.value;
      if (p.kind === 'model_efficiency') cand.model_efficiency = p.value;
      if (p.kind === 'sensor_offset') cand.sensor_offset_correction_c = p.value;
      if (p.kind === 'restore_autopilot') cand.release_operator_reductions = true;
    }
    // Every software change is checked for boiling risk. Only a change of target temperature is an
    // economic bet, so only that is judged on profit: fixing a known measurement or model error is
    // always worth doing even when the truth turns out to be less profitable.
    let verdict = 'PASS';
    if (soft.length) {
      const bt = backtest(w, cand, twin);
      if (bt.verdict.includes('boiling')) {
        verdict = bt.verdict;
        for (const p of soft) this.note('rejected', `${describe(p)}: blocked, the twin predicts a boiling risk`, p);
        checked.splice(0, checked.length, ...checked.filter((p) => !soft.includes(p)));
      } else if ('target_temperature_c' in cand && cand.target_temperature_c > cfg.setpoint) {
        const { target_temperature_c, ...fidelity } = cand;
        const base = backtest(w, fidelity, twin);
        const gain = bt.candidate_settings.profit_inr_per_day - base.candidate_settings.profit_inr_per_day;
        if (gain < -75) verdict = `HOLD: the higher target loses ₹\u202F${Math.round(-gain).toLocaleString('en-IN')}/day on the twin`;
      }
      this.note('twin-check', `Harness twin check of today's software changes: ${verdict}`, bt);
    }

    const auto = [];
    for (const p of checked) {
      p.withinStep = this.withinStep(p, cfg);
      const canAuto = this.trust === 'autopilot' && SOFTWARE.has(p.kind) && p.withinStep && verdict === 'PASS';
      if (canAuto) auto.push(p);
      else if (this.simulatedEngineer && this.trust !== 'advisor') this.apply(p, 'engineer (simulated)');
      else this.queue(p);
    }
    if (auto.length) {
      const undos = auto.map((p) => this.apply(p, 'agent (autopilot)'));
      this.watch = { day: Math.floor(w.day), proposals: auto, undos, before: getDailyReport(w) };
    }
  }

  validate(p, cfg) {
    if (!PROPOSAL_KINDS.includes(p.kind)) return `unknown kind "${p.kind}"`;
    if (p.kind === 'maintenance') return ['descale', 'recalibrate'].includes(p.job) ? null : 'unknown maintenance job';
    if (p.kind === 'restore_autopilot') return null;
    const b = BOUNDS[p.kind];
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) return 'missing numeric value';
    if (p.value < b.min || p.value > b.max) return `outside the approved range ${b.min}–${b.max}${b.unit}`;
    const cur = { target_temperature: cfg.setpoint, model_efficiency: cfg.etaModel, sensor_offset: cfg.offset }[p.kind];
    if (Math.abs(p.value - cur) < 1e-9) return 'no change from the current value';
    return null;
  }

  withinStep(p, cfg) {
    const b = BOUNDS[p.kind];
    if (!b) return false;
    const cur = { target_temperature: cfg.setpoint, model_efficiency: cfg.etaModel, sensor_offset: cfg.offset }[p.kind];
    const step = Math.abs(p.value - cur);
    return b.relative ? step <= b.step * cur + 1e-9 : step <= b.step + 1e-9;
  }

  queue(p) {
    // a newer proposal of the same kind replaces an older one still waiting
    this.pending = this.pending.filter((q) => !(q.kind === p.kind && q.job === p.job));
    this.pending.push(p);
    this.note('approval', `Waiting for an engineer: ${describe(p)}`, p);
  }

  apply(p, by) {
    this.pending = this.pending.filter((q) => !(q.kind === p.kind && q.job === p.job)); // superseded
    const cfg = this.world.ctrl.cfg;
    p.from = { target_temperature: cfg.setpoint, model_efficiency: cfg.etaModel, sensor_offset: cfg.offset }[p.kind]; // for the record
    const change =
      p.kind === 'target_temperature' ? { type: 'setpoint', value: round(p.value, 2) } :
      p.kind === 'model_efficiency' ? { type: 'model', value: round(p.value, 3) } :
      p.kind === 'sensor_offset' ? { type: 'offset', value: round(p.value, 2) } :
      p.kind === 'restore_autopilot' ? { type: 'restore' } :
      { type: 'maintenance', job: p.job };
    const undo = this.world.apply(change, by);
    this.memory.push({ day: Math.floor(this.world.day), change: describe(p), by, outcome: 'pending' });
    this.note('applied', `${by} applied: ${describe(p)}`, p);
    return undo;
  }

  /** Engineer actions from the UI. */
  approve(id) {
    const p = this.pending.find((q) => q.id === id);
    if (!p) return;
    this.pending = this.pending.filter((q) => q.id !== id);
    this.apply(p, 'engineer');
  }

  /** Undo one of today's automatic changes before tomorrow's check (the engineer's override). */
  undo(id) {
    const wch = this.watch;
    const i = wch ? wch.proposals.findIndex((p) => p.id === id) : -1;
    if (i < 0) return false;
    const [p] = wch.proposals.splice(i, 1);
    const [undo] = wch.undos.splice(i, 1);
    undo();
    if (!wch.proposals.length) this.watch = null;
    const m = [...this.memory].reverse().find((x) => x.change === describe(p) && x.by === 'agent (autopilot)');
    if (m) m.outcome = 'undone by engineer';
    this.note('rollback', `Engineer undid: ${describe(p)}`, p);
    return true;
  }

  reject(id) {
    const p = this.pending.find((q) => q.id === id);
    if (!p) return;
    this.pending = this.pending.filter((q) => q.id !== id);
    this.memory.push({ day: Math.floor(this.world.day), change: describe(p), by: 'engineer', outcome: 'rejected by engineer' });
    this.note('rejected', `Engineer rejected: ${describe(p)}`, p);
  }

  /** Next morning: did yesterday's automatic changes help? If things got worse, put them back. */
  monitor() {
    const wch = this.watch;
    if (!wch) return;
    this.watch = null;
    const now = getDailyReport(this.world);
    const worse =
      now.boil_trips > wch.before.boil_trips ||
      now.high_temperature_alarms > wch.before.high_temperature_alarms ||
      now.control_error_rms_c > Math.max(0.3, 2 * wch.before.control_error_rms_c);
    const mem = this.memory.filter((m) => m.day === wch.day && m.by === 'agent (autopilot)');
    if (worse) {
      for (const undo of wch.undos.reverse()) undo();
      for (const m of mem) m.outcome = 'rolled back: performance got worse';
      this.note('rollback', `Monitoring: yesterday's automatic changes made things worse (alarms ${now.high_temperature_alarms}, trips ${now.boil_trips}, error ${now.control_error_rms_c} °C). Rolled back.`, now);
    } else {
      for (const m of mem) m.outcome = 'kept: no harm in the next 24 h';
      this.note('monitor', 'Monitoring: yesterday\'s automatic changes held up. Kept.', now);
    }
  }
}

export function describe(p) {
  switch (p.kind) {
    case 'target_temperature': return `set target temperature to ${p.value?.toFixed?.(1)} °C`;
    case 'model_efficiency': return `update autopilot model efficiency to ${p.value?.toFixed?.(3)}`;
    case 'sensor_offset': return `set sensor offset correction to ${p.value?.toFixed?.(2)} °C`;
    case 'restore_autopilot': return 'ask operators to return to the autopilot and release setpoint cuts';
    case 'maintenance': return p.job === 'descale' ? 'raise work order: descale the heating element' : 'raise work order: replace/recalibrate the temperature sensor';
    default: return p.kind;
  }
}

/** Helper for batch runs: step the world minute by minute, awaiting the review at 06:00 each day. */
export async function runWithHarness(world, harness, minutes = Infinity) {
  const end = Math.min(world.minute + minutes, world.days * MIN_PER_DAY);
  while (world.minute < end) {
    if (world.minute % MIN_PER_DAY === 360 && world.minute > 0) await harness.review();
    world.stepMinute();
  }
}
