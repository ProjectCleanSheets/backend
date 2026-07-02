# 08 — Settings endpoints

- **Branch:** `feature/settings`
- **Depends on:** 02 and 03 (07 recommended first — completes the happy path)
- **Story points:** 2

## Scope

1. Extend `api/user/config.ts` POST to also accept and save updated `column_mapping`
   and `sheet_id` (re-mapping columns and switching sheets from iOS Settings).
2. Add `GET /api/auth/bank/status` to `api/auth/bank.ts`:
   - Read the user's `bank_token_expiry` from Supabase
   - Return `{ status: 'healthy' | 'expiring' | 'expired', expiresAt, renewAvailable }`
   - `renewAvailable` is true when expiry is within 14 days

## Out of scope

- Notification settings (purely on-device), category rename/reorder

## Acceptance criteria

- [ ] Config updates validated with zod (`column_mapping` shape per CLAUDE.md);
      `INVALID_REQUEST` on bad input.
- [ ] Config writes affect only the verified caller's row (google_id from token).
- [ ] Bank status thresholds correct: `expired` past expiry, `expiring` within 14 days,
      else `healthy`; `renewAvailable` true within 14 days of expiry.
- [ ] Endpoints auth-gated; structured errors per CLAUDE.md.
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting — especially
> the Security Requirements and Task Board sections. Tasks 01–07 are already built.
> Implement task `tasks/08-settings.md` exactly as scoped. When done, update TASKS.md.
