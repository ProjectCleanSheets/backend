# 23 — Whole-second timestamps on the contract's `date-time` fields

- **Branch:** `feature/23-whole-second-timestamps`
- **Picked up from:** `../CROSS_REPO_LEDGER.md` **CR-06** (app → backend)
- **Story points:** 1

## Why

The iOS client decodes every `format: date-time` field with
swift-openapi-runtime's **default** transcoder — a bare `ISO8601DateFormatter`,
i.e. `.withInternetDateTime` and **no fractional seconds**. Verified directly:

```
ok        2026-10-12T09:30:00+00:00
ok        2026-10-12T09:30:00Z
REJECTED  2026-10-12T09:30:12.473+00:00
REJECTED  2026-12-14T09:30:12.473Z
```

A `date-time` failure fails the **whole response**, not the one field. And
`GET /api/auth/bank/status` is read at **every launch** by the app's
`BackendSetupStateLoader`, so a bank-connected user would get a thrown decode on
every cold start; `AppState.refresh()` would swallow it and fall back to the last
known facts, leaving the app looking stuck for a reason neither repo's logs name.

**This is not hypothetical.** `lib/enablebanking.ts` mints the value itself:

```ts
const validUntil = new Date(Date.now() + consentValidityDays() * MS_PER_DAY);
// …requested as
access: { valid_until: validUntil.toISOString() }   // → "2026-12-14T09:30:12.473Z"
```

`Date.now()` carries milliseconds ~999 times in 1000, so the *requested* expiry
is sub-second precise, and `exchangeCode` stores whatever Enable Banking echoes
back (`data.access.valid_until`) verbatim into `bank_token_expiry`. Whether EB
echoes it unchanged is the one unknown — and it is not worth relying on, because
Postgres `timestamptz` preserves whatever precision it is given and PostgREST
returns it.

**Why it has never been seen:** no dev user has a bank expiry at all
(`bank_token_expiry` is `null` for the only row), because Enable Banking's
sandbox authenticates by e-mail magic link and that leg cannot be completed from
a simulator (task 09's note). The first person to complete a real bank consent
hits it.

## Scope

Truncate to whole seconds at **both** ends of the bank consent:

1. **When requesting** — `lib/enablebanking.ts`, the `valid_until` sent to
   Enable Banking. A whole-second request makes a verbatim echo harmless.
2. **When serving** — `api/auth/bank.ts`, `expiresAt` on both the
   `POST /api/auth/bank/finalize` 200 and the `GET /api/auth/bank/status` 200, so
   a value already stored with milliseconds (or one EB invents) is still
   decodable.

Task 22 already wrote this helper as a private function in `lib/drive.ts`
(`toWholeSecondISO`, for Drive's `modifiedTime`). **Extract it to a shared
`lib/time.ts` and have both call it** — two copies of a rule the contract depends
on is exactly how the two drift.

## Out of scope

- Changing the client's date transcoder. Configuring
  `.iso8601WithFractionalSeconds` on the app side was considered and rejected: it
  merely moves the failure to values *without* a fractional part, and the
  contract should not depend on which of two mutually exclusive client
  configurations is in force.
- A migration. Nothing stored needs rewriting — the only row's value is `null`,
  and serving truncates anyway.

## Acceptance criteria

- [ ] `expiresAt` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$`
      on both endpoints that return it.
- [ ] The `valid_until` sent to Enable Banking carries no fractional seconds.
- [ ] `toWholeSecondISO` lives in one place and both `lib/drive.ts` and
      `api/auth/bank.ts` use it; Drive's `modifiedTime` behaviour is unchanged.
- [ ] A `null` expiry still serialises as `null` (no bank connected).
- [ ] `npm run typecheck` green.
- [ ] Ledger CR-06 → DONE, with a note that **no contract re-copy is needed** —
      the schema is unchanged, only the values it carries.

## How to verify without a real bank consent

The happy path cannot be driven from a simulator, so verify the serialisation
directly: plant a `bank_token_expiry` with milliseconds on the dev user
(e.g. `2026-12-14T09:30:12.473+00:00`), call `GET /api/auth/bank/status`, and
confirm the response carries whole seconds. Put the row back to `null`
afterwards — a non-null expiry changes the app's derived `AppPhase`.
