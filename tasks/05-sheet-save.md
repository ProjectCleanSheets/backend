# 05 — Categorize & save to sheet

- **Branch:** `feature/sheet-save`
- **Depends on:** 03 (04 recommended first — supplies real transactionIds)
- **Story points:** 5

## Scope

- `api/sheet/save.ts`:

**`POST /api/sheet/save`** — body `{ section, category, amount, transactionId }`
1. Find the current month tab (match by current month name, e.g. "July")
2. Scan the category column (default F, or user's configured column) for the matching
   section + category row
3. Read the current Actual value (default column H, or configured)
4. Add the transaction amount
5. **Write the `_log` dedup entry first** (`transactionId, section, category, amount,
   timestamp`), **then** write the new total to the Actual cell — crash-safety ordering
   per product spec §7b: if the Actual write fails, the `_log` entry prevents a
   double-save on retry
6. Return the new Actual value and the row written

**`DELETE /api/sheet/save`** — body `{ transactionId }` (undo)
1. Find the `_log` entry for this transactionId
2. Reverse the sheet write (subtract the amount from the Actual cell)
3. Remove the `_log` entry

Column positions come from the user's `column_mapping` in Supabase.

**Note on pending transactions:** the queue (task 04) includes pending
(reserved) bank transactions, so saves can arrive for transactions that have
not settled yet. The amount written to `_log` and the Actual cell may therefore
differ from the finally booked amount — this drift is an accepted product
decision (see `tasks/04-transactions.md`); do NOT add reconciliation logic
(deferred to V2 per TASKS.md).

**Note on non-unique transaction ids** (found testing task 04 against Enable
Banking's synthetic Danske data): banks sometimes reuse one `entry_reference`
across several transaction lines — e.g. a rent payment split into Husleje/El/TV
rows all sharing id `3567743333`. Strict "duplicate transactionId rejects the
save" would block saving the 2nd/3rd line, and the task-04 fetch filter hides
all lines once one is logged. **Recommended approach (owner-approved
2026-07-12): dedup on the composite key `transactionId + amount + date`**, not
id alone — store all three in `_log` and match on the triple both when
rejecting duplicate saves here and when filtering the queue in
`api/transactions/index.ts` (that filter currently matches id-only and must be
updated in this task to stay consistent).

Caveat the design must resolve: a **pending** transaction that later books can
keep its id but change amount and/or date (see the pending-drift note above), so
a strict triple match would resurface it and reintroduce the double-count the
filter exists to prevent. Suggested resolution: record the transaction's
`status` in `_log` at save time; match booked rows on the strict triple, but
match rows saved as pending on id alone.

## Out of scope

- Creating new categories (task 06), free-tier save counting (never)

## Acceptance criteria

- [ ] `_log` written before the Actual cell on save; duplicate transactionId in `_log`
      rejects the save (dedup).
- [ ] `CATEGORY_NOT_FOUND` when section+category row cannot be found;
      `SHEET_NOT_FOUND` / `SHEET_WRITE_FAILED` per CLAUDE.md.
- [ ] Undo only operates on `_log` entries in the verified caller's own sheet.
- [ ] Body validated with zod; `amount` bounded to a sane numeric range
      (`INVALID_REQUEST` otherwise).
- [ ] The Left column (formula) is never written to.
- [ ] Endpoints auth-gated; no sheet contents or tokens logged.
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting — especially
> the Security Requirements and Task Board sections. Tasks 01–04 are already built;
> use `lib/sheets.ts` for all sheet access. Implement task `tasks/05-sheet-save.md`
> exactly as scoped. When done, update TASKS.md.
