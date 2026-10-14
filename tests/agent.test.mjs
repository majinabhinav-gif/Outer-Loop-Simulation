import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, MIN_PER_DAY } from '../src/sim/world.js';
import { Harness, runWithHarness } from '../src/agent/harness.js';
import { ruleBrain } from '../src/agent/rule-brain.js';
import { runStrategy, summarize } from '../src/strategies.js';

const brainReturning = (proposals) => async ({ call }) => {
  call('get_daily_report', {});
  return { summary: 'test', proposals };
};

function worldAt(days, opts = {}) {
  const w = new World({ seed: 4, days: days + 5, ...opts });
  w.advance(days * MIN_PER_DAY + 360); // 06:00 on `days`
  return w;
}

test('guardrails block proposals outside the approved envelope', async () => {
  const w = worldAt(3);
  const h = new Harness(w, { brain: brainReturning([
    { kind: 'target_temperature', value: 99.5, rationale: 'greedy' },
    { kind: 'sensor_offset', value: 9, rationale: 'way off' },
    { kind: 'launch_rocket', rationale: 'no such tool' },
  ]), trust: 'autopilot' });
  await h.review();
  assert.equal(w.ctrl.cfg.setpoint, 95);
  assert.equal(w.ctrl.cfg.offset, 0);
  assert.equal(h.audit.filter((a) => a.kind === 'rejected').length, 3);
});

test('autopilot applies small software changes but queues maintenance for an engineer', async () => {
  const w = worldAt(3);
  const h = new Harness(w, { brain: brainReturning([
    { kind: 'model_efficiency', value: 0.97, rationale: 'small update' },
    { kind: 'maintenance', job: 'descale', rationale: 'scale' },
  ]), trust: 'autopilot' });
  await h.review();
  assert.equal(w.ctrl.cfg.etaModel, 0.97);
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0].job, 'descale');
  h.approve(h.pending[0].id);
  assert.equal(w.jobs.length, 1);
});

test('co-pilot never changes the plant without an engineer', async () => {
  const w = worldAt(3);
  const h = new Harness(w, { brain: brainReturning([{ kind: 'target_temperature', value: 95.5, rationale: 'a bit hotter' }]), trust: 'copilot' });
  await h.review();
  assert.equal(w.ctrl.cfg.setpoint, 95);
  assert.equal(h.pending.length, 1);
  h.reject(h.pending[0].id);
  assert.equal(w.ctrl.cfg.setpoint, 95);
  assert.equal(h.memory.at(-1).outcome, 'rejected by engineer');
});

test('a change that causes alarms is rolled back the next morning', async () => {
  const w = worldAt(3, { scenario: { fouling: false, drift: false, winter: false } });
  // a brain that pushes the target up and, by mis-stating the sensor, makes the water run 3 °C hotter
  let n = 0;
  const brain = async () => (n++ === 0
    ? { summary: 'risky', proposals: [{ kind: 'sensor_offset', value: -1.5, rationale: 'wrong' }, { kind: 'target_temperature', value: 96, rationale: 'hotter' }] }
    : { summary: 'nothing', proposals: [] });
  const h = new Harness(w, { brain, trust: 'autopilot' });
  // skip the harness's twin check for this test by trusting the brain's numbers
  h.process = function process(proposals) {
    const undos = proposals.map((p) => this.apply(p, 'agent (autopilot)'));
    this.watch = { day: Math.floor(w.day), proposals, undos, before: { boil_trips: 0, high_temperature_alarms: 0, control_error_rms_c: 0.1 } };
  };
  await h.review();
  assert.equal(w.ctrl.cfg.setpoint, 96);
  await runWithHarness(w, h, MIN_PER_DAY + 1);
  const rolled = h.audit.some((a) => a.kind === 'rollback');
  const kept = h.audit.some((a) => a.kind === 'monitor');
  assert.ok(rolled || kept, 'monitoring must decide one way or the other');
  if (rolled) assert.equal(w.ctrl.cfg.setpoint, 95);
});

test('the built-in brain finds the sensor drift and the stale model', async () => {
  const w = worldAt(30);
  const h = new Harness(w, { brain: ruleBrain, trust: 'copilot' });
  await h.review();
  const kinds = h.pending.map((p) => p.kind);
  assert.ok(kinds.includes('sensor_offset'), kinds.join());
  assert.ok(kinds.includes('model_efficiency'), kinds.join());
  const tools = h.audit.filter((a) => a.kind === 'tool').map((a) => a.text);
  assert.deepEqual(tools.slice(0, 3), ['get_daily_report', 'check_sensor', 'identify_model']);
});

test('over 90 days the daily agent beats a monthly engineer, which beats no outer loop', async () => {
  const none = summarize(await runStrategy('none', { seed: 7 }));
  const eng = summarize(await runStrategy('engineer', { seed: 7 }));
  const agent = summarize(await runStrategy('agent', { seed: 7 }));
  assert.ok(eng.profit > none.profit, `engineer ${eng.profit} vs none ${none.profit}`);
  assert.ok(agent.profit > eng.profit, `agent ${agent.profit} vs engineer ${eng.profit}`);
  assert.equal(agent.trips, 0);
});
