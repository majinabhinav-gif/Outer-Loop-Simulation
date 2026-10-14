// The live plant picture: outer loop → autopilot → heater, tank, sensor, safety system.
// Colours come from design-system tokens through CSS classes (see .plant in styles.css).
import { P } from '../sim/plant.js';

const T = '\u202F'; // narrow no-break space between a value and its unit

export function plantSvg() {
  return `
<svg class="plant s-agent" viewBox="0 0 420 352" role="img" aria-label="Hot-water heater with its control loops">
  <defs>
    <marker id="mk-primary" class="mk-primary" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>
    <marker id="mk-agent" class="mk-agent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"/></marker>
  </defs>

  <g class="loop-outer">
    <rect x="100" y="6" width="200" height="44" rx="8"/>
    <text class="over" x="200" y="22" text-anchor="middle">OUTER LOOP</text>
    <text x="200" y="39" text-anchor="middle" font-size="12" font-weight="500" id="pl-outer">AI agent · daily</text>
    <path d="M200 50 V76" marker-end="url(#mk-agent)"/>
  </g>
  <text x="208" y="67">tunes the settings</text>

  <g class="autopilot">
    <rect x="100" y="78" width="200" height="58" rx="8"/>
    <text class="over" x="200" y="94" text-anchor="middle">AUTOPILOT · INNER LOOP</text>
    <text x="200" y="111" text-anchor="middle" font-size="11.5" id="pl-ap1">target 95.0 °C</text>
    <text x="200" y="127" text-anchor="middle" id="pl-ap2">model η 1.000 · correction +0.00 °C</text>
  </g>

  <g class="ops">
    <circle cx="368" cy="90" r="9"/>
    <path d="M352 118 q16 -22 32 0"/>
  </g>
  <text x="368" y="133" text-anchor="middle">operators</text>
  <text x="368" y="147" text-anchor="middle" font-size="10.5" class="ok-text" id="pl-ops">trust it</text>

  <path class="signal" d="M300 107 H314 V204 H290" marker-start="url(#mk-primary)"/>
  <path class="signal" d="M100 107 H44 V296 H150" marker-end="url(#mk-primary)"/>
  <text x="50" y="160">heater</text>
  <text x="50" y="176" font-size="13" class="num" id="pl-q">45 kW</text>
  <text x="50" y="190" font-size="9.5" class="bad-text" id="pl-qfull"></text>

  <rect class="tank" x="150" y="168" width="120" height="152" rx="12"/>
  <rect class="water" id="pl-water" x="153" y="182" width="114" height="135" rx="10"/>
  <text x="210" y="200" text-anchor="middle" font-size="9.5" class="bad-text" id="pl-mode"></text>
  <text x="210" y="226" text-anchor="middle" id="pl-tl">actual water</text>
  <text x="210" y="252" text-anchor="middle" font-size="22" class="num" id="pl-t">95.0 °C</text>
  <path class="scale" id="pl-scale" d="M160 302 l10 -10 l10 10 l10 -10 l10 10 l10 -10 l10 10 l10 -10 l10 10 l10 -10 l10 10" opacity="0"/>
  <path class="element" id="pl-element" d="M160 302 l10 -10 l10 10 l10 -10 l10 10 l10 -10 l10 10 l10 -10 l10 10 l10 -10 l10 10"/>
  <text x="210" y="336" text-anchor="middle" id="pl-el">heating element</text>

  <g class="sensor">
    <circle cx="279" cy="204" r="9"/>
    <text x="279" y="207" text-anchor="middle">TT</text>
  </g>
  <text x="366" y="190" text-anchor="middle">sensor reads</text>
  <text x="366" y="207" text-anchor="middle" font-size="14" class="num" id="pl-s">95.0 °C</text>
  <text x="366" y="221" text-anchor="middle" class="bad-text" id="pl-se"></text>

  <path class="pipe" d="M0 246 H150"/>
  <text x="52" y="236" id="pl-in1">cold in 16.0 °C</text>
  <text x="52" y="262" id="pl-in2">9.0 L/min</text>
  <path class="pipe" d="M270 246 H420"/>
  <text x="416" y="262" text-anchor="end">hot water to the process</text>

  <g class="safety">
    <rect x="294" y="284" width="122" height="52" rx="4"/>
    <text class="over" x="355" y="300" text-anchor="middle">SAFETY SYSTEM</text>
    <text x="355" y="314" text-anchor="middle" font-size="9.5">99 °C alarm · 100 °C trip</text>
    <text x="355" y="328" text-anchor="middle" font-size="9.5">outside the AI&#8217;s reach</text>
  </g>
</svg>`;
}

const MODE_TEXT = ['', 'MANUAL', 'TRIP: HEATER CUT', 'DESCALING'];
const signed = (x, d) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;

export function updatePlant(root, s) {
  const $ = (id) => root.querySelector(`#${id}`);
  root.querySelector('svg').setAttribute('class', `plant s-${s.strategy}`);
  $('pl-outer').textContent = s.outerText;

  $('pl-ap1').textContent = s.clamp > 0
    ? `target ${s.setpoint.toFixed(1)} − ${s.clamp} = ${(s.setpoint - s.clamp).toFixed(1)}${T}°C`
    : `target ${s.setpoint.toFixed(1)}${T}°C`;
  $('pl-ap2').textContent = `model η ${s.etaModel.toFixed(3)} · correction ${signed(s.offset, 2)}${T}°C`;

  const ops = $('pl-ops');
  ops.textContent = s.manual ? 'took over: manual' : s.clamp > 0 ? `took ${s.clamp}${T}°C off` : 'trust it';
  ops.setAttribute('class', s.manual ? 'bad-text' : s.clamp > 0 ? 'amber-text' : 'ok-text');

  $('pl-q').textContent = `${s.Q.toFixed(0)}${T}kW`;
  $('pl-qfull').textContent = s.Q >= P.Qmax - 0.01 ? 'FULL POWER' : '';
  const t = s.truth ? s.T : s.measured;
  $('pl-water').setAttribute('class', `water${t >= 99 ? ' is-hot' : t >= 97.5 ? ' is-warm' : ''}`);
  $('pl-tl').textContent = s.truth ? 'actual water' : 'actual water: hidden';
  $('pl-t').textContent = s.truth ? `${s.T.toFixed(1)}${T}°C` : '?';
  $('pl-element').setAttribute('stroke-opacity', Math.max(0.25, Math.min(1, s.Q / P.Qmax)).toFixed(2));
  const scale = s.truth ? Math.max(0, Math.min(1, (1 - s.eta) / 0.4)) : 0;
  const sc = $('pl-scale');
  sc.setAttribute('opacity', scale > 0.02 ? '1' : '0');
  sc.setAttribute('stroke-width', (3 + 9 * scale).toFixed(1));
  $('pl-el').textContent = s.truth && s.eta < 0.995 ? `element efficiency ${(s.eta * 100).toFixed(0)}${T}% (scale)` : 'heating element';

  $('pl-s').textContent = `${s.measured.toFixed(1)}${T}°C`;
  const err = s.measured - s.T;
  $('pl-se').textContent = s.truth && Math.abs(err) >= 0.3 ? `reads ${Math.abs(err).toFixed(1)}${T}°C ${err > 0 ? 'high' : 'low'}` : '';
  $('pl-in1').textContent = `cold in ${s.Tin.toFixed(1)}${T}°C`;
  $('pl-in2').textContent = `${(s.F * 60).toFixed(1)}${T}L/min`;
  $('pl-mode').textContent = MODE_TEXT[s.mode] || '';
}
