// Claude as the agent's brain (optional; bring your own Anthropic API key).
//
// Each morning Claude gets a fresh conversation: the plant description (system prompt), the harness's
// tools, and today's context (memory of past changes, pending approvals). It calls tools to diagnose
// the plant and finishes with submit_proposals. The harness then applies exactly the same guardrails,
// twin check and approval routing as for the built-in brain: Claude can propose, never act directly.
//
// The key stays in this browser tab and is sent only to api.anthropic.com. Calling the API straight
// from a browser exposes the key to anything running in the page, which is acceptable for a local
// demo with your own key, not for a deployed product (put a small server in between for that).
import { TOOL_DEFS, BOUNDS, TRUST } from './harness.js';
import { P } from '../sim/plant.js';
import { ECON } from '../sim/world.js';

const inr = (x) => `₹\u202F${Math.round(x).toLocaleString('en-IN')}`;
const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@0.134.0';
let sdk = null;
async function loadSdk() {
  if (!sdk) sdk = (await import(SDK_URL)).default;
  return sdk;
}

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'most capable', fallbacks: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'faster, cheaper', fallbacks: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'cheapest', fallbacks: false },
];

const MAX_STEPS = 12;

export const SYSTEM_PROMPT = `You are the outer-loop agent for a hot-water heater in a process plant. Every morning at 06:00 you review the last 24 hours and propose changes that keep the plant's advanced control ("the autopilot") at its best. An engineer and a harness of hard rules sit between you and the plant.

The plant
- A ${P.M} kg tank is fed with cold water and heated by a ${P.Qmax} kW electric element; hot water goes to a downstream process.
- Money is in Indian rupees. Hotter water is worth more: ₹ ${ECON.valuePerKgDeg} per kg per °C above ${ECON.baseTemp} °C (roughly ${inr(P.Fbase * 86400 * ECON.valuePerKgDeg)} per day per °C at average flow). Electricity costs ₹ ${ECON.energyPrice}/kWh.
- The water must never boil. At ${P.Talarm} °C an independent switch raises a high-temperature alarm: operators then cut the setpoint by 2 °C, and after three alarms in a day they switch the autopilot off. At ${P.Tboil} °C a safety system trips the heater for 30 minutes (${inr(ECON.tripPenalty)} penalty). You cannot change the safety system or the alarm.
- The autopilot is a model-based controller. Its model has one key parameter, the heating efficiency (1.0 for a clean element). It reads one temperature sensor; a software offset correction can be added to that reading.

What goes wrong over time
- Limescale lowers the heating efficiency. A stale model makes control sloppier, and scale wastes electricity (more power for the same heat); in winter it can leave the heater at full power and still too cold. Descaling costs ${inr(ECON.descaleCost)} plus ${ECON.descaleHours} hours offline.
- The temperature sensor drifts. Operators take a handheld thermometer reading every afternoon; check_sensor compares the two. If the sensor reads low, the water is hotter than the autopilot thinks, which is a boiling risk.
- Winter brings colder inlet water.

How to work
1. Call get_daily_report, then check_sensor, then identify_model (pass the sensor error from check_sensor as sensor_bias_c).
2. For every change you are considering, call backtest_change (set twin_efficiency to the identify_model estimate and twin_sensor_bias_c to the check_sensor error) and compare current vs candidate.
3. The twin cannot see everything (for example unmetered draw-offs), so also respect what the real plant did: keep the target at least three standard deviations of yesterday's measured temperature below ${P.Talarm} °C, back off after any alarm, and only move the target closer to the limit after a few calm days. Avoid changing the target back and forth.
4. A sensor_offset proposal is the TOTAL correction (current correction minus the sensor error), not a delta.
5. Propose descaling when the twin says the gain pays back the cost within a few weeks. Propose a sensor replacement when the software correction gets large (about 2 °C).
6. Only ask operators to return to the autopilot (restore_autopilot) when there is a fix or a calm day to justify it.
7. Finish by calling submit_proposals once: a short first-person summary, your confidence (High, Medium or Low) with the assumptions behind it, and zero or more proposals. Keep rationales to one or two sentences with the numbers that matter.

The approved envelope (the harness enforces it; proposals outside are blocked):
- target temperature ${BOUNDS.target_temperature.min}–${BOUNDS.target_temperature.max} °C, at most ${BOUNDS.target_temperature.step} °C change per day without an engineer
- model efficiency ${BOUNDS.model_efficiency.min}–${BOUNDS.model_efficiency.max}, at most ${BOUNDS.model_efficiency.step * 100}% change per day without an engineer
- sensor offset correction ${BOUNDS.sensor_offset.min} to ${BOUNDS.sensor_offset.max} °C, at most ${BOUNDS.sensor_offset.step} °C change per day without an engineer
- maintenance and restore_autopilot always need an engineer.`;

function kickoff({ day, memory, pending, trust }) {
  const mem = memory.length ? memory.map((m) => `- day ${m.day}: ${m.change} (${m.by}) → ${m.outcome}`).join('\n') : '- none yet';
  const pend = pending.length ? pending.map((p) => `- ${p}`).join('\n') : '- none';
  return `It is 06:00 on day ${day}. Trust level: ${TRUST[trust] || trust}.

Recent changes and what happened next:
${mem}

Proposals still waiting for an engineer:
${pend}

Run today's review.`;
}

/**
 * Returns a brain for the harness. `client` can be injected (tests); otherwise the official SDK is
 * loaded from a CDN and called directly from the browser with the user's key.
 */
export function makeClaudeBrain({ apiKey, model = 'claude-opus-5-5', client = null, onStep = () => {} } = {}) {
  const info = CLAUDE_MODELS.find((m) => m.id === model) || CLAUDE_MODELS[0];
  return async function claudeBrain(ctx) {
    let api = client;
    if (!api) {
      const Anthropic = await loadSdk();
      api = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    }
    const messages = [{ role: 'user', content: kickoff(ctx) }];
    for (let step = 0; step < MAX_STEPS; step++) {
      const params = {
        model: info.id,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFS,
        messages,
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
      };
      // Server-side fallback: if a request is declined, Anthropic retries it on a suitable model.
      const res = info.fallbacks
        ? await api.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : await api.messages.create(params);

      if (res.stop_reason === 'refusal') throw new Error('Claude declined this review');
      if (res.stop_reason === 'max_tokens') throw new Error('Claude\'s reply was cut off (max_tokens)');
      messages.push({ role: 'assistant', content: res.content });
      for (const b of res.content) if (b.type === 'text' && b.text.trim()) onStep({ kind: 'thought', text: b.text.trim() });
      if (res.stop_reason === 'pause_turn') continue;

      const uses = res.content.filter((b) => b.type === 'tool_use');
      if (!uses.length) {
        messages.push({ role: 'user', content: 'Please finish the review by calling submit_proposals (an empty list is fine).' });
        continue;
      }
      const submit = uses.find((u) => u.name === 'submit_proposals');
      if (submit) {
        const input = submit.input || {};
        return {
          summary: String(input.summary || ''),
          confidence: input.confidence,
          assumptions: Array.isArray(input.assumptions) ? input.assumptions : [],
          proposals: Array.isArray(input.proposals) ? input.proposals : [],
        };
      }
      const results = uses.map((u) => {
        try {
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(ctx.call(u.name, u.input || {})) };
        } catch (err) {
          return { type: 'tool_result', tool_use_id: u.id, content: `Tool failed: ${err.message}`, is_error: true };
        }
      });
      messages.push({ role: 'user', content: results }); // all results of a turn go back together
    }
    throw new Error(`the review did not finish within ${MAX_STEPS} steps`);
  };
}

/** Plain-language message for an API error, using the SDK's typed errors when it is loaded. */
export function explainError(err) {
  const A = sdk;
  if (A) {
    if (err instanceof A.AuthenticationError) return 'The API key was rejected. Check it and try again.';
    if (err instanceof A.PermissionDeniedError) return 'This API key is not allowed to use that model.';
    if (err instanceof A.NotFoundError) return 'Model not found. Pick another model.';
    if (err instanceof A.RateLimitError) return 'Rate limited by the API. Slow the simulation down or wait a minute.';
    if (err instanceof A.APIConnectionError) return 'Could not reach api.anthropic.com. Check your connection.';
    if (err instanceof A.APIError) return `API error ${err.status ?? ''}: ${err.message}`;
  }
  return err?.message || String(err);
}
