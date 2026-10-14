// node scripts/screenshots.mjs  →  docs/*.png for the README (needs Chrome or Edge).
// Starts the local server, opens the app in headless Chrome, and reports any page errors.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TMP = join(ROOT, '.tmp');
const OUT = join(ROOT, 'docs');
const CHROME = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find(existsSync);
if (!CHROME) throw new Error('No Chrome/Edge found (set CHROME=<path>)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 5180 + Math.floor(Math.random() * 100);
const server = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const dbg = 9400 + Math.floor(Math.random() * 300);
const PROFILE = join(TMP, `chrome-profile-${dbg}`);
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${dbg}`,
  `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });

let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!target) throw new Error('Chrome did not start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

async function shot(name, query, { width = 1600, height = 1000, wait = 1500, script = '', full = false } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://localhost:${PORT}/${query}` });
  await sleep(wait);
  if (script) await evaluate(script);
  await sleep(400);
  let clip;
  if (full) {
    const h = await evaluate('document.documentElement.scrollHeight');
    await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    clip = { x: 0, y: 0, width, height: h, scale: 1 };
  }
  const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  console.log(`docs/${name}.png`);
}

const only = process.argv[2];
const SHOTS = {
  live: () => shot('live', '?day=24.6', { wait: 2500, full: true }),
  compare: () => shot('compare', '?tab=compare', { wait: 2500, full: true }),
  dark: () => shot('live-dark', '?day=24.6&theme=dark', { wait: 2500 }),
};
try {
  for (const [k, f] of Object.entries(SHOTS)) if (!only || only === k) await f();
} finally {
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
  else console.log('no page errors');
  // close the whole browser (killing the parent process leaves its children running on Windows)
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json();
    const bws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((r) => bws.addEventListener('open', r));
    bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  } catch {
    chrome.kill();
  }
  ws.close();
  server.kill();
  await sleep(800);
  for (let i = 0; i < 5; i++) {
    try { rmSync(PROFILE, { recursive: true, force: true }); break; } catch { await sleep(500); }
  }
}
