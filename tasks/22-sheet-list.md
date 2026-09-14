# 22 — Sheet list endpoint + Drive scope

- **Branch:** `feature/22-sheet-list`
- **Picked up from:** `../CROSS_REPO_LEDGER.md` **CR-02** (app → backend)
- **Story points:** 2

## Why

The app's onboarding screen 4 ("Where should we log your expenses?") is a **native
sheet picker** — the user taps their budget spreadsheet, the app saves it via
`POST /api/user/config { sheetId }`, and onboarding moves on. There is no way to
populate that list today: the Google consent only asks for the `spreadsheets`
scope, which grants read/write on a sheet whose id you already know and nothing
that can enumerate a Drive. Without this endpoint the app's only alternative is
asking the user to paste a spreadsheet URL, which is exactly the "leaving the app
to copy a link" experience screen 4 exists to avoid.

## Scope

- Add `https://www.googleapis.com/auth/drive.metadata.readonly` to `OAUTH_SCOPES`
  in `api/auth/google.ts` — read-only **metadata**, the narrowest scope that can
  list files. It cannot read a single cell of any document.
- New `GET /api/sheet/list` returning the verified caller's spreadsheets, newest
  first, plus the e-mail of the Google account the consent was granted for (the
  design's "alex@gmail.com · Connected" row).
- `lib/drive.ts` — the Drive client, built from the same stored refresh token as
  the Sheets client (`lib/sheets.ts`), with its own error mapping.
- Update `openapi.json` (rendered at `/api/docs`) and `APP_INTEGRATION.md`; flag
  both for re-copy into `app/BackendContract/`.

## Out of scope

- Creating a spreadsheet for the user ("Create new Sheet" is V2 in the design).
- Pagination / search. One bounded page of the most recently modified
  spreadsheets is the whole feature; the picker searches client-side.
- Shared drives (`corpora`/`includeItemsFromAllDrives`): personal Google accounts
  only, per the product spec.

## Response shape

```json
{
  "account": "alex@gmail.com",
  "sheets": [
    { "id": "1AbC…", "name": "Budget 2026", "modifiedTime": "2026-09-11T20:14:03Z" }
  ]
}
```

An object rather than the bare array CR-02 asked for: the screen needs the
account e-mail in the same breath, and a wrapper leaves room for a page token if
a user ever has more spreadsheets than one page.

## The decoding trap this task walked into

`modifiedTime` is emitted at **whole-second** precision. Drive answers
`2026-09-11T20:14:03.000Z`, and the iOS client decodes `format: date-time` with
swift-openapi-runtime's default transcoder — a bare `ISO8601DateFormatter`
(`.withInternetDateTime`, **no fractional seconds**). Milliseconds fail the
decode of the *entire* response, so the picker would come up empty with nothing
in either repo pointing at why. Truncated in `lib/drive.ts`.

**Latent elsewhere:** `expiresAt` on `GET /api/auth/bank/status` has the same
`date-time` format and is passed through from Postgres, which *does* emit
sub-second precision. It has never been hit because no dev user has a bank expiry
yet — filed as ledger **CR-06**, not fixed here.

## Error mapping (`lib/drive.ts`)

Drive fails differently from Sheets, and two of its 403s mean opposite things:

| Upstream | Returned | Why |
|---|---|---|
| 401 / `invalid_grant` | **401** `GOOGLE_TOKEN_EXPIRED` | Grant revoked/expired — re-run the consent. |
| 403 `insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | **401** `GOOGLE_TOKEN_EXPIRED` | The stored refresh token predates this task's scope. Same user action (re-consent), so the same code. |
| 403 `accessNotConfigured` / `SERVICE_DISABLED` | **500** `SUPABASE_ERROR` | The Drive API is not enabled on the Google project — a deployment fault, not the user's. Logged with the reason. |
| anything else | **500** `SUPABASE_ERROR` | Unknown upstream failure; message never propagated. |

## Acceptance criteria

- [x] `GET /api/sheet/list` returns `{ account, sheets[] }` for the verified caller —
      live: **23 spreadsheets** + the granting account's e-mail.
- [x] No Bearer token → 401; a user with no Google consent on file → 401
      `GOOGLE_TOKEN_EXPIRED`.
- [x] A refresh token granted before the Drive scope → 401 `GOOGLE_TOKEN_EXPIRED`
      (not a 403/500), so the app re-runs §5.2 rather than showing an error state.
- [x] The consent URL from `GET /api/auth/google?action=start` carries the Drive
      scope.
- [x] `openapi.json` + `APP_INTEGRATION.md` updated; ledger CR-02 → DONE.
- [x] `npm run typecheck` green; verified live against `vercel dev`.

**Verified end-to-end through the iOS app, 2026-09-14** (app task 11): a real consent granted
the Drive scope, the picker listed the account's spreadsheets, and the chosen id persisted via
`POST /api/user/config`. `modifiedTime` arrives as `2026-09-12T20:24:11Z` on live Drive data —
the truncation holds.

**Both error branches were exercised for real, not just by construction:** the pre-Drive grant
returned 401 (the app offered reconnect), and the Drive API being disabled returned 500 with
`the Google Drive API is not enabled on this project` in the log (the app offered a retry, and a
retry after enabling it worked with no second consent). Splitting those two 403s was the right
call — swapping them would have sent the owner through a reconnect that could not have helped.

## Owner actions (Google Cloud, outside this repo)

1. **Enable the Google Drive API** on the project owning `GOOGLE_CLIENT_ID`.
   Every call 403s with `SERVICE_DISABLED` until this is done. ✅ **Done by the owner
   2026-09-14** on project `925513096487` — and it was hit for real first, exactly as
   predicted.
2. Add `drive.metadata.readonly` to the OAuth consent screen's scope list. It is
   a Google-"sensitive" scope → **OAuth app verification before public launch**;
   test users can grant it today (already tracked in `app/TASKS.md` → Deferred).
3. Every existing user must re-run the Google consent once — a stored refresh
   token cannot gain a scope it was not granted.
