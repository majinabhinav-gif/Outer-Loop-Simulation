// A tiny canvas chart: lines (min/max envelope per pixel, so short spikes never disappear), bars,
// horizontal reference lines, shaded bands. No dependencies.
// Colours may be design tokens written as '--name' (resolved for the current light/dark theme).

const FONT = '11px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';

/** Resolve '--token' to its current value; pass any other colour through. */
export function tok(c) {
  return typeof c === 'string' && c.startsWith('--') ? getComputedStyle(document.documentElement).getPropertyValue(c).trim() : c;
}

function prepare(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, height);
  return { ctx, w, h: height };
}

function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

/**
 * opts: {
 *   height, x: [x0, x1], y: [y0, y1], xLabel(x), yLabel(y), xStep, yStep,
 *   bands:  [{ y0, y1, color }]                 horizontal shaded bands
 *   vbands: [{ x0, x1, color }]                 vertical shaded bands
 *   hlines: [{ y, color, dash, label }]
 *   series: [{ n, x(i), y(i), color, width, dash }]   y(i) = NaN breaks the line
 *   bars:   [{ x0, x1, y, color }]
 *   cursor: x                                   a vertical "now" line
 * }
 */
export function drawChart(canvas, opts) {
  const { ctx, w, h } = prepare(canvas, opts.height || 180);
  const pad = { l: 42, r: 10, t: 8, b: 20, ...(opts.pad || {}) };
  const [x0, x1] = opts.x;
  const [y0, y1] = opts.y;
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * pw;
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0 || 1)) * ph;

  ctx.font = FONT;
  ctx.textBaseline = 'middle';

  // grid + y axis labels
  const ys = opts.yStep || niceStep(y1 - y0, 4);
  ctx.strokeStyle = tok('--line');
  ctx.fillStyle = tok('--ink-subtle');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + 1e-9; v += ys) {
    const py = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(w - pad.r, py); ctx.stroke();
    ctx.fillText(opts.yLabel ? opts.yLabel(v) : String(Math.round(v * 100) / 100), pad.l - 5, py);
  }
  // x axis labels
  const xs = opts.xStep || niceStep(x1 - x0, Math.max(2, Math.floor(pw / 70)));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let v = Math.ceil(x0 / xs - 1e-9) * xs; v <= x1 + 1e-9; v += xs) {
    const t = opts.xLabel ? opts.xLabel(v) : String(Math.round(v * 100) / 100);
    const half = ctx.measureText(t).width / 2;
    const px = Math.min(w - 2 - half, Math.max(half + 2, X(v)));
    ctx.fillText(t, px, h - pad.b + 5);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, pw, ph);
  ctx.clip();

  for (const b of opts.vbands || []) {
    ctx.fillStyle = tok(b.color);
    ctx.fillRect(X(b.x0), pad.t, Math.max(1, X(b.x1) - X(b.x0)), ph);
  }
  for (const b of opts.bands || []) {
    ctx.fillStyle = tok(b.color);
    const top = Y(Math.min(b.y1, y1 + 1e6));
    ctx.fillRect(pad.l, top, pw, Y(b.y0) - top);
  }
  for (const b of opts.bars || []) {
    ctx.fillStyle = tok(b.color);
    const a = Y(Math.max(0, Math.min(y1, b.y)));
    const z = Y(Math.max(y0, 0));
    ctx.fillRect(X(b.x0) + 0.5, Math.min(a, z), Math.max(1, X(b.x1) - X(b.x0) - 1), Math.abs(z - a));
  }
  for (const l of opts.hlines || []) {
    ctx.strokeStyle = tok(l.color);
    ctx.lineWidth = l.width || 1.2;
    ctx.setLineDash(l.dash || []);
    const py = Math.round(Y(l.y)) + 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(w - pad.r, py); ctx.stroke();
    ctx.setLineDash([]);
    if (l.label) {
      ctx.fillStyle = tok(l.color);
      ctx.textAlign = 'right';
      ctx.textBaseline = l.below ? 'top' : 'bottom';
      ctx.fillText(l.label, w - pad.r - 3, l.below ? py + 2 : py - 2);
    }
  }
  for (const s of opts.series || []) drawSeries(ctx, s, X, Y);
  if (opts.cursor != null) {
    ctx.strokeStyle = tok('--line-strong');
    ctx.lineWidth = 1;
    const px = Math.round(X(opts.cursor)) + 0.5;
    ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, pad.t + ph); ctx.stroke();
  }
  ctx.restore();
}

function drawSeries(ctx, s, X, Y) {
  ctx.strokeStyle = tok(s.color);
  ctx.lineWidth = s.width || 1.6;
  ctx.lineJoin = 'round';
  ctx.setLineDash(s.dash || []);
  ctx.beginPath();
  let col = null, first = 0, last = 0, lo = 0, hi = 0, open = false;
  const flush = () => {
    if (col === null) return;
    if (!open) { ctx.moveTo(col, Y(first)); open = true; } else ctx.lineTo(col, Y(first));
    if (hi !== lo) { ctx.lineTo(col, Y(lo)); ctx.lineTo(col, Y(hi)); }
    ctx.lineTo(col, Y(last));
  };
  for (let i = 0; i < s.n; i++) {
    const y = s.y(i);
    if (!Number.isFinite(y)) { flush(); col = null; open = false; continue; }
    const px = Math.round(X(s.x(i)) * 2) / 2;
    if (px !== col) {
      flush();
      col = px; first = last = lo = hi = y;
    } else {
      last = y;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  flush();
  ctx.stroke();
  ctx.setLineDash([]);
}
