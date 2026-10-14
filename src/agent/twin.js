// Digital twin: replays a window of recorded demand and inlet temperature through a model of the
// heater, with the autopilot running a given set of settings. Used to test a change before it is made.
import { P } from '../sim/plant.js';
import { Autopilot } from '../sim/controller.js';
import { ECON, MODE } from '../sim/world.js';

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * `settings`: { etaModel, offset, setpoint, lambda } for the twin's autopilot.
 * `belief.eta`: the twin's heater efficiency. `belief.bias`: sensor-plus-current-correction minus truth.
 */
export function simulateTwin(world, start, end, settings, belief) {
  const h = world.hist;
  const rawBias = belief.bias - world.ctrl.cfg.offset; // raw sensor minus truth
  const ctrl = new Autopilot(settings);
  let T = h.raw[start] - rawBias;
  let n = 0, sum = 0, sum2 = 0, max = -Infinity, hot = 0, value = 0, energy = 0;
  for (let m = start; m < end; m++) {
    if (h.mode[m] === MODE.offline) continue;
    const F = h.F[m];
    const Tin = h.Tin[m];
    const measured = T + rawBias;
    const Q = ctrl.update(60, measured, F, Tin, settings.setpoint);
    for (let k = 0; k < 12; k++) {
      T += ((F * P.cp * (Tin - T) + belief.eta * Q - P.UA * (T - P.Tamb)) / (P.M * P.cp)) * 5;
    }
    n++; sum += T; sum2 += T * T; max = Math.max(max, T);
    if (T >= P.Talarm) hot++;
    value += F * 60 * Math.max(0, T - ECON.baseTemp) * ECON.valuePerKgDeg;
    energy += Q * (60 / 3600) * ECON.energyPrice;
  }
  const mean = n ? sum / n : 0;
  const scale = n ? 1440 / n : 1;
  return {
    mean_temp_c: round(mean),
    sd_temp_c: round(n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0),
    max_temp_c: round(max),
    minutes_above_99: hot,
    profit_inr_per_day: round((value - energy) * scale, 0),
  };
}
