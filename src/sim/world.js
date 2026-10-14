// The whole plant floor, minute by minute: process + autopilot + operators + economics + historian.
// Outer-loop strategies (none / engineer / AI agent) plug in through a daily review hook at 06:00.
import { P, DEFAULT_SCENARIO, Plant, makeDisturbances } from './plant.js';
import { Autopilot, DEFAULT_CONFIG } from './controller.js';

export const ECON = {
  valuePerKgDeg: 0.09, // ₹ per kg of water per °C above 60 °C (the downstream process pays for heat)
  baseTemp: 60,
  energyPrice: 9, // ₹ per kWh
  tripPenalty: 18750, // ₹ per boil trip (lost batch, inspection)
  descaleCost: 22500, // ₹ per descaling job
  descaleHours: 3, // hours offline while descaling
  recalCost: 6000, // ₹ per sensor replacement/recalibration
};

export const MIN_PER_DAY = 1440;
export const REVIEW_MINUTE = 360; // 06:00, when the outer loop looks at yesterday
const REF_MINUTE = 840; // 14:00, an operator checks the temperature with a handheld thermometer
const SUBSTEPS = 12; // 12 × 5 s per minute
const MODE = { auto: 0, manual: 1, trip: 2, offline: 3 };
export { MODE };

export class World {
  constructor({ seed = 7, days = 90, scenario = {}, config = {} } = {}) {
    this.seed = seed;
    this.days = days;
    this.scn = { ...DEFAULT_SCENARIO, ...scenario };
    this.dist = makeDisturbances(seed, days, this.scn);
    this.plant = new Plant(this.scn);
    this.ctrl = new Autopilot({ ...DEFAULT_CONFIG, ...config });
    this.minute = 0;
    this.op = { clamp: 0, manual: false, manualQ: 0, alarmMinutes: [], lastAdjust: -1e9 };
    this.tripUntil = -1;
    this.offlineUntil = -1;
    this.wasAlarm = false;
    this.jobs = []; // scheduled maintenance { job, at, by }
    this.workOrders = []; // history of maintenance done
    this.events = []; // plant-floor event log { minute, kind, text }
    this.alarmLog = []; // minute of every high-temperature alarm
    const n = days * MIN_PER_DAY;
    this.hist = {
      raw: new Float32Array(n), // raw sensor reading (what the DCS sees)
      meas: new Float32Array(n), // reading after the software correction (what the autopilot works with)
      act: new Float32Array(n), // true temperature (hidden from the outer loop)
      sp: new Float32Array(n), // setpoint in force
      Q: new Float32Array(n),
      F: new Float32Array(n),
      Tin: new Float32Array(n),
      mode: new Uint8Array(n),
    };
    this.refs = []; // handheld thermometer readings { day, minute, ref, raw }
    this.daily = []; // one summary per completed day
    this.acc = this.freshAcc();
    this.totals = { value: 0, energy: 0, penalties: 0, maintenance: 0, trips: 0, alarms: 0 };
  }

  freshAcc() {
    return { value: 0, energy: 0, penalties: 0, maintenance: 0, trips: 0, alarms: 0, sumT: 0, sumT2: 0, n: 0, sumSP: 0, sat: 0, manual: 0, online: 0 };
  }

  get day() {
    return this.minute / MIN_PER_DAY;
  }

  /** Setpoint actually in force: the outer loop's target minus whatever operators have taken off. */
  spEff() {
    return this.ctrl.cfg.setpoint - this.op.clamp;
  }

  log(kind, text) {
    this.events.push({ minute: this.minute, kind, text });
  }

  /** Advance the plant by `minutes`, calling `hooks.review(world)` at 06:00 each day. */
  advance(minutes, hooks = {}) {
    const end = Math.min(this.minute + minutes, this.days * MIN_PER_DAY);
    while (this.minute < end) {
      if (this.minute % MIN_PER_DAY === REVIEW_MINUTE && this.minute > 0 && hooks.review) hooks.review(this);
      this.stepMinute();
    }
  }

  stepMinute() {
    const m = this.minute;
    const day = m / MIN_PER_DAY;
    const { F: Fs, Tin: Tins, noise } = this.dist;
    const F = Fs[m];
    const Tin = Tins[m];
    this.runJobs(m);
    const offline = m < this.offlineUntil;
    const tripped = m < this.tripUntil;
    const raw = this.plant.T + this.plant.bias(day) + noise[m];
    const sp = this.spEff();
    let Q = 0;
    let mode = MODE.auto;
    if (offline) mode = MODE.offline;
    else if (tripped) mode = MODE.trip;
    else if (this.op.manual) {
      mode = MODE.manual;
      if (this.op.lastAdjust < 0) {
        // on taking over: dial in roughly what the controller would use for a cautious 88 °C
        this.op.manualQ = Math.min(P.Qmax, this.ctrl.feedforward(88, F, Tin));
        this.op.lastAdjust = m;
      } else if (m - this.op.lastAdjust >= 60) {
        // then nudge the heater by hand once an hour, going by the (possibly drifting) sensor
        const shown = raw + this.ctrl.cfg.offset;
        this.op.manualQ = Math.min(P.Qmax, Math.max(0, this.op.manualQ + 1.5 * (88 - shown)));
        this.op.lastAdjust = m;
      }
      Q = this.op.manualQ;
    } else {
      Q = this.ctrl.update(60, raw, F, Tin, sp);
    }

    if (offline) {
      this.plant.T = Math.max(this.plant.T - 0.2, 25); // drained for descaling
    } else {
      const Ftotal = F * (1 + this.dist.Fu[m]); // metered flow plus an unmetered draw-off
      for (let k = 0; k < SUBSTEPS; k++) {
        this.plant.step(60 / SUBSTEPS, Q, Ftotal, Tin, day);
        if (this.plant.T >= P.Tboil && m >= this.tripUntil) this.boilTrip(m);
        if (m < this.tripUntil) Q = 0;
      }
    }
    const T = this.plant.T;

    // operators watch an independent high-temperature switch (it does not drift)
    const alarm = !offline && T >= P.Talarm;
    if (alarm && !this.wasAlarm) this.onAlarm(m);
    this.wasAlarm = alarm;

    // economics
    const a = this.acc;
    if (!offline) {
      a.value += F * 60 * Math.max(0, T - ECON.baseTemp) * ECON.valuePerKgDeg;
      a.online++;
      a.sumT += T;
      a.sumT2 += T * T;
      a.n++;
      a.sumSP += sp;
      if (Q >= P.Qmax - 1e-6) a.sat++;
    }
    a.energy += Q * (60 / 3600) * ECON.energyPrice;
    if (mode === MODE.manual) a.manual++;

    // historian
    const h = this.hist;
    h.raw[m] = raw;
    h.meas[m] = raw + this.ctrl.cfg.offset;
    h.act[m] = T;
    h.sp[m] = sp;
    h.Q[m] = Q;
    h.F[m] = F;
    h.Tin[m] = Tin;
    h.mode[m] = mode;

    if (m % MIN_PER_DAY === REF_MINUTE && !offline) {
      const d = Math.floor(day);
      this.refs.push({ day: d, minute: m, ref: T + this.dist.refNoise[d], raw });
    }

    this.minute++;
    if (this.minute % MIN_PER_DAY === 0) this.closeDay();
  }

  boilTrip(m) {
    this.tripUntil = m + 30;
    this.acc.trips++;
    this.acc.penalties += ECON.tripPenalty;
    this.ctrl.reset();
    this.log('trip', 'Water reached 100 °C: safety system cut the heater for 30 min');
    if (!this.op.manual) {
      this.op.manual = true;
      this.op.lastAdjust = -1e9;
      this.log('operator', 'Operators lost trust after the boil trip and switched the autopilot to MANUAL');
    }
  }

  onAlarm(m) {
    this.acc.alarms++;
    this.alarmLog.push(m);
    this.op.alarmMinutes.push(m);
    this.op.alarmMinutes = this.op.alarmMinutes.filter((t) => m - t < MIN_PER_DAY);
    if (this.op.clamp < 8) {
      this.op.clamp += 2;
      this.log('operator', `High-temperature alarm: operators cut the setpoint by 2 °C (now ${this.spEff().toFixed(1)} °C)`);
    }
    if (!this.op.manual && this.op.alarmMinutes.length >= 3) {
      this.op.manual = true;
      this.op.lastAdjust = -1e9;
      this.log('operator', 'Third alarm in a day: operators switched the autopilot to MANUAL');
    }
  }

  runJobs(m) {
    for (const j of this.jobs) {
      if (j.done || m < j.at) continue;
      j.done = true;
      const day = m / MIN_PER_DAY;
      if (j.job === 'descale') {
        this.offlineUntil = m + ECON.descaleHours * 60;
        this.plant.lastDescaleDay = day + ECON.descaleHours / 24;
        this.acc.maintenance += ECON.descaleCost;
        this.ctrl.reset();
        this.workOrders.push({ minute: m, job: 'descale', by: j.by });
        this.log('maintenance', `Descaling the heating element (${ECON.descaleHours} h offline)`);
      } else if (j.job === 'recalibrate') {
        this.plant.lastRecalDay = day;
        this.ctrl.cfg.offset = 0; // the technician also clears the software correction
        this.acc.maintenance += ECON.recalCost;
        this.workOrders.push({ minute: m, job: 'recalibrate', by: j.by });
        this.log('maintenance', 'Temperature sensor replaced and calibrated; software offset cleared');
      }
    }
  }

  /** Book a maintenance job. Descaling happens at the next 10:00; a sensor swap within the hour. */
  schedule(job, by) {
    if (this.jobs.some((j) => !j.done && j.job === job)) return false;
    let at = this.minute + 60;
    if (job === 'descale') {
      const d = Math.floor(this.day);
      at = d * MIN_PER_DAY + 600;
      if (at <= this.minute) at += MIN_PER_DAY;
    }
    this.jobs.push({ job, at, by, done: false });
    return true;
  }

  /** Changes the outer loop may make. Returns a function that undoes the change. */
  apply(change, by = 'outer loop') {
    const c = this.ctrl.cfg;
    let undo = () => {};
    switch (change.type) {
      case 'model': {
        const prev = c.etaModel;
        c.etaModel = change.value;
        undo = () => { c.etaModel = prev; };
        this.log('change', `${by}: controller model efficiency ${prev.toFixed(3)} → ${change.value.toFixed(3)}`);
        break;
      }
      case 'offset': {
        const prev = c.offset;
        c.offset = change.value;
        undo = () => { c.offset = prev; };
        this.log('change', `${by}: sensor offset correction ${prev.toFixed(2)} → ${change.value.toFixed(2)} °C`);
        break;
      }
      case 'setpoint': {
        const prev = c.setpoint;
        c.setpoint = change.value;
        undo = () => { c.setpoint = prev; };
        this.log('change', `${by}: target temperature ${prev.toFixed(1)} → ${change.value.toFixed(1)} °C`);
        break;
      }
      case 'restore': {
        const prev = { ...this.op };
        this.op.clamp = 0;
        this.op.manual = false;
        this.op.alarmMinutes = [];
        this.ctrl.reset();
        undo = () => { Object.assign(this.op, prev); };
        this.log('change', `${by}: operators back on the autopilot, setpoint reductions released`);
        break;
      }
      case 'maintenance':
        this.schedule(change.job, by);
        this.log('change', `${by}: work order raised: ${change.job === 'descale' ? 'descale the heating element' : 'replace/recalibrate the temperature sensor'}`);
        break;
      default:
        throw new Error(`unknown change type ${change.type}`);
    }
    return undo;
  }

  closeDay() {
    const a = this.acc;
    const meanT = a.n ? a.sumT / a.n : 0;
    const sdT = a.n ? Math.sqrt(Math.max(0, a.sumT2 / a.n - meanT * meanT)) : 0;
    const d = this.daily.length;
    const profit = a.value - a.energy - a.penalties - a.maintenance;
    this.daily.push({
      day: d,
      value: a.value,
      energy: a.energy,
      penalties: a.penalties,
      maintenance: a.maintenance,
      profit,
      trips: a.trips,
      alarms: a.alarms,
      meanT,
      sdT,
      meanSP: a.n ? a.sumSP / a.n : 0,
      satPct: a.n ? (100 * a.sat) / a.n : 0,
      manualPct: (100 * a.manual) / MIN_PER_DAY,
      eta: this.plant.eta(d + 1),
      bias: this.plant.bias(d + 1),
      etaModel: this.ctrl.cfg.etaModel,
      offset: this.ctrl.cfg.offset,
      setpoint: this.ctrl.cfg.setpoint,
      clamp: this.op.clamp,
    });
    const t = this.totals;
    t.value += a.value;
    t.energy += a.energy;
    t.penalties += a.penalties;
    t.maintenance += a.maintenance;
    t.trips += a.trips;
    t.alarms += a.alarms;
    this.acc = this.freshAcc();
  }

  get profit() {
    const t = this.totals;
    return t.value - t.energy - t.penalties - t.maintenance;
  }

  get done() {
    return this.minute >= this.days * MIN_PER_DAY;
  }
}
