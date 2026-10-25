//
//  probe-bank.ts — what is the bank actually publishing, right now?
//
//  Run:  ./node_modules/.bin/tsx scripts/probe-bank.ts
//
//  **Why this exists.** On 2026-10-25 the owner tapped a card and nothing
//  appeared in the app for two hours. The useful question — "is this the app or
//  the bank?" — cannot be answered from inside the app, because every layer
//  between the bank and the screen can hide a transaction: the backend's `_log`
//  dedup, the `toQueueTransaction` mapping, the 30-day window, the client-side
//  `skipped` flag, the SwiftData cache.
//
//  So this talks to Enable Banking **directly** and prints the raw answer. If a
//  transaction is missing here, it is missing at the bank and nothing in this
//  codebase can conjure it. If it is present here but absent in the app, the
//  fault is ours and this tells you which transaction to chase.
//
//  **It reads production.** The real Danske consent, via the production Enable
//  Banking application. Nothing is written — the only call that changes
//  anything would be a consent flow, and this performs none.
//
//  ⚠️ **Costs one of four daily fetches.** PSD2 allows an AIS provider four
//  unattended account accesses per day. This makes exactly one, deliberately.
//  Running it repeatedly will exhaust the budget the *app* needs.
//
import { config } from 'dotenv';
config({ path: '.env', override: true });

// `lib/enablebanking` reads the unprefixed names; point them at the production
// application, which is a different application with its own key pair.
process.env.ENABLE_BANKING_APP_ID = process.env.ENABLE_BANKING_PROD_APP_ID;
process.env.ENABLE_BANKING_PRIVATE_KEY = process.env.ENABLE_BANKING_PROD_PRIVATE_KEY;

import { createClient } from '@supabase/supabase-js';
import { decryptToken } from '../lib/crypto.js';
import { getSession, fetchAccountTransactions } from '../lib/enablebanking.js';

const DAYS = Number(process.argv[2] ?? 7);

async function main() {
  const url = process.env.SUPABASE_PROD_URL;
  const key = process.env.SUPABASE_PROD_SERVICE_ROLE_KEY;
  if (!url || !key || key === 'PASTE_HERE') {
    console.error('Set SUPABASE_PROD_URL and SUPABASE_PROD_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const { data, error } = await createClient(url, key, { auth: { persistSession: false } })
    .from('users')
    .select('bank_access_token, bank_token_expiry')
    .limit(1);
  if (error) throw error;
  const user = data?.[0];
  if (!user?.bank_access_token) {
    console.log('No bank connection stored in production.');
    return;
  }

  const session = await getSession(decryptToken(user.bank_access_token));
  console.log(`consent  : ${session.status}, expires ${user.bank_token_expiry}`);
  console.log(`accounts : ${session.accounts.length}`);

  const from = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const uid of session.accounts) {
    const transactions = await fetchAccountTransactions(uid, from);
    const pending = transactions.filter((t: any) => String(t.status).toUpperCase().startsWith('PDNG'));

    console.log(`\naccount ${uid.slice(0, 8)}… — ${transactions.length} since ${from}`);
    console.log(`  booked ${transactions.length - pending.length} · pending ${pending.length}`);
    console.log('  (pending is the number that answers "is the bank publishing authorisations?")\n');

    const rows = transactions
      .map((t: any) => ({
        date: t.booking_date ?? t.transaction_date ?? t.value_date ?? '?',
        status: String(t.status ?? '?'),
        amount: t.transaction_amount?.amount ?? '?',
        who: String(
          t.creditor?.name ?? t.debtor?.name ?? t.remittance_information?.[0] ?? '?',
        ).slice(0, 36),
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    for (const r of rows) {
      console.log(
        `  ${r.date}  ${r.status.padEnd(5)}  ${String(r.amount).padStart(10)}  ${r.who}`,
      );
    }
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
});
