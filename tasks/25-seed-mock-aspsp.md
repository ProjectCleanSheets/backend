# 25 — A repeatable way to re-seed the Mock ASPSP

- **Branch:** `feature/25-seed-mock-aspsp`
- **Story points:** 1

## Why

`GET /api/transactions` asks the bank for the last **30 days**
(`FETCH_WINDOW_DAYS`). The sandbox account's transactions carry **literal dates
that never move**, so a data set seeded months ago quietly stops appearing: the
endpoint answers **200 with zero transactions**, the queue is empty, and nothing
anywhere says why. There is no error to search for.

That is exactly what happened on 2026-09-15, blocking app task 13. The account
looked healthy in Enable Banking's console — 565 transactions — but the newest
was dated **2026-07-12**, five weeks before the window even opens. Diagnosing it
took a direct query to Enable Banking to rule out our own mapping dropping rows
(it drops transactions with no `entry_reference`; zero were dropped).

Re-seeding should have been the easy part. It was not: the only record of how
the original data got there was the phrase *"date-shifted Danske sample"* on the
task board. No script, no procedure, no sample file.

## What this adds

`scripts/seed-mock-aspsp.mjs` — no dependencies, no arguments needed:

```bash
node scripts/seed-mock-aspsp.mjs
```

It downloads the sample **Enable Banking publish themselves**
(`enablebanking.com/sample-data/DK-Danske_Bank-synthetic-1.json` — 611
transactions on an "Ida Jensen" Danske account, dated 2020-09-14 → 2021-09-14),
shifts every date forward so the newest lands on today, marks the newest few
`PDNG`, and writes an import-ready file.

**Verified to reproduce the original seeding**: its output puts **53
transactions** inside the 30-day window — the exact number the task-04 board
entry recorded in July 2026.

The `PDNG` marking is an addition, not a fidelity loss: the published sample is
100% `BOOK`, and both the app's PENDING badge (app task 13) and the
pending-only dedup key (id alone, rather than id+amount+date) are untestable
without unsettled entries.

## The step that stays manual

Uploading. The Mock ASPSP tab is behind the Enable Banking control-panel login,
and there is no public API for it. So: run the script, then import the file at
enablebanking.com → control panel → **Mock ASPSP**, replacing the account.

**Then re-run the bank consent.** The import creates a *new* account, so the
stored session keeps pointing at the old one, which starts answering **400** —
and the queue stays empty for a second, entirely unrelated reason. This caught
us once already; the script prints the warning at the end so it cannot be
forgotten.

## Acceptance criteria

- [x] One command produces an import-ready file with today's dates.
- [x] Output is byte-identical to the file that was actually imported on
      2026-09-15 (compared directly).
- [x] The 30-day window count matches the original seeding (53).
- [x] The manual upload step and the re-consent trap are documented where
      someone will meet them — in the script's own output, not only here.
- [x] `tasks/04-transactions.md` points at the script, since that is the task
      whose data ages out.

## When this recurs

About every 30 days, and on every bank-dependent task after that (app 13, 14,
15, 16). The symptom is always an empty queue with a 200 response.
