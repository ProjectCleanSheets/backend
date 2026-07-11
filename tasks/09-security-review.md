# 09 — Security review

- **Branch:** `feature/security-review`
- **Depends on:** 01–08 (all features complete)
- **Story points:** 2

> Gate before first production use (`ENABLE_BANKING_ENV=production`). Do not flip to
> production until this task is Done.

## Scope

- Run a full security review of the backend (`/security-review` in Claude Code).
- Verify every item in CLAUDE.md's **Security Requirements** section against the real
  code: ID token audience checks, AES-256-GCM usage, service-role key isolation,
  `state` CSRF validation on both OAuth flows, per-user ownership checks, zod
  validation coverage, no token/PEM/sheet-content logging, no stack traces in responses.
- Check dependency advisories (`npm audit`) and fix or document exceptions.
- Fix all confirmed findings; document accepted risks (e.g. deferred rate limiting) in
  TASKS.md's Deferred section.
- **Rotate all shared secrets** — on 2026-07-11 the full `.env` contents were pasted
  into a chat transcript, so treat these as burned before any production use:
  - `ENCRYPTION_KEY` (generate new; re-encrypt or invalidate stored tokens)
  - `GOOGLE_CLIENT_SECRET` (regenerate in Google Cloud Console)
  - `SUPABASE_SERVICE_ROLE_KEY` (rotate in Supabase dashboard)
  - `ENABLE_BANKING_PRIVATE_KEY` (new key pair in the Enable Banking control panel)
  Update Vercel env vars, local `.env`/`.env.local`, and CREDENTIALS.md afterwards.

## Acceptance criteria

- [ ] Security review run with no unresolved high/medium findings.
- [ ] All four exposed secrets rotated and verified working (see Scope).
- [ ] Every Security Requirements item verified in code, with file references noted in
      the review summary.
- [ ] `npm audit` clean or exceptions documented.
- [ ] Accepted risks recorded in TASKS.md.

## Agent kickoff prompt

> You are reviewing the CleanSheets backend for security. Read CLAUDE.md first —
> especially the Security Requirements section. Execute task
> `tasks/09-security-review.md`: run /security-review, verify each requirement against
> the code, fix findings on this branch. When done, update TASKS.md.
