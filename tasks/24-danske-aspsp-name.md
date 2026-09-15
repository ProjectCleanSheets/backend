# 24 — Confirm Danske Bank's production ASPSP name

- **Branch:** `feature/24-danske-aspsp-name` (may end as docs only)
- **Picked up from:** `../CROSS_REPO_LEDGER.md` **CR-05** (app → backend)
- **Story points:** 2 — mostly investigation, and gated on access this repo does
  not have today

## Why

`GET /api/auth/bank` passes `bank`/`country` straight through to Enable Banking's
`POST /auth`, and **production has no fallback**:

```ts
export function defaultAspsp(): Aspsp | null {
  return process.env.ENABLE_BANKING_ENV === 'sandbox'
    ? { name: 'Mock ASPSP', country: 'FI' }
    : null;          // ← production must be told exactly which bank
}
```

So the app has to name the bank exactly, and today it names a **guess**:
`app/CleanSheets/Config/Release.xcconfig` carries `BANK_ASPSP_NAME = Danske Bank`.
If the real listing spells it differently, the **first screen a real user
reaches** returns 400 and onboarding is dead on arrival.

## Why it cannot be answered from here

An Enable Banking **sandbox** application only lists ASPSPs that run their own
sandbox environments. Queried with this backend's own credentials (2026-09-08):
815 ASPSPs across 29 countries, and for **DK** exactly — Nordea · Nordea
Corporate · Vestjysk Bank · Mock ASPSP · Saxo Bank · Nordea First Card. That
matches Enable Banking's own docs, which name Nordea, Saxo Bank and VestjyskBank
as the three Danish banks offering sandboxes, so **Danske's absence is the
environment, not coverage** — Enable Banking's Denmark market page lists Danske
Bank first among supported Danish ASPSPs
(https://enablebanking.com/docs/markets/dk/).

Confirmed live against `vercel dev` the same day: `?bank=Nordea&country=DK` →
**200** with a real consent URL; `?bank=Danske%20Bank&country=DK` → **400**
(Enable Banking 422 "Wrong ASPSP name provided"). So the guess is unverifiable
here either way.

Re-checked 2026-09-15: `defaultAspsp()` and the Release placeholder are
unchanged, so the entry stands exactly as filed.

## Scope

1. From a **production** Enable Banking application, read `GET /aspsps?country=DK`
   and record the exact `name` for **Danske Bank (personal)** — including whether
   it is listed once or split by segment (private/business), since the app must
   name one exactly.
2. Set `app/CleanSheets/Config/Release.xcconfig` `BANK_ASPSP_NAME` to it (app
   repo — hand back through the ledger).
3. If production access is not available yet, **say so explicitly** and record
   what stands in the way; that is a valid outcome for this task.

## Also worth fixing while in here (small, independent)

**A space in `bank` must arrive percent-encoded.** `?bank=Mock+ASPSP&country=FI`
is forwarded literally as `Mock+ASPSP` and earns the same 422, while
`?bank=Mock%20ASPSP&country=FI` succeeds — the query parser in front of
`startQuerySchema` does **not** treat `+` as a space. The app sends `%20` (pinned
by a test), so nothing is broken today, but normalising `+` server-side would
remove a trap for any future client. Every Danish ASPSP name has a space in it.

## The gate behind the gate

Enable Banking's docs say an application cannot be made public before a contract
is signed, and real-bank access needs TPP licensing / eIDAS certificates (or
Enable Banking acting as agent). Worth confirming where the project stands on
that before the launch checklist assumes production access is a formality.

## Acceptance criteria

- [ ] The exact production ASPSP name for Danske Bank DK (personal), **or** a
      written statement of what stands in the way of getting it.
- [ ] If obtained: `BANK_ASPSP_NAME` updated in the app repo and the ledger entry
      resolved with the value.
- [ ] Optional: `+` normalised to a space in the `bank` query parameter.

## Blocks

The **first production build** — nothing before it. Debug omits both params and
uses the sandbox Mock ASPSP, which is why app task 10 shipped and onboarding
works in dev.
