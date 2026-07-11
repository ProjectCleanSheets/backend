# 04 — Transaction fetching

- **Branch:** `feature/transactions`
- **Depends on:** 02 and 03
- **Story points:** 3

## Scope

- `api/transactions/index.ts` — `GET /api/transactions`:
  - Fetch recent transactions from Enable Banking using the user's stored bank tokens
    (from Supabase, decrypted via `lib/crypto.ts`)
  - Handle bank token refresh if expired (via `lib/enablebanking.ts`)
  - Cross-reference the `_log` tab of the user's Google Sheet and filter out
    already-categorized transactionIds
  - Return only uncategorized transactions, newest first
  - Each transaction: `id`, merchant name, `amount`, `currency`, `date`, `direction`
    (debit/credit), `status` (booked/pending)
  - Pending (reserved) transactions ARE included, marked `status: "pending"` —
    product decision 2026-07-11: a purchase must appear while the user still
    remembers it; spec §7b's id-reissue-on-settlement risk accepted as rare.
    Cancelled/rejected entries and entries without a bank-assigned id are dropped.
  - **Accepted drift consequences of categorizing before settlement** (do not
    "fix" these without a new product decision):
    - *Amount drift*: a reserved amount can change when it books (tips, fuel
      pumps, currency conversion). The sheet keeps the amount saved at
      categorization time — the id stays filtered via `_log`, so the booked
      version never reappears for correction.
    - *Id reissue (rare)*: if the bank books a reserved transaction under a new
      id, it reappears in the queue as new; the user skips it or fixes the sheet
      manually.
    - Reconciliation on booking is deferred to V2 — see TASKS.md Deferred.

## Out of scope

- Saving/categorizing (task 05), the 2-hour settlement grace period (iOS app concern
  per product spec §7b)

## Acceptance criteria

- [ ] Returns `BANK_TOKEN_EXPIRED` when consent has expired (after a refresh attempt).
- [ ] Only the verified caller's tokens and sheet are used — ownership enforced via
      google_id from the verified ID token.
- [ ] Missing `_log` tab handled gracefully (treat as empty; the app warns the user).
- [ ] Endpoint auth-gated; structured errors per CLAUDE.md; no transaction data or
      tokens logged.
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting — especially
> the Security Requirements and Task Board sections. Tasks 01–03 are already built;
> compose `lib/enablebanking.ts` and `lib/sheets.ts` — do not duplicate their logic.
> Implement task `tasks/04-transactions.md` exactly as scoped. When done, update TASKS.md.
