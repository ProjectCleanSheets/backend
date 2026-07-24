# CleanSheets — Backend Integration Guide (for the iOS app)

**Audience:** the iOS/SwiftUI app and any coding agents working in the Xcode
project. This is the contract between the app and the CleanSheets backend.

**Source of truth for field-level shapes:** [`openapi.json`](openapi.json)
(rendered at `/api/docs`). This guide covers what OpenAPI *can't* express — the
auth model, the multi-step OAuth flows, deep links, error semantics, and product
rules. When the two disagree, `openapi.json` wins for request/response shapes;
this guide wins for *how the flows fit together*.

**How to keep this accurate:** the backend keeps `openapi.json` in sync with the
API on every change. Copy `openapi.json` into the iOS repo and, whenever the
backend contract changes, re-copy it and regenerate the client (below). Do not
hand-transcribe field shapes into Swift — generate or read them from the spec.

---

## 1. Recommended data bridge: generate a Swift client

Use Apple's official **[swift-openapi-generator](https://github.com/apple/swift-openapi-generator)**
(a SwiftPM build plugin) with `openapi.json` as input. It emits type-safe Swift
request/response types and a client, so the app's models can never silently drift
from the backend.

Packages to add:
- `apple/swift-openapi-generator` (build plugin)
- `apple/swift-openapi-runtime`
- `apple/swift-openapi-urlsession` (URLSession transport)

Wiring:
1. Drop a copy of `openapi.json` into the app target and register the generator
   build plugin against it.
2. Provide the base URL (see §3) and an auth middleware that injects the
   `Authorization: Bearer <identity_token>` header on every request (see §4).
3. Regenerate whenever you re-copy `openapi.json`.

A hand-written `URLSession` layer is fine too — if so, treat §6 (endpoint index)
plus `openapi.json` as the reference and still centralize the Bearer header and
the `{ code, message }` error decoding.

---

## 2. Mental model

- The backend is the **only** thing that talks to Google Sheets, Enable Banking
  (PSD2 bank data), and Supabase. The app never holds Google/bank tokens and
  never sends spreadsheet cell references — all sheet navigation happens
  server-side.
- The app's job: authenticate the user, drive the two consent flows, and call
  JSON endpoints to read/write budget data.
- Identity is **server-derived from the bearer token on every request**. The app
  never sends a user id in a body or query; there is no "user id" parameter
  anywhere. Whatever account the bearer token proves is the account acted on.

---

## 3. Environments

| | Base URL | Backend DB |
|---|---|---|
| **Development** | `http://localhost:3000` (run `vercel dev` in the backend repo) | dev Supabase (`cleansheets-dev`) |
| **Production** | `https://backend-beryl-phi-32.vercel.app` | prod Supabase |

Build and test the app against **dev** (`vercel dev`). Point at the prod URL only
when shipping. Make the base URL a build configuration value, not a hardcoded
constant.

---

## 4. Authentication

Every request (except the browser-only OAuth callbacks, which the app never
calls) must include:

```
Authorization: Bearer <identity_token>
```

`<identity_token>` is **either**:
- a **Google ID token** from native Google Sign-In, or
- an **Apple identity token** from Sign in with Apple.

The backend verifies the token's signature, issuer, audience, and expiry on every
request, and maps the verified `(provider, subject)` to a stable internal user.
The **first** authenticated request for a new identity provisions the user row
automatically — there is no separate "register" call.

- `POST /api/auth/google` is a convenience "who am I / what's my setup state"
  call (returns `userId`, `provider`, `hasConfig`, `hasSheetsAccess`). Despite the
  name it works for Apple-login users too — call it after sign-in to learn what
  onboarding steps remain.
- A missing/invalid/expired token returns **401** with code
  `GOOGLE_TOKEN_EXPIRED` → route the user back to sign-in and refresh the identity
  token.

**Important:** the login identity (Google or Apple) is decoupled from the Google
account that owns the spreadsheet. An Apple-login user still connects a Google
account for Sheets access via the flow in §5.2. "Signed in" and "has Sheets
access" are independent states — check `hasSheetsAccess`/`hasConfig`.

---

## 5. The two consent flows (the part that's easy to get wrong)

Both external consents (bank + Google Sheets) use the **same two-step pattern**:
a browser consent, then an authenticated `finalize`. This exists for security: the
browser callback can't be trusted to attach a credential to an account, so it
parks the result behind a one-time, short-lived (~2 min), single-use `handle`,
and the app finalizes it under its own verified auth. **Only the account that
started the flow can finalize it.**

Use `ASWebAuthenticationSession` for the browser step, with callback scheme
`cleansheets`.

### 5.1 Bank connection (Enable Banking / PSD2)

1. `GET /api/auth/bank` (Bearer). In production also pass `?bank=<name>&country=<ISO2>`
   (e.g. `country=DK`); in sandbox it defaults to the Mock ASPSP. → `{ "url": "…" }`
2. Open `url` in `ASWebAuthenticationSession`.
3. On success the browser redirects to the deep link:
   `cleansheets://oauth/bank?status=success&handle=<handle>`
   (denial → `cleansheets://oauth/bank?status=denied`).
4. `POST /api/auth/bank/finalize` (Bearer) with `{ "handle": "<handle>" }`.
   → `{ "status": "connected", "expiresAt": "<ISO8601>" }`

Then check health anytime with `GET /api/auth/bank/status` →
`{ status: "healthy" | "expiring" | "expired", expiresAt, renewAvailable }`.
Show a reconnect/renew affordance when `renewAvailable` is true (`expiring` within
14 days of expiry, or already `expired`). Enable Banking issues no refresh token —
an expired consent can only be fixed by re-running this flow.

### 5.2 Google Sheets connection

1. `GET /api/auth/google?action=start` (Bearer). → `{ "url": "…" }`
2. Open `url` in `ASWebAuthenticationSession`.
3. On success: `cleansheets://oauth/google?status=success&handle=<handle>`
   (denial → `?status=denied`).
4. `POST /api/auth/google/finalize` (Bearer) with `{ "handle": "<handle>" }`.
   → `{ "status": "connected" }`

After this, `hasSheetsAccess` (from `POST /api/auth/google`) becomes true and the
sheet endpoints in §6 work.

### finalize failure cases (both flows)

`finalize` maps to distinct statuses the app should handle:
- **404** (`INVALID_REQUEST`) — unknown/already-used handle → restart the flow.
- **400** (`INVALID_REQUEST`) — handle expired (older than ~2 min) → restart.
- **403** (`INVALID_REQUEST`) — the handle belongs to a different account →
  restart under the correct account.

---

## 6. Endpoint index

Paths, payloads, and response schemas are defined in `openapi.json`; this is the
map. All require `Authorization: Bearer …`.

**Auth / onboarding**
- `POST /api/auth/google` — sign-in / setup state (`hasConfig`, `hasSheetsAccess`).
- `GET  /api/auth/google?action=start` → Google Sheets consent URL.
- `POST /api/auth/google/finalize` — finalize Sheets consent (§5.2).
- `GET  /api/auth/bank` → bank consent URL.
- `POST /api/auth/bank/finalize` — finalize bank consent (§5.1).
- `GET  /api/auth/bank/status` — bank consent health.

**Config**
- `GET  /api/user/config` — current `{ sheetId, columnMapping }` (null until set).
- `POST /api/user/config` — set `sheetId` and/or `columnMapping`.

**Sheet data**
- `GET  /api/sheet/structure` — tabs + detected category rows for the sheet.
- `GET  /api/sheet/budget` — budget overview (per-section Budget/Actual + totals).
- `POST /api/sheet/category` — create a new category row in a section.

**Transactions & saving**
- `GET  /api/transactions` — the bank transaction queue (see product rule below).
- `POST /api/sheet/save` — categorize a transaction into the sheet. Body:
  `{ section, category, amount, transactionId, date (YYYY-MM-DD), status: "booked"|"pending" }`.
- `DELETE /api/sheet/save` — undo the most recent save for a `transactionId`
  (reverses the money only). Body: `{ transactionId }`.

**Account**
- `DELETE /api/user/account` — **delete the user's account and all
  backend-stored data.** Best-effort-revokes the Google + bank grants; leaves the
  user's Google Sheet (incl. its `_log` tab) untouched. Idempotent →
  `{ deleted: true, note }`. **This must be reachable from inside the app** — it's
  required by App Store Review Guideline 5.1.1(v). Ship a Settings action that
  calls it (with a confirmation step), then signs the user out locally.

---

## 7. Error handling contract

Every error response is `{ "code": "<CODE>", "message": "<human readable>" }` with
an appropriate HTTP status — never a stack trace. Decode `code` and branch on it;
show `message` only as a fallback. Codes:

| Code | Meaning | App reaction |
|---|---|---|
| `GOOGLE_TOKEN_EXPIRED` | Missing/invalid identity token (401) | Re-authenticate; refresh the identity token and retry. |
| `BANK_TOKEN_EXPIRED` | Bank consent lapsed | Prompt to reconnect the bank (run §5.1). |
| `SHEET_NOT_FOUND` | Sheet/tab not accessible | Prompt to re-check the sheet or reconnect Google (§5.2). |
| `CATEGORY_NOT_FOUND` | No matching section+category row | Offer to create the category (`POST /api/sheet/category`) or pick another. |
| `SHEET_WRITE_FAILED` | Google Sheets write failed | Transient — offer retry. |
| `SUPABASE_ERROR` | Backend/DB failure | Transient — offer retry; log. |
| `INVALID_REQUEST` | Malformed/missing fields, or a bad OAuth handle | Fix the request; for finalize see §5 (404/400/403). |

---

## 8. Product rules the UI must respect

- **Pending transactions are included** in `GET /api/transactions`, marked
  `status: "pending"`, so a purchase can be categorized immediately. Accepted
  trade-off: the saved amount may drift from the finally booked amount, and rarely
  a booked transaction reappears under a new id. Reconciliation is V2. When saving,
  pass the transaction's `status` (`"booked"`/`"pending"`) through to
  `POST /api/sheet/save` — it affects deduplication.
- **The app never computes cell references.** Send `{ section, category, amount,
  transactionId, date, status }`; the backend finds the month tab and the
  section+category row and does the read-modify-write.
- **Undo reverses money only** — the category row created by a save stays.
- **Column mapping** is user-configurable per section (which columns are category
  / budget / actual / left) and stored server-side via `/api/user/config`. The app
  configures it during onboarding; defaults exist.

---

## 9. Onboarding sequence (suggested)

1. Sign in (Google or Apple) → obtain identity token.
2. `POST /api/auth/google` → read `hasConfig` / `hasSheetsAccess`.
3. If no Sheets access → run the Google Sheets consent flow (§5.2).
4. Set the sheet + column mapping → `POST /api/user/config`.
5. If no bank connection → run the bank consent flow (§5.1).
6. Load data: `GET /api/sheet/budget`, `GET /api/transactions`.
7. Provide, in Settings: bank status/reconnect, and **account deletion**
   (`DELETE /api/user/account`).
