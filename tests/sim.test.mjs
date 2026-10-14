import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, MIN_PER_DAY } from '../src/sim/world.js';
import { checkSensor, identifyModel, getDailyReport, backtest } from '../src/agent/tools.js';

const clean = { fouling: false, drift: false, winter: false };

test('a clean, healthy plant holds the target without alarms', () => {
  const w = new World({ seed: 3, days: 5, scenario: clean });
  w.advance(5 * MIN_PER_DAY);
  for (const d of w.daily) {
    assert.ok(Math.abs(d.meanT - 95) < 0.3, `day ${d.day} mean ${d.meanT}`);
    assert.ok(d.sdT < 1.0, `day ${d.day} sd ${d.sdT}`);
  }
  assert.equal(w.totals.trips, 0);
  assert.ok(w.profit > 0);
});

test('a sensor that reads low makes the real water run hotter than the target', () => {
  const w = new World({ seed: 3, days: 40, scenario: { fouling: false, winter: false, drift: true } });
  w.advance(35 * MIN_PER_DAY);
  const d = w.daily[30];
  assert.ok(d.bias < -2, `bias ${d.bias}`);
  assert.ok(d.meanT > d.meanSP + 1.5, `actual ${d.meanT} vs setpoint ${d.meanSP}`);
});

test('check_sensor finds the drift from the handheld readings', () => {
  const w = new World({ seed: 5, days: 40, scenario: { fouling: false, winter: false } });
  w.advance(32 * MIN_PER_DAY);
  const s = checkSensor(w);
  const truth = w.plant.bias(w.day);
  assert.ok(s.readings_compared >= 5);
  assert.ok(Math.abs(s.sensor_minus_handheld_last3_c - truth) < 0.6, `estimate ${s.sensor_minus_handheld_last3_c}, truth ${truth}`);
  assert.match(s.interpretation, /LOW/);
});

test('identify_model recovers the true heating efficiency within a few percent', () => {
  const w = new World({ seed: 9, days: 50, scenario: { drift: false } });
  w.advance(45 * MIN_PER_DAY);
  const id = identifyModel(w, { sensor_bias_c: 0 });
  const truth = w.plant.eta(w.day - 0.5);
  assert.ok(id.ok);
  assert.ok(Math.abs(id.heater_efficiency_estimate - truth) / truth < 0.04, `estimate ${id.heater_efficiency_estimate}, truth ${truth}`);
  assert.ok(id.mismatch_pct < -10, 'controller model should be stale by day 45');
});

test('the daily report never exposes the hidden truth', () => {
  const w = new World({ seed: 1, days: 3 });
  w.advance(2 * MIN_PER_DAY);
  const text = JSON.stringify(getDailyReport(w));
  assert.ok(!/eta"|bias"|actual/i.test(text.replace('heater_efficiency', '')), text);
});

test('backtest flags a target that would boil the water', () => {
  const w = new World({ seed: 2, days: 3, scenario: clean });
  w.advance(2 * MIN_PER_DAY);
  const ok = backtest(w, { target_temperature_c: 96 }, { twin_efficiency: 1, twin_sensor_bias_c: 0 });
  const bad = backtest(w, { target_temperature_c: 99.5 }, { twin_efficiency: 1, twin_sensor_bias_c: 0 });
  assert.equal(ok.verdict, 'PASS');
  assert.match(bad.verdict, /boiling/);
});
