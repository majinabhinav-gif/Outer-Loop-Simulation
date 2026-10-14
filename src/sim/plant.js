// The process: a continuously fed hot-water heater.
//
// Cold water flows in, an electric heating element warms it, hot water flows out to a downstream
// process that pays more the hotter the water is. The one rule: the water must never boil.
//
//   M·cp·dT/dt = F·cp·(Tin − T) + η·Q − UA·(T − Tamb)
//
// T    tank temperature (°C)            Q    heater power (kW)
// F    water flow (kg/s)                η    heating efficiency (1.0 when the element is clean)
// Tin  inlet water temperature (°C)     UA   heat loss to the room (kW/K)
//
// Three things slowly go wrong, as they do in real plants:
//   1. Limescale builds up on the element, so η falls (the controller's model goes stale).
//   2. The temperature sensor drifts and starts reading low (the plant runs hotter than it thinks).
//   3. Winter arrives: the inlet water gets colder, so more heat is needed.
import { mulberry32, gaussian } from './rng.js';

export const P = {
  M: 300, // kg of water in the tank
  cp: 4.186, // kJ/(kg·K)
  UA: 0.06, // kW/K
  Tamb: 20, // °C
  Qmax: 90, // kW heater rating
  Tboil: 100, // °C: boiling trips the heater (safety system)
  Talarm: 99, // °C: independent high-temperature switch, seen by operators
  Fbase: 0.15, // kg/s average demand (about 9 litres a minute)
};

export const DEFAULT_SCENARIO = {
  fouling: true,
  foulRate: 0.004, // efficiency lost per day of scale build-up
  drift: true,
  driftStart: 10, // day the sensor starts to drift
  driftRate: 0.12, // °C per day, reading low
  winter: true,
  demandSwing: 0.3, // ± share of the daily demand cycle
};

const MIN_PER_DAY = 1440;

/** Weather, demand and noise for the whole horizon, one value per minute. Independent of control. */
export function makeDisturbances(seed, days, scenario) {
  const n = days * MIN_PER_DAY;
  const rand = mulberry32(seed);
  const F = new Float64Array(n);
  const Fu = new Float64Array(n); // unmetered draw-off, as a fraction of F: the controller cannot see it
  const Tin = new Float64Array(n);
  const noise = new Float64Array(n);
  const refNoise = new Float64Array(days + 1);
  let ou = 0; // slow random wander in demand
  let un = 0;
  let step = 0; // occasional demand steps (a cleaning cycle, a second line starting...)
  let stepLeft = 0;
  for (let m = 0; m < n; m++) {
    const day = m / MIN_PER_DAY;
    const hour = (m % MIN_PER_DAY) / 60;
    ou += (-ou / 45 + 0.06 * Math.sqrt(2 / 45) * gaussian(rand)) * 1;
    if (stepLeft > 0) stepLeft--;
    else if (rand() < 1 / 480) {
      step = (rand() < 0.5 ? -1 : 1) * (0.06 + 0.08 * rand());
      stepLeft = 60 + Math.floor(rand() * 120);
    } else step = 0;
    const cycle = 1 + scenario.demandSwing * Math.sin((2 * Math.PI * (hour - 9)) / 24);
    F[m] = Math.max(0.05, P.Fbase * cycle * (1 + ou + step));
    un += -un / 20 + 0.06 * Math.sqrt(2 / 20) * gaussian(rand);
    Fu[m] = Math.max(-0.3, Math.min(0.4, un));
    const season = scenario.winter ? 16 - 6 * Math.min(1, day / 60) : 16;
    Tin[m] = season + 0.6 * Math.sin((2 * Math.PI * (hour - 15)) / 24) + 0.15 * gaussian(rand);
    noise[m] = 0.12 * gaussian(rand);
  }
  for (let d = 0; d <= days; d++) refNoise[d] = 0.25 * gaussian(rand);
  return { F, Fu, Tin, noise, refNoise, days };
}

export class Plant {
  constructor(scenario) {
    this.scn = scenario;
    this.T = 92; // actual water temperature
    this.lastDescaleDay = 0;
    this.lastRecalDay = 0;
  }

  /** Heating efficiency: falls as scale builds up on the element. */
  eta(day) {
    if (!this.scn.fouling) return 1;
    return Math.max(0.5, 1 - this.scn.foulRate * (day - this.lastDescaleDay));
  }

  /** Sensor error: after the drift starts, the sensor reads progressively lower than the truth. */
  bias(day) {
    if (!this.scn.drift) return 0;
    const from = Math.max(this.scn.driftStart, this.lastRecalDay);
    return day > from ? -this.scn.driftRate * (day - from) : 0;
  }

  step(dt, Q, F, Tin, day) {
    const eta = this.eta(day);
    const dTdt = (F * P.cp * (Tin - this.T) + eta * Q - P.UA * (this.T - P.Tamb)) / (P.M * P.cp);
    this.T += dTdt * dt;
  }
}
