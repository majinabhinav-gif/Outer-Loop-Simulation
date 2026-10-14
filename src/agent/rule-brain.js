// The built-in brain: a deterministic version of what a good APC engineer does each morning.
// It uses exactly the same tools as the Claude brain and goes through the same harness checks.

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const inr = (x) => `₹\u202F${Math.round(x).toLocaleString('en-IN')}`;

export async function ruleBrain({ call }) {
  const report = call('get_daily_report', {});
  const sensor = call('check_sensor', {});
  const bias = sensor.readings_compared >= 3 ? sensor.sensor_minus_handheld_last3_c : 0;
  const model = call('identify_model', { sensor_bias_c: bias });
  const cfg = report.controller_model;
  const twin = { twin_efficiency: model.ok ? model.heater_efficiency_estimate : cfg.heater_efficiency, twin_sensor_bias_c: bias };
  const proposals = [];
  const found = [];
  const cand = {};

  // 1. Is the sensor telling the truth?
  if (sensor.readings_compared >= 3 && Math.abs(bias) >= 0.4) {
    const offset = Math.max(-3, Math.min(3, r2(cfg.sensor_offset_correction_c - bias)));
    cand.sensor_offset_correction_c = offset;
    proposals.push({ kind: 'sensor_offset', value: offset, rationale: `Sensor reads ${bias > 0 ? 'high' : 'low'} by ${Math.abs(bias).toFixed(2)} °C against the handheld thermometer; correct it in software.` });
    found.push(`sensor off by ${bias.toFixed(2)} °C`);
    if (Math.abs(offset) >= 2 && !report.open_work_orders.includes('recalibrate')) {
      proposals.push({ kind: 'maintenance', job: 'recalibrate', rationale: `Software correction has reached ${offset.toFixed(2)} °C; the sensor should be replaced or recalibrated.` });
    }
  }

  // 2. Does the autopilot's model still match the plant?
  if (model.ok && Math.abs(model.mismatch_pct) >= 4) {
    cand.model_efficiency = r3(model.heater_efficiency_estimate);
    proposals.push({ kind: 'model_efficiency', value: cand.model_efficiency, rationale: `Heating efficiency re-identified at ${model.heater_efficiency_estimate} vs ${cfg.heater_efficiency} in the model (${model.mismatch_pct}%); update the model so feedforward is right again.` });
    found.push(`model off by ${model.mismatch_pct}%`);
  }

  // 3. Is descaling worth it yet? Scale wastes electricity (more power for the same heat) and, in
  //    winter, caps capacity. Ask the twin what a clean element would earn per day.
  const eff = model.ok ? model.heater_efficiency_estimate : cfg.heater_efficiency;
  if (!report.open_work_orders.includes('descale') && eff < 0.95) {
    const bt = call('backtest_change', { descale: true, model_efficiency: 1.0, ...twin });
    const gain = bt.candidate_settings.profit_inr_per_day - bt.current_settings.profit_inr_per_day;
    const cost = 26250; // job cost plus about 3 h of lost production
    if (gain > 0 && cost / gain <= 20) {
      proposals.push({ kind: 'maintenance', job: 'descale', rationale: `Efficiency is down to ${eff}. The twin says a clean element would earn about ${inr(gain)}/day more (less electricity${report.heater.minutes_at_full_power_pct > 1 ? ', no more running out of power' : ''}), so the ${inr(cost)} job pays back in ${Math.ceil(cost / gain)} days.` });
      found.push(`descaling pays back in ${Math.ceil(cost / gain)} days`);
    }
  }

  // 4. Squeeze and shift: how close to boiling can the target safely sit? Use the swings the real
  //    plant showed yesterday (the twin cannot see everything, e.g. unmetered draw-offs): keep the
  //    target three standard deviations below the 99 °C alarm.
  const target = report.target_temperature_c;
  const sd = report.measured_temperature_c.sd;
  const safe = Math.min(97, Math.floor((99 - 0.3 - 3 * sd) * 2) / 2);
  const alarmed = report.high_temperature_alarms > 0;
  let newTarget = null;
  if (alarmed || target > safe + 0.25) newTarget = Math.max(88, Math.min(target - 0.5, safe));
  else if ((report.days_since_last_alarm ?? 99) >= 3 && safe >= target + 0.5) newTarget = target + 0.5;
  if (newTarget !== null) {
    const bt = call('backtest_change', { ...cand, target_temperature_c: newTarget, ...twin });
    if (newTarget < target) {
      cand.target_temperature_c = newTarget;
      proposals.push({ kind: 'target_temperature', value: newTarget, rationale: `${alarmed ? `${report.high_temperature_alarms} high-temperature alarm(s) yesterday` : 'Swings have grown'}: the temperature varies ±${sd} °C, so the target should sit at or below ${safe} °C. Back off to ${newTarget} °C.` });
      found.push('too close to the alarm');
    } else if (bt.verdict.startsWith('PASS') && bt.candidate_settings.max_temp_c <= 98.3) {
      cand.target_temperature_c = newTarget;
      proposals.push({ kind: 'target_temperature', value: newTarget, rationale: `No alarms for ${report.days_since_last_alarm ?? 'many'} days and swings of only ±${sd} °C: room to run hotter. Twin maximum at ${newTarget} °C is ${bt.candidate_settings.max_temp_c} °C (+${inr(bt.candidate_settings.profit_inr_per_day - bt.current_settings.profit_inr_per_day)}/day).` });
      found.push('room to move closer to the limit');
    }
  }

  // 5. Can operators trust the autopilot again? Only once there is a fix, or a calm day, to point to.
  const lostTrust = report.autopilot_mode !== 'AUTO' || report.operator_setpoint_reduction_c > 0;
  if (lostTrust) {
    found.push('operators have stepped in');
    const fixed = 'sensor_offset_correction_c' in cand || 'model_efficiency' in cand || 'target_temperature_c' in cand;
    if (fixed || !alarmed) {
      const bt = call('backtest_change', { ...cand, release_operator_reductions: true, ...twin });
      if (bt.verdict.startsWith('PASS')) {
        proposals.push({ kind: 'restore_autopilot', rationale: `With today's changes the twin keeps the water at most ${bt.candidate_settings.max_temp_c} °C on yesterday's demand; operators can go back to the autopilot.` });
      }
    }
  }

  const summary = found.length
    ? `I found: ${found.join('; ')}. I am proposing ${proposals.length} change${proposals.length === 1 ? '' : 's'}, each tested on the digital twin first.`
    : 'The plant is healthy: the sensor agrees with the handheld readings, the model matches and the heater has power to spare. I am not proposing any changes.';

  // How sure am I, and what did I have to assume?
  const assumptions = [];
  if (sensor.readings_compared < 3) assumptions.push('Fewer than three handheld readings so far, so I assumed the sensor is right.');
  else assumptions.push(`Sensor error taken from the last ${Math.min(3, sensor.readings_compared)} handheld readings, each good to about ±0.25 °C.`);
  if (!model.ok) assumptions.push('Not enough steady operation yesterday to re-identify the heater model; I kept the current one.');
  assumptions.push('The twin replays yesterday\'s demand and weather; it cannot see unmetered draw-offs.');
  const confidence = !model.ok || sensor.readings_compared < 3 ? 'Low' : model.fit_r2 >= 0.9 ? 'High' : 'Medium';
  if (confidence === 'Medium') assumptions.push(`The heat balance fit is loose (R² ${model.fit_r2}), so the efficiency estimate is approximate.`);
  return { summary, confidence, assumptions, proposals };
}
