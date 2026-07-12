# CleanSheets Backend — Task Board

Single source of truth for backend work. One task = one branch = one agent session.

**Workflow**
1. Pick the top task in Backlog (order matters — each task depends on the previous unless noted).
2. Move its line to In Progress, create the branch, point an agent at the task file in `tasks/`.
3. When the branch is merged to main, move the line to Done.

**Keep this board updated as the project grows.** Any newly discovered work gets a task
file in `tasks/` and a Backlog entry *before* implementation starts — no untracked work.

Story points use the classic Fibonacci scale (1, 2, 3, 5, 8, 13).
Remaining: **17 pts**.

## In Progress

- (none)

## Backlog

- [12 — Separate dev Supabase project](tasks/12-dev-supabase.md) · 2 pts · no branch (config/docs) — do BEFORE 05; local dev currently writes to the production DB
- [11 — Configurable consent validity for dev](tasks/11-consent-validity.md) · 1 pt · `feature/consent-validity` — enables real end-to-end testing of `BANK_TOKEN_EXPIRED`
- [05 — Categorize & save to sheet](tasks/05-sheet-save.md) · 5 pts · `feature/sheet-save`
- [06 — New category](tasks/06-new-category.md) · 3 pts · `feature/new-category`
- [07 — Budget overview](tasks/07-budget-overview.md) · 2 pts · `feature/budget-overview`
- [08 — Settings endpoints](tasks/08-settings.md) · 2 pts · `feature/settings`
- [09 — Security review](tasks/09-security-review.md) · 2 pts · `feature/security-review` — gate before first production use

## Done

- [04 — Transaction fetching](tasks/04-transactions.md) · 3 pts · merged 2026-07-12, verified end-to-end via /api/docs: seeded Mock ASPSP (date-shifted Danske sample, 53 txns in window), pagination, newest-first ordering, `_log` dedup filtering against the real sheet, pending included per product decision
- [03 — Google Sheet connection & structure](tasks/03-sheet-setup.md) · 8 pts · merged 2026-07-11, verified end-to-end via /api/docs against the real sheet (July + June tabs; consent flow, tab list, structure detection incl. side-by-side boxes and merged banner titles)
- [02 — Enable Banking connection](tasks/02-bank-connect.md) · 8 pts · merged 2026-07-09, verified end-to-end via /api/docs against the sandbox Mock ASPSP (encrypted session stored, 90-day expiry)
- [01 — Scaffold & auth foundation](tasks/01-scaffold-auth.md) · 5 pts · merged 2026-07-07, verified end-to-end via /api/docs
- [10 — Swagger API docs](tasks/10-api-docs.md) · 2 pts · merged 2026-07-07

## Deferred / not scheduled

- Pending-transaction reconciliation on booking — the queue includes reserved
  (pending) transactions by product decision 2026-07-11 (instant categorization);
  amount drift and rare id reissue after settlement are accepted for MVP
  (see tasks/04-transactions.md). V2: reconcile amounts / detect reissued ids.
- Rate limiting / abuse throttling — impractical on Vercel free tier without extra infra; revisit before public launch.
- Free-tier enforcement (30 transactions/month) — explicitly out of this release per CLAUDE.md.
- Server-side push notifications — V2 per product spec.
