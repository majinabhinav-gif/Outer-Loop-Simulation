// The inner loop: a model-based "autopilot" that runs every minute.
//
// It uses an internal model of the heater (its belief about the heating efficiency, `etaModel`) to
//   1. feed forward: compute the power needed for the current flow and inlet temperature, and
//   2. tune a PI loop (IMC rules) that trims away whatever the feedforward missed.
// When the real efficiency drifts away from `etaModel`, the feedforward under-delivers and the PI
// loop is tuned for the wrong plant: control gets sluggish, swings grow, and the plant has to be run
// further from its limit. Keeping that model right is the job of the outer loop.
import { P } from './plant.js';

export const DEFAULT_CONFIG = {
  etaModel: 1.0, // the controller's belief about heater efficiency
  offset: 0, // software correction added to the sensor reading (°C)
  setpoint: 95, // target temperature set by the outer loop (°C)
  lambda: 300, // desired closed-loop time constant (s)
};

export class Autopilot {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.integral = 0;
  }

  /** Power needed at steady state to hold `sp`, according to the controller's model. */
  feedforward(sp, F, Tin) {
    return (F * P.cp * (sp - Tin) + P.UA * (sp - P.Tamb)) / this.cfg.etaModel;
  }

  /**
   * One control move. `measured` is the raw sensor reading; `spEff` is the setpoint actually in force
   * (the target minus any operator reduction). Returns heater power in kW.
   */
  update(dt, measured, F, Tin, spEff) {
    const { etaModel, offset, lambda } = this.cfg;
    const T = measured + offset;
    const e = spEff - T;
    const denom = F * P.cp + P.UA;
    const K = etaModel / denom; // model gain, °C per kW
    const tau = (P.M * P.cp) / denom; // model time constant, s
    const Kc = tau / (K * lambda);
    const ff = this.feedforward(spEff, F, Tin);
    const unclamped = ff + Kc * (e + this.integral / tau);
    const Q = Math.min(P.Qmax, Math.max(0, unclamped));
    // anti-windup: only integrate when not pushing further into a limit
    if (!((Q >= P.Qmax && e > 0) || (Q <= 0 && e < 0))) this.integral += e * dt;
    this.integral = Math.max(-12 * tau, Math.min(12 * tau, this.integral));
    return Q;
  }

  reset() {
    this.integral = 0;
  }
}
