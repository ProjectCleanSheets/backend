# 21 — Accept the iOS OAuth client's audience on the session exchange

- **Branch:** `fix/21-ios-client-audience`
- **Raised by:** app agent (ledger CR-04) — blocks app task 08
- **Story points:** 1

## The bug

`POST /api/auth/session` rejects every Google identity token the iOS app sends,
with `401 GOOGLE_TOKEN_EXPIRED "Missing or invalid identity token"`.

`verifyGoogleToken` (`lib/auth.ts`) verifies against a single audience:

```ts
const clientId = process.env.GOOGLE_CLIENT_ID;
const ticket = await verifierClient.verifyIdToken({ idToken, audience: clientId });
```

`GOOGLE_CLIENT_ID` is the **Web** OAuth client — it is paired with
`GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` for the server-side Sheets
consent flow, which is what a web client is for.

But the app signs in with the **iOS** OAuth client (`GIDClientID` in its
`Info.plist`, no `GIDServerClientID`), so its ID tokens carry
`aud = <iOS client id>`. Same Google project, different client — the audience
check can never pass, and `verifyGoogleToken` swallows the exception and returns
`null`.

Confirmed end to end: the iOS simulator log shows
`POST http://localhost:3000/api/auth/session … status 401` with a 1524-byte
request body (a real, freshly-issued Google ID token).

## Scope

- Verify against **both** clients. `verifyIdToken` accepts an array for
  `audience`, so no other logic changes.
- Add `GOOGLE_IOS_CLIENT_ID` to `.env.example` and document it. Treat it as
  optional so an unset value keeps today's single-audience behaviour rather than
  breaking the web flow.
- The iOS client id is **not a secret** (it ships inside the app binary), same as
  the web client id.

## Out of scope

- Apple's audience: `verifyAppleToken` already checks `APPLE_CLIENT_ID`, which is
  the bundle id and is correct.
- Any change to the Sheets consent flow — it keeps using the web client.

## Acceptance criteria

- [ ] A Google ID token minted for the **iOS** client is accepted by
      `POST /api/auth/session` and yields a token pair.
- [ ] A token minted for the **web** client is still accepted (the docs page flow).
- [ ] A token for any *other* audience is still rejected 401 — the fix widens the
      allowed set, it does not disable the check.
- [ ] `tsc --noEmit` green.
