# 30 — Code-health review findings (backend)

**Owner review 2026-11-17: all seven accepted** → 1→38, 2→39, 3→41, 4→40, 5→43, 6→44, 7→42.

Reviewed 2026-11-17 on `main` (`549112f`). 25 TypeScript files, ~4,160 lines in `api/` and
`lib/`. No refactoring was done; each accepted item becomes its own task.

Ranked worst first. **Size** is story points for the follow-up task.

| # | Where | Problem | Proposed change | Size |
|---|---|---|---|---|
| 1 | Whole repo | **No committed tests.** Every task verified its logic with throwaway stub tests (DONE-LOG: 08, 11, 13, 06's 50k-layout fuzz, 07's fixtures), then deleted them. Comments still say functions are "exported for tests" (5 places). Tasks 32–35 will insert, delete and copy rows in the owner's live sheet, and nothing pins today's behaviour. | Add `node --test` (Node 26 runs `.ts` directly, so no new dependency) and an `npm test` script. Start with the pure functions: `scanSection`, `detectSections`, `buildLogMatcher`/`parseLogRows`, `resolveColumns`, `computeBankStatus`, `toQueueTransaction`, `toWholeSecondISO`, with fixtures copied from the real sheet layout. | 2 |
| 2 | `lib/sheets.ts` (401) and `api/sheet/structure.ts` (291) | **Two separate readers of the same sheet layout.** Onboarding finds sections and categories with `detectSections` (whole-grid, header-pair based). Saves, new category and the budget overview use `scanSection` (one column, title based). Each has its own rules for blank rows, `Total` rows and where the next box starts, and its own `cellText`/`numberOrNull` (a third copy is in `logtab.ts`). A fix to one doesn't reach the other: task 14's "Cash flow Income" fix went only into `scanSection`. `lib/sheets.ts` also mixes the Google API wrappers with this layout parsing. | Move the layout logic (`scanSection`, `findCategoryRow`, `detectSections`, the cell helpers, column letters) into a new `lib/sheetlayout.ts`. `sheets.ts` keeps only auth and API calls (~230 lines). Don't merge the two algorithms in this task; the tests from 1 record where they differ, and 32 decides. **Before 32.** | 3 |
| 3 | Every handler in `api/` | **Copy-pasted handler plumbing.** The `getVerifiedUser` → 401 block appears 10×. `SheetsError` → HTTP status mapping appears 5×. `SaveFlowError` and `TransactionsError` are the same class under two names. Each copy can drift, and a new endpoint (33, 35) adds another. | In `lib/errors.ts`: one `ApiError(status, code, message)` replacing both classes, plus a `sendFailure(res, err, label, fallback)` that maps `ApiError`, `SheetsError` and `EnableBankingError` and logs the rest. Handlers keep their own routing. | 2 |
| 4 | `api/sheet/save.ts` `locateActualCell` and `api/sheet/category.ts` | **The Actual cell read-modify-write is written twice:** the same two-column batchGet, the same "blank counts as 0", the same rounding. 32 and 35 would make it three. | Move "find the category row and its current Actual" and "add an amount to it" into `lib/saveflow.ts`, used by both. **Before 32.** | 1 |
| 5 | Comments across `api/` and `lib/` | **48 history references** (`task NN`, `CR-NN`, `spec §7b`, dates); `google.ts` has 11. Some comments are essays: `lib/time.ts` has 30 lines for a 5-line function, and the `bank` query parameter has 15. Two are stale: `transactions/index.ts` says pending payments are "shown instantly", but Danske sends none (app task 49); and two error messages tell the caller to "sign in via POST /api/auth/google", but sign-in moved to `POST /api/auth/session`. `CLAUDE.md` is stale as well. Its Project Structure leaves out 6 of the 13 `lib/` files and `api/user/account.ts`. It also still calls the unattended-access limit "likely the cause of TESTING #3", which task 29 ruled out. | Sweep after 31 sets the comment rule (as app 56 → 65 did): keep the *why* in present tense, drop task numbers and dates, fix the stale texts and CLAUDE.md. | 2 |
| 6 | `lib/errors.ts` codes as used | **Error codes don't always mean their name.** `SUPABASE_ERROR` is also returned for Enable Banking outages and missing server config. `GOOGLE_TOKEN_EXPIRED` is returned for a missing or invalid *backend session* on every endpoint. `INVALID_REQUEST` covers 400, 403, 404 and 409. The app maps codes to messages, so renaming is a contract change in both repos. | No code change now. Document in `openapi.json` what each code really covers, so the app (and app 63's `SaveFailure` mapping) can rely on it. Revisit before a public launch. | 1 |
| 7 | `api/auth/google.ts`, `lib/enablebanking.ts` | Small naming issues. `signIn()` in `google.ts` is really the "who am I / what's left to set up" call, since sign-in moved to `/api/auth/session`. The production host `backend-beryl-phi-32.vercel.app` is hard-coded twice as a redirect default. | Rename the function (the route stays; it is the contract). Put the host in one constant in `lib/constants.ts`. Ride along with 3. | 1 |

## Checked and fine
- **Identity only from the verified token.** No handler reads a user id from the body or query.
- **No secrets in logs or responses.** `SheetsError` and `EnableBankingError` carry status and step only. Tokens are decrypted only where they are used.
- **User text can't become a formula.** Every write uses `valueInputOption: 'RAW'`.
- **No `api/` file imports another**; shared code is in `lib/`.
- **No dead exports, `TODO`s or `FIXME`s.**
- **The `_log`-first write order and the dedup gate** are in one place (`lib/saveflow.ts`, `lib/logtab.ts`) and both save paths use them.
- `lib/auth.ts` (327) is long but holds one job (verifying identity tokens and OAuth state), and its comments explain the security reasoning. Leave it.
- `api/auth/bank.ts` (348) is four routes; after 3 and 5 it should drop to ~260. It doesn't need splitting.

## Suggested order
1 → 2 → 4 before **32**: tests first, so the move in 2 and the merge in 4 are checked against something.
3 and 7 together, any time.
5 after **31**.
6 is documentation only.

Total if all are accepted: **12 pts**. Only 1, 2 and 4 (6 pts) sit on the path to the new-month deadline
(35 by ~2026-11-27). Doing them first makes that path 30 → 31 → 1 → 2 → 4 → 32 → 35, about 19 pts in 10 days.
If that is too tight, do 1 and 4 now (3 pts) and move 2 after 35.
