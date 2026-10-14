// node scripts/compare.mjs [seed] [days] [engineer review interval in days]
// Runs the three outer-loop strategies on the same plant, weather and demand and prints a scorecard.
import { runStrategy, summarize, STRATEGIES } from '../src/strategies.js';

const seed = Number(process.argv[2] ?? 7);
const days = Number(process.argv[3] ?? 90);
const engineerEvery = Number(process.argv[4] ?? 30);
const rows = [];
for (const key of Object.keys(STRATEGIES)) {
  const w = await runStrategy(key, { seed, days, engineerEvery });
  const label = key === 'engineer' ? `Engineer every ${engineerEvery} days` : STRATEGIES[key].label;
  rows.push({ strategy: label, ...summarize(w) });
}
console.table(rows);
