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

## Acceptance criteria

- [ ] Security review run with no unresolved high/medium findings.
- [ ] Every Security Requirements item verified in code, with file references noted in
      the review summary.
- [ ] `npm audit` clean or exceptions documented.
- [ ] Accepted risks recorded in TASKS.md.

## Agent kickoff prompt

> You are reviewing the CleanSheets backend for security. Read CLAUDE.md first —
> especially the Security Requirements section. Execute task
> `tasks/09-security-review.md`: run /security-review, verify each requirement against
> the code, fix findings on this branch. When done, update TASKS.md.
