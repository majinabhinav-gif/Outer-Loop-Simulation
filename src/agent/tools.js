// The agent's tools. They only see what a real outer loop would see: the historian (raw sensor
// readings, heater power, flow, inlet temperature), the daily handheld-thermometer readings, the
// controller's configuration and the plant event log. Never the hidden truth (actual temperature,
// true efficiency, true sensor error).
import { P } from '../sim/plant.js';
import { MIN_PER_DAY, MODE } from '../sim/world.js';
import { simulateTwin } from './twin.js';

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const inr = (x) => `₹\u202F${Math.round(x).toLocaleString('en-IN')}`;

function windowRange(world, hours) {
  const end = world.minute;
  const start = Math.max(0, end - Math.round(hours * 60));
  return [start, end];
}

/** Yesterday's performance, as an engineer would pull it from the historian. */
export function getDailyReport(world, { hours = 24 } = {}) {
  const [s, e] = windowRange(world, hours);
  const h = world.hist;
  const off = world.ctrl.cfg.offset;
  let n = 0, sum = 0, sum2 = 0, max = -Infinity, errSum2 = 0, sat = 0, manual = 0, trip = 0, offline = 0, qSum = 0, restart = 0;
  let lastOff = -1e9;
  for (let m = Math.max(0, s - 240); m < s; m++) if (h.mode[m] === MODE.offline) lastOff = m;
  for (let m = s; m < e; m++) {
    const mode = h.mode[m];
    if (mode === MODE.offline) { offline++; lastOff = m; continue; }
    if (mode === MODE.manual) manual++;
    if (mode === MODE.trip) trip++;
    if (m - lastOff < 240) { restart++; continue; } // reheating after maintenance is not normal operation
    const t = h.raw[m] + off;
    n++; sum += t; sum2 += t * t; max = Math.max(max, t);
    errSum2 += (h.sp[m] - t) ** 2;
    qSum += h.Q[m];
    if (h.Q[m] >= P.Qmax - 1e-6) sat++;
  }
  const mean = n ? sum / n : 0;
  const since = s;
  const ev = world.events.filter((x) => x.minute >= since && x.minute < e);
  const last = world.daily[world.daily.length - 1];
  return {
    day: Math.floor(world.day),
    window_hours: hours,
    target_temperature_c: round(world.ctrl.cfg.setpoint, 1),
    operator_setpoint_reduction_c: world.op.clamp,
    autopilot_mode: world.op.manual ? 'MANUAL (operators took over)' : 'AUTO',
    measured_temperature_c: { mean: round(mean), sd: round(n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0), max: round(max) },
    control_error_rms_c: round(n ? Math.sqrt(errSum2 / n) : 0),
    heater: { mean_kw: round(n ? qSum / n : 0, 1), rating_kw: P.Qmax, minutes_at_full_power_pct: round(n ? (100 * sat) / n : 0, 1) },
    high_temperature_alarms: world.alarmLog.filter((t) => t >= s && t < e).length,
    alarms_last_7_days: world.alarmLog.filter((t) => t >= e - 7 * MIN_PER_DAY).length,
    days_since_last_alarm: world.alarmLog.length ? round((e - world.alarmLog[world.alarmLog.length - 1]) / MIN_PER_DAY, 1) : null,
    boil_trips: ev.filter((x) => x.kind === 'trip').length,
    minutes_in_manual: manual,
    minutes_offline: offline,
    minutes_reheating_after_maintenance_excluded: restart,
    profit_inr: last ? round(last.profit, 0) : null,
    controller_model: { heater_efficiency: round(world.ctrl.cfg.etaModel, 3), sensor_offset_correction_c: round(off, 2) },
    open_work_orders: world.jobs.filter((j) => !j.done).map((j) => j.job),
    plant_events: ev.map((x) => `${(x.minute / MIN_PER_DAY).toFixed(2)}d ${x.text}`).slice(-12),
  };
}

/** Compare the sensor (after the current software correction) with the daily handheld readings. */
export function checkSensor(world, { days = 7 } = {}) {
  const from = world.day - days;
  const off = world.ctrl.cfg.offset;
  const recal = world.workOrders.filter((w) => w.job === 'recalibrate').map((w) => w.minute / MIN_PER_DAY);
  const lastRecal = recal.length ? Math.max(...recal) : -1;
  const rows = world.refs.filter((r) => r.day >= from && r.minute / MIN_PER_DAY > lastRecal);
  const diffs = rows.map((r) => r.raw + off - r.ref);
  const n = diffs.length;
  const mean = n ? diffs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0.25;
  // the drift is gradual, so also report the most recent readings, which matter most
  const recent = diffs.slice(-3);
  const recentMean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  return {
    readings_compared: n,
    sensor_minus_handheld_mean_c: round(mean),
    sensor_minus_handheld_last3_c: round(recentMean),
    standard_error_c: round(sd / Math.sqrt(Math.max(1, n))),
    interpretation: n < 3 ? 'not enough handheld readings yet' :
      Math.abs(recentMean) < 0.4 ? 'sensor agrees with the handheld thermometer' :
      recentMean < 0 ? 'sensor reads LOW: the water is hotter than the controller thinks' :
      'sensor reads HIGH: the water is cooler than the controller thinks',
    current_offset_correction_c: round(off),
  };
}

/**
 * Re-identify the heater efficiency from the historian with an energy balance over 10-minute windows:
 *   M·cp·ΔT/Δt − F·cp·(Tin − T) + UA·(T − Tamb) = η·Q   → least squares for η.
 * `sensor_bias_c` (sensor minus truth, if known) corrects the temperature used in the loss terms.
 */
export function identifyModel(world, { hours = 24, sensor_bias_c = 0 } = {}) {
  const [s, e] = windowRange(world, hours);
  const h = world.hist;
  const off = world.ctrl.cfg.offset;
  const W = 10;
  let sxy = 0, sxx = 0, used = 0;
  const pts = [];
  for (let a = s; a + W < e; a += W) {
    let ok = true;
    for (let m = a; m <= a + W; m++) if (h.mode[m] === MODE.offline || h.mode[m] === MODE.trip) { ok = false; break; }
    if (!ok) continue;
    let F = 0, Tin = 0, Q = 0, T = 0;
    for (let m = a; m < a + W; m++) { F += h.F[m]; Tin += h.Tin[m]; Q += h.Q[m]; T += h.raw[m] + off - sensor_bias_c; }
    F /= W; Tin /= W; Q /= W; T /= W;
    if (Q < 5) continue;
    const t0 = (h.raw[a] + h.raw[a + 1]) / 2;
    const t1 = (h.raw[a + W - 1] + h.raw[a + W]) / 2;
    const dTdt = (t1 - t0) / ((W - 1) * 60);
    const y = P.M * P.cp * dTdt - F * P.cp * (Tin - T) + P.UA * (T - P.Tamb);
    sxy += y * Q; sxx += Q * Q; used++;
    pts.push([Q, y]);
  }
  if (used < 12) return { ok: false, reason: 'not enough steady operating data in the window', windows_used: used };
  const eta = sxy / sxx;
  const meanY = pts.reduce((acc, p) => acc + p[1], 0) / pts.length;
  const ssTot = pts.reduce((acc, p) => acc + (p[1] - meanY) ** 2, 0);
  const ssRes = pts.reduce((acc, p) => acc + (p[1] - eta * p[0]) ** 2, 0);
  const current = world.ctrl.cfg.etaModel;
  return {
    ok: true,
    heater_efficiency_estimate: round(eta, 3),
    controller_model_efficiency: round(current, 3),
    mismatch_pct: round((100 * (eta - current)) / current, 1),
    fit_r2: round(ssTot > 0 ? 1 - ssRes / ssTot : 1, 3),
    windows_used: used,
    physics_checks: {
      efficiency_between_0_5_and_1_05: eta >= 0.5 && eta <= 1.05,
      heat_balance_closes: ssTot > 0 ? ssRes / pts.length < 4 : true,
    },
    note: eta < 0.82 ? 'efficiency is low: scale on the heating element is likely limiting capacity' : 'efficiency looks normal',
  };
}

/**
 * Replay the last day's demand and weather on a digital twin, once with the current settings and once
 * with the candidate. `twin_efficiency` and `twin_sensor_bias_c` are the twin's beliefs about the plant
 * (normally the latest identify_model / check_sensor results).
 */
export function backtest(world, candidate = {}, { hours = 24, twin_efficiency, twin_sensor_bias_c = 0 } = {}) {
  const [s, e] = windowRange(world, hours);
  const eta = twin_efficiency ?? world.ctrl.cfg.etaModel;
  const cur = { etaModel: world.ctrl.cfg.etaModel, offset: world.ctrl.cfg.offset, setpoint: world.ctrl.cfg.setpoint - world.op.clamp, lambda: world.ctrl.cfg.lambda };
  const cand = {
    etaModel: candidate.model_efficiency ?? cur.etaModel,
    offset: candidate.sensor_offset_correction_c ?? cur.offset,
    setpoint: candidate.target_temperature_c ?? (candidate.release_operator_reductions ? world.ctrl.cfg.setpoint : cur.setpoint),
    lambda: cur.lambda,
  };
  const descaled = candidate.descale === true;
  const before = simulateTwin(world, s, e, cur, { eta, bias: twin_sensor_bias_c });
  const after = simulateTwin(world, s, e, cand, { eta: descaled ? 1.0 : eta, bias: twin_sensor_bias_c });
  return {
    window_hours: hours,
    twin_assumptions: { heater_efficiency: round(eta, 3), sensor_bias_c: round(twin_sensor_bias_c), descaled_in_candidate: descaled },
    current_settings: before,
    candidate_settings: after,
    verdict:
      after.minutes_above_99 > before.minutes_above_99 || after.max_temp_c >= 99 ? 'REJECT: raises the risk of boiling' :
      after.profit_inr_per_day + 75 < before.profit_inr_per_day && after.max_temp_c < before.max_temp_c - 0.2
        ? `PASS: safer (max ${after.max_temp_c} vs ${before.max_temp_c} °C), at a cost of ${inr(before.profit_inr_per_day - after.profit_inr_per_day)}/day` :
      after.profit_inr_per_day + 75 < before.profit_inr_per_day ? 'REJECT: loses money' :
      'PASS',
  };
}
