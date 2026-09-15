#!/usr/bin/env node
// Rebuilds the Mock ASPSP's test data with dates that land on today.
//
// WHY THIS EXISTS: the sandbox account's transactions are stored with literal
// dates and never move. `GET /api/transactions` asks the bank for the last
// 30 days (FETCH_WINDOW_DAYS), so a data set seeded N months ago silently
// returns an EMPTY QUEUE — the endpoint answers 200 with zero transactions and
// nothing anywhere says why. That cost an evening in September 2026, when the
// July seeding had aged out and the only record of how it was done was the word
// "date-shifted" on the task board.
//
// It is not a fixture we invented: Enable Banking publish this Danske Bank
// sample themselves (611 transactions on an "Ida Jensen" account, dated
// 2020-09-14 → 2021-09-14). All this does is move every date forward so the
// newest lands on today, which is exactly what the original seeding did.
//
//   node scripts/seed-mock-aspsp.mjs                # writes ./mock-aspsp-seed-<date>.json
//   node scripts/seed-mock-aspsp.mjs --pending 4    # mark the 4 newest PDNG (default)
//   node scripts/seed-mock-aspsp.mjs --out ~/Desktop/seed.json
//
// Then upload the file by hand: enablebanking.com → control panel → Mock ASPSP
// tab → import, replacing the existing account. **The import creates a NEW
// account**, so the stored bank session then points at one that answers 400 —
// re-run the bank consent afterwards or the queue stays empty for a second,
// entirely different reason.

const SAMPLE_URL = 'https://enablebanking.com/sample-data/DK-Danske_Bank-synthetic-1.json';
// Only these carry dates in the sample; checked by scanning every string field.
const DATE_KEYS = new Set(['booking_date', 'value_date', 'reference_date']);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const pendingCount = Number(arg('pending', 4));
const today = new Date().toISOString().slice(0, 10);
const outPath = arg('out', `./mock-aspsp-seed-${today}.json`);

const res = await fetch(SAMPLE_URL);
if (!res.ok) {
  console.error(`Could not download the sample: HTTP ${res.status} ${SAMPLE_URL}`);
  process.exit(1);
}
const data = await res.json();

const collect = (node, out) => {
  if (Array.isArray(node)) node.forEach((v) => collect(v, out));
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (DATE_KEYS.has(k) && typeof v === 'string') out.push(v.slice(0, 10));
      else collect(v, out);
    }
  return out;
};

const dates = collect(data, []);
if (!dates.length) {
  console.error('No dates found in the sample — its shape changed; check DATE_KEYS.');
  process.exit(1);
}
const newest = dates.reduce((a, b) => (a > b ? a : b));
const shiftDays = Math.round((Date.parse(today) - Date.parse(newest)) / 86_400_000);

const shift = (node) => {
  if (Array.isArray(node)) return node.map(shift);
  if (node && typeof node === 'object')
    return Object.fromEntries(Object.entries(node).map(([k, v]) => {
      if (DATE_KEYS.has(k) && typeof v === 'string' && v.length >= 10) {
        const moved = new Date(Date.parse(v.slice(0, 10)) + shiftDays * 86_400_000);
        return [k, moved.toISOString().slice(0, 10) + v.slice(10)];
      }
      return [k, shift(v)];
    }));
  return node;
};

const seeded = shift(data);
const txs = seeded.accounts[0].transactions;
txs.sort((a, b) => String(b.booking_date ?? b.value_date ?? '').localeCompare(String(a.booking_date ?? a.value_date ?? '')));

// The published sample is 100% BOOK. A real feed always has unsettled entries,
// and the app's PENDING badge and the pending-only dedup key (id alone, rather
// than id+amount+date) cannot be exercised without them.
for (const tx of txs.slice(0, Math.max(0, pendingCount))) tx.status = 'PDNG';

const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, JSON.stringify(seeded));

const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const inWindow = txs.filter((t) => (t.booking_date ?? t.value_date ?? '') >= windowStart).length;
console.log(`sample newest ${newest} → shifted +${shiftDays} days so it lands on ${today}`);
console.log(`wrote ${outPath}`);
console.log(`  ${txs.length} transactions, ${pendingCount} marked PDNG`);
console.log(`  ${inWindow} inside the app's 30-day window (>= ${windowStart})`);
console.log(`\nNext: import it at enablebanking.com → Mock ASPSP, then RE-RUN THE BANK CONSENT`);
console.log(`(the import makes a new account; the stored session still points at the old one).`);
