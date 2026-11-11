# CleanSheets Backend — Task Board

Single source of truth for backend work. One task = one branch = one agent session.

**Workflow**
1. Pick the top task in Backlog (order matters — each task depends on the previous unless noted).
2. Move its line to In Progress, create the branch, point an agent at the task file in `tasks/`.
3. When the branch is merged to main, move the line to Done as **one line** (title,
   points, date). Verification notes go in the task file or `tasks/DONE-LOG.md`.

**Keep this board updated as the project grows.** Any newly discovered work gets a task
file in `tasks/` and a Backlog entry *before* implementation starts — no untracked work.

Story points use the classic Fibonacci scale (1, 2, 3, 5, 8, 13).
Remaining: **5 pts.**

**Phase 2 (from 2026-11-11).** V1 is live in production. The next backlog comes from
the owner's hands-on testing, logged raw in `../TESTING-1.0.md`; an entry there is not a
task until it has a task file and a Backlog line here.

## In Progress

- (none)

## Backlog

- [30 — Code-health review](tasks/30-code-health-review.md) · 3 pts · review only; pairs with app 55
- [31 — Coding conventions in CLAUDE.md](tasks/31-coding-conventions.md) · 2 pts · after 30

## Done
Newest first. Full verification notes: [`tasks/DONE-LOG.md`](tasks/DONE-LOG.md).

### Phase 2

- (none yet)

### V1 — up to 2026-10-21

- [28 — A homepage, so the OAuth consent screen can be published](tasks/28-homepage.md) · 1 pt · 2026-10-21
- [26 — Privacy policy and terms, served from the backend](tasks/26-legal-pages.md) · 1 pt · 2026-10-12
- [27 — `+` in the `bank` query parameter must mean a space](tasks/27-bank-query-plus-encoding.md) · 1 pt · 2026-10-12
- [24 — Confirm Danske Bank's production ASPSP name](tasks/24-danske-aspsp-name.md) · 2 pts · 2026-10-12
- [25 — A repeatable way to re-seed the Mock ASPSP](tasks/25-seed-mock-aspsp.md) · 1 pt · 2026-09-15
- [23 — Whole-second timestamps on the contract's `date-time` fields](tasks/23-whole-second-timestamps.md) · 1 pt · 2026-09-15
- [22 — Sheet list endpoint + Drive scope](tasks/22-sheet-list.md) · 2 pts · 2026-09-14
- [21 — Accept the iOS OAuth client's audience on the session exchange](tasks/21-ios-client-audience.md) · 1 pt · 2026-09-03
- [20 — Fix malformed `example` in the refresh 401 response](tasks/20-openapi-refresh-example.md) · 1 pt · 2026-08-05
- [19 — Backend session tokens (access + refresh)](tasks/19-session-tokens.md) · 5 pts · 2026-08-02
- [18 — Delete account & data](tasks/18-account-deletion.md) · 3 pts · 2026-07-24
- [17 — Google Sheets callback binding](tasks/17-google-consent-binding.md) · 3 pts · 2026-07-24
- [16 — Sign in with Apple (backend)](tasks/16-apple-signin.md) · 8 pts · 2026-07-23
- [15 — Bank callback: bind consent to the authenticated caller](tasks/15-bank-callback-binding.md) · 3 pts · 2026-07-22
- [09 — Security review](tasks/09-security-review.md) · 2 pts · 2026-07-22
- [08 — Settings endpoints](tasks/08-settings.md) · 2 pts · 2026-07-19
- [14 — Save flow: anchor section scan on true box titles](tasks/14-section-anchor-save.md) · 2 pts · 2026-07-19
- [07 — Budget overview](tasks/07-budget-overview.md) · 2 pts · 2026-07-18
- [06 — New category](tasks/06-new-category.md) · 3 pts · 2026-07-18
- [05 — Categorize & save to sheet](tasks/05-sheet-save.md) · 5 pts · 2026-07-14
- [13 — Constants & naming cleanup](tasks/13-constants-cleanup.md) · 2 pts · 2026-07-14
- [11 — Configurable consent validity for dev](tasks/11-consent-validity.md) · 1 pt · 2026-07-12
- [12 — Separate dev Supabase project](tasks/12-dev-supabase.md) · 2 pts · 2026-07-12
- [04 — Transaction fetching](tasks/04-transactions.md) · 3 pts · 2026-07-12
- [03 — Google Sheet connection & structure](tasks/03-sheet-setup.md) · 8 pts · 2026-07-11
- [02 — Enable Banking connection](tasks/02-bank-connect.md) · 8 pts · 2026-07-09
- [01 — Scaffold & auth foundation](tasks/01-scaffold-auth.md) · 5 pts · 2026-07-07
- [10 — Swagger API docs](tasks/10-api-docs.md) · 2 pts · 2026-07-07

## Deferred / not scheduled

- ~~Secret rotation (from task 09)~~ — **done** (owner, confirmed 2026-11-11). The secrets
  exposed in a chat transcript on 2026-07-22 have been replaced, without the new values
  passing through any agent session. Runbook kept in `tasks/09-review-summary.md`.
- Pending-transaction reconciliation on booking — moot for Danske, which publishes no
  pending transactions (app task 49). Becomes real again as the *matching* step of
  phone-side spend capture (`../TESTING-1.0.md` #4): a spend logged on the phone has to be
  matched to the booked bank transaction later, never by id.
- Rate limiting / abuse throttling — impractical on Vercel free tier without extra infra; revisit before public launch.
- `npm audit` dev-only advisories (task 09) — 10 advisories (undici@5.28.4,
  smol-toml@1.5.2) are transitive deps of `@vercel/node`, a devDependency;
  `npm audit --omit=dev` is clean and `npm ls undici --omit=dev` is empty, so
  none reach the deployed runtime. `npm audit fix --force` would downgrade
  `@vercel/node` to v4 (breaking). Accepted; revisit when `@vercel/node` ships a
  patched undici.
- Free-tier enforcement (30 transactions/month) — explicitly out of this release per CLAUDE.md.
- Server-side push notifications — V2 per product spec.
