// Three ways to run the outer loop, compared on identical weather, demand and sensor noise.
import { World, MIN_PER_DAY } from './sim/world.js';
import { Harness, runWithHarness } from './agent/harness.js';
import { ruleBrain } from './agent/rule-brain.js';

export const STRATEGIES = {
  none: { label: 'No outer loop', short: 'Nobody maintains the autopilot' },
  engineer: { label: 'Engineer review', short: 'A full manual review every few weeks' },
  agent: { label: 'AI agent every day', short: 'Daily review by the agent harness' },
};

/**
 * The engineer's monthly review. Generous on purpose: a proper step test gives the true efficiency,
 * the sensor is recalibrated, the element is descaled if needed, operators are put back on the
 * autopilot and the target goes back to the standard 95 °C. The only handicap is frequency.
 */
export function engineerReview(world, everyDays = 30) {
  const day = Math.round(world.minute / MIN_PER_DAY);
  if (day === 0 || day % everyDays !== 0) return;
  const by = 'engineer (monthly review)';
  const trueEta = world.plant.eta(world.day);
  if (Math.abs(world.plant.bias(world.day)) > 0.3) world.apply({ type: 'maintenance', job: 'recalibrate' }, by);
  if (trueEta < 0.8) world.apply({ type: 'maintenance', job: 'descale' }, by);
  else world.apply({ type: 'model', value: Math.round(trueEta * 1000) / 1000 }, by);
  if (world.op.manual || world.op.clamp > 0) world.apply({ type: 'restore' }, by);
  if (world.ctrl.cfg.setpoint !== 95) world.apply({ type: 'setpoint', value: 95 }, by);
}

/** After a descale the efficiency is back to 1.0; the engineer resets the model when the job is done. */
export function engineerAfterDescale(world) {
  const last = world.workOrders[world.workOrders.length - 1];
  if (last && last.job === 'descale' && world.minute === last.minute + 180) world.ctrl.cfg.etaModel = 1.0;
}

/** Run one strategy headless for the whole horizon and return the world. */
export async function runStrategy(strategy, { seed = 7, days = 90, scenario = {}, brain = ruleBrain, trust = 'autopilot', engineerEvery = 30 } = {}) {
  const world = new World({ seed, days, scenario });
  if (strategy === 'none') {
    world.advance(days * MIN_PER_DAY);
  } else if (strategy === 'engineer') {
    while (!world.done) {
      if (world.minute % MIN_PER_DAY === 360) engineerReview(world, engineerEvery);
      engineerAfterDescale(world);
      world.stepMinute();
    }
  } else if (strategy === 'agent') {
    const harness = new Harness(world, { brain, trust, simulatedEngineer: true });
    world.harness = harness;
    await runWithHarness(world, harness);
  }
  return world;
}

export function summarize(world) {
  const t = world.totals;
  const days = world.daily;
  const meanT = days.reduce((a, d) => a + d.meanT, 0) / Math.max(1, days.length);
  const manualDays = days.reduce((a, d) => a + d.manualPct, 0) / 100;
  return {
    profit: Math.round(world.profit),
    value: Math.round(t.value),
    energy: Math.round(t.energy),
    penalties: Math.round(t.penalties),
    maintenance: Math.round(t.maintenance),
    trips: t.trips,
    alarms: t.alarms,
    meanT: Math.round(meanT * 10) / 10,
    manualDays: Math.round(manualDays * 10) / 10,
    workOrders: world.workOrders.length,
  };
}
