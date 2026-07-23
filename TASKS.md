# CleanSheets Backend — Task Board

Single source of truth for backend work. One task = one branch = one agent session.

**Workflow**
1. Pick the top task in Backlog (order matters — each task depends on the previous unless noted).
2. Move its line to In Progress, create the branch, point an agent at the task file in `tasks/`.
3. When the branch is merged to main, move the line to Done.

**Keep this board updated as the project grows.** Any newly discovered work gets a task
file in `tasks/` and a Backlog entry *before* implementation starts — no untracked work.

Story points use the classic Fibonacci scale (1, 2, 3, 5, 8, 13).
Remaining: **6 pts**.

## In Progress

- (none)

## Backlog

*App Store / production readiness (needed before submission). In order: 16 sets the
provider-agnostic identity; 17 re-closes the account-linking hole that 16 reopens on
the Google-Sheets consent (16 had to drop the login==Sheets-account check); 18
deletes against the final schema, so account deletion is written once. 17 before 18
because 17 may add a pending-grants table 18 must also sweep.*

- [17 — Google Sheets callback binding](tasks/17-google-consent-binding.md) · 3 pts · `feature/google-consent-binding` — security: task 16 removed the check that Sheets consent came from the login account (required for Apple login), reopening the task-09/15 account-linking vector on the Google side. Close it with the same handle/finalize pattern task 15 used for the bank. Pre-production; iOS change is separate.
- [18 — Delete account & data](tasks/18-account-deletion.md) · 3 pts · `feature/account-deletion` — Apple 5.1.1(v): in-app account+data deletion. Built on task 16's identity model (and sweeps any pending-grants table from 17). Hard submission blocker.

## Done

- [16 — Sign in with Apple (backend)](tasks/16-apple-signin.md) · 8 pts · merged 2026-07-23: provider-agnostic identity. `getVerifiedUser` now verifies a Google **or** Apple identity token (Apple: RS256 against Apple's JWKS, `iss`/`aud === APPLE_CLIENT_ID`/expiry; alg hard-pinned to RS256 — no alg-confusion, proven by a 9/9 local-keypair crypto harness incl. `alg=none` and HS256-with-pubkey rejection) and maps `(provider, subject)` → a stable internal `user_id`, auto-provisioning the row on first authenticated request. Migration 003 swaps the users PK from `google_id` to uuid `id` + unique `(auth_provider, provider_subject)`, backfills existing Google users with **no data loss**, and renames `bank_pending_sessions.initiator_google_id` → `initiator_user_id` (**applied to dev, prod pending next deploy**). Google Sheets consent decoupled from login: the callback binds the granted Google account to the state's user instead of requiring it to equal the login account (needed for Apple login) — this reopened the task-09/15 account-linking vector on the Google side, tracked as task 17. All identity-keyed queries rekeyed to `.eq('id', …)`; `openapi.json`, CLAUDE.md, `.env.example` updated (new `APPLE_CLIENT_ID` env var). Verified: owner ran POST /api/auth/google (→ uuid + `provider:"google"` + `hasConfig`), GET /api/sheet/budget, GET /api/auth/bank/status live via /api/docs; a script replayed every identity-keyed query shape + the provisioning upsert against dev (all green, migrated row's sheet/tokens intact); `tsc` green. True Apple-signed E2E comes from the iOS button (app project). Do NOT run migration 003 on prod until this branch deploys (schema+code must ship together), and prod remains gated on secret rotation.
- [15 — Bank callback: bind consent to the authenticated caller](tasks/15-bank-callback-binding.md) · 3 pts · merged 2026-07-22, verified live via /api/docs against the sandbox Mock ASPSP: full two-step connect → `POST /api/auth/bank/finalize` stored the session under the verified caller (`{status:"connected"}`), confirmed in the dev DB (bank token set, refresh null, handle consumed = single-use; expired orphan handle correctly left dead). Migration 002 `bank_pending_sessions` (service_role only; applied to dev, **prod pending next deploy**), one-time handle minted in the callback, `tsc` green. The future iOS app must call `finalize` (tracked in the app project); no app/users today so nothing to break.
- [09 — Security review](tasks/09-security-review.md) · 2 pts · merged 2026-07-22 ([summary](tasks/09-review-summary.md)): every Security Requirement verified in code with refs, `npm audit --omit=dev` clean (dev-only advisories accepted), public-repo history verified clean. One confirmed Medium finding (bank-callback account-binding) fixed via task 15. Its last criterion — rotating the four leaked secrets — is **deferred to the Deferred section as a hard pre-production gate** (owner, 2026-07-22); do NOT flip `ENABLE_BANKING_ENV=production` until it's done.
- [08 — Settings endpoints](tasks/08-settings.md) · 2 pts · merged 2026-07-19, verified live via /api/docs: `GET /api/auth/bank/status` returned healthy with the real dev consent expiry (2026-10-12); expired/expiring/renewAvailable thresholds pinned by an 8-boundary-case stub test on the pure `computeBankStatus` (incl. exactly-now → expired, exactly-14-days → expiring, never-connected → expired with null expiresAt); config re-mapping (`sheetId`/`columnMapping` POST) turned out to be fully built since task 01 — verified against the criteria, no changes needed; routed via vercel.json rewrite `/api/auth/bank/status` per the existing callback pattern
- [14 — Save flow: anchor section scan on true box titles](tasks/14-section-anchor-save.md) · 2 pts · merged 2026-07-19, verified live via /api/docs: save to Income/"Job Salary" landed in the real Income box and undo restored it (pre-fix this exact request returned CATEGORY_NOT_FOUND, and the "Invest" variant would have written into the Cash flow summary box — collision fixture pins both behaviors); regression fuzz old-vs-new `findCategoryRow` over 20k collision-free layouts, 0 mismatches; save/undo/create now make one Sheets call fewer (Actual read folded into the batchGet)
- [07 — Budget overview](tasks/07-budget-overview.md) · 2 pts · merged 2026-07-18, verified via /api/docs against the real July sheet: all five mapped sections with per-category Budget/Actual plus section and grand totals (Income excluded from the spend totals); owner-confirmed July happy path incl. the Cash flow "Income" summary-row anchor trap found live and fixed (`scanSection` valueColumn disambiguator — save-flow counterpart filed as task 14); all mapped columns read in one batchGet via new `readRanges`; unknown-tab 404, June-tab and save-loop paths covered by fixture tests on the real layout
- [06 — New category](tasks/06-new-category.md) · 3 pts · merged 2026-07-18, verified end-to-end via /api/docs against the real July sheet: writes into the section box's free rows above the Total (no inserts/shifts — layout, Totals, formatting untouched), combined create+categorize reuses task-05 dedup/`_log`-first ordering via `lib/saveflow.ts`, undo reverses the money only (category row stays), 409 on duplicate name and on a full box; task-05 save/undo regression-tested after the refactor (old vs new `findCategoryRow` fuzzed, 50k layouts, 0 mismatches)
- [05 — Categorize & save to sheet](tasks/05-sheet-save.md) · 5 pts · merged 2026-07-14, verified end-to-end via /api/docs against the real July sheet: save updated the Actual cell + hidden `_log` (tab auto-created), saved txn filtered from the queue, undo restored cell/`_log`/queue; composite dedup key live in both save and queue filter (booked: id+amount+date, pending: id-only); expired-consent path re-verified for real (stale task-11 consent → reconnect → 90 days)
- [13 — Constants & naming cleanup](tasks/13-constants-cleanup.md) · 2 pts · merged 2026-07-14: shared constants in `lib/constants.ts`, single-use values named in place, renames (`EnableBankingTransaction` etc.); no contract changes, `tsc` + stub tests green
- [11 — Configurable consent validity for dev](tasks/11-consent-validity.md) · 1 pt · merged 2026-07-12, verified end-to-end in dev with `ENABLE_BANKING_CONSENT_DAYS=0.01`: fetch 200 → `BANK_TOKEN_EXPIRED` after ~14 min → reconnect healed (both consents' `valid_until` confirmed in dev DB); unset/invalid/out-of-range values fall back to 90 days (stubbed-fetch test, 8 cases)
- [12 — Separate dev Supabase project](tasks/12-dev-supabase.md) · 2 pts · done 2026-07-12 (no branch): `cleansheets-dev` created, migration applied, local env switched, consents re-run, config seeded; verified dev round-trip (53 txns) and prod row untouched
- [04 — Transaction fetching](tasks/04-transactions.md) · 3 pts · merged 2026-07-12, verified end-to-end via /api/docs: seeded Mock ASPSP (date-shifted Danske sample, 53 txns in window), pagination, newest-first ordering, `_log` dedup filtering against the real sheet, pending included per product decision
- [03 — Google Sheet connection & structure](tasks/03-sheet-setup.md) · 8 pts · merged 2026-07-11, verified end-to-end via /api/docs against the real sheet (July + June tabs; consent flow, tab list, structure detection incl. side-by-side boxes and merged banner titles)
- [02 — Enable Banking connection](tasks/02-bank-connect.md) · 8 pts · merged 2026-07-09, verified end-to-end via /api/docs against the sandbox Mock ASPSP (encrypted session stored, 90-day expiry)
- [01 — Scaffold & auth foundation](tasks/01-scaffold-auth.md) · 5 pts · merged 2026-07-07, verified end-to-end via /api/docs
- [10 — Swagger API docs](tasks/10-api-docs.md) · 2 pts · merged 2026-07-07

## Deferred / not scheduled

- **Secret rotation (from task 09) — deferred by owner 2026-07-22; HARD gate before
  production.** The four shared secrets (`ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET`,
  `SUPABASE_SERVICE_ROLE_KEY`, `ENABLE_BANKING_PRIVATE_KEY`) were exposed in a chat
  transcript and are burned. Not optional — just postponed while there are no real
  users. Step-by-step runbook in `tasks/09-review-summary.md`. Do NOT flip
  `ENABLE_BANKING_ENV=production` until this is done.
- Pending-transaction reconciliation on booking — the queue includes reserved
  (pending) transactions by product decision 2026-07-11 (instant categorization);
  amount drift and rare id reissue after settlement are accepted for MVP
  (see tasks/04-transactions.md). V2: reconcile amounts / detect reissued ids.
- Rate limiting / abuse throttling — impractical on Vercel free tier without extra infra; revisit before public launch.
- `npm audit` dev-only advisories (task 09) — 10 advisories (undici@5.28.4,
  smol-toml@1.5.2) are transitive deps of `@vercel/node`, a devDependency;
  `npm audit --omit=dev` is clean and `npm ls undici --omit=dev` is empty, so
  none reach the deployed runtime. `npm audit fix --force` would downgrade
  `@vercel/node` to v4 (breaking). Accepted; revisit when `@vercel/node` ships a
  patched undici.
- Free-tier enforcement (30 transactions/month) — explicitly out of this release per CLAUDE.md.
- Server-side push notifications — V2 per product spec.
