# Task 09 — Security review summary

Reviewer pass over the whole backend (all `api/` + `lib/`, `supabase/migrations/`,
`vercel.json`, `api/docs.ts`) on branch `feature/security-review`, 2026-07-19.
Method: `/security-review` (identify → parallel false-positive filter → keep only
confirmed findings) plus a manual line-by-line check of every CLAUDE.md Security
Requirement against the code.

## Outcome

- **1 confirmed finding** (Medium, bank data disclosure) — filed as
  [task 15](15-bank-callback-binding.md). **Unresolved**; it gates the flip to
  `ENABLE_BANKING_ENV=production`.
- **`npm audit --omit=dev`: 0 vulnerabilities.** The 10 advisories in the full
  tree are all transitive dev-only deps of `@vercel/node` (see below) — not in
  the deployed runtime. Accepted, not fixed.
- Every Security Requirements item verified present in code (references below).
- **Secret rotation still outstanding** — owner-only external-console actions,
  see the checklist at the bottom. Not done by this branch.

## Confirmed finding

### F1 — Bank OAuth callback binds a victim's consent to the attacker's account · Medium · confidence 8/10

`api/auth/bank.ts` `handleCallback` stores the exchanged Enable Banking session
under the `google_id` carried by `state`, with no check that the consenting
account is the flow initiator (the Google callback has this check at
`api/auth/google.ts:127-133`; Enable Banking returns no identity token to
compare, so the bank callback omits it). An attacker who phishes a victim through
the attacker's own consent URL ends up holding the victim's bank session and can
read the victim's transactions via `GET /api/transactions`. Full write-up,
exploit trace, and fix in [task 15](15-bank-callback-binding.md).

## Security Requirements verification (CLAUDE.md → code)

| Requirement | Status | Evidence |
|---|---|---|
| **ID token verification** — signature via google-auth-library, `aud === GOOGLE_CLIENT_ID`, expiry; identity only from the token | ✅ | `lib/auth.ts:28-37` `verifyIdToken({ idToken, audience: clientId })`, identity from `payload.sub` only. All 8 endpoint handlers call `getVerifiedUser` before any work; the one public route (`api/docs.ts`) is public by design and touches no user data. |
| **Token encryption** — AES-256-GCM, random IV per value, key from `ENCRYPTION_KEY`, never CBC/ECB | ✅ | `lib/crypto.ts:5` `aes-256-gcm`; `:7,29` fresh 12-byte random IV per `encryptToken`; auth tag stored + verified on decrypt (`:31,40`); key validated to 32 bytes (`:20-22`). |
| **Supabase isolation** — service-role key, RLS on, every query filters by verified `google_id` | ✅ | `lib/supabase.ts` service-role client; `supabase/migrations/001_users.sql` RLS enabled, no policies, `grant all` to `service_role` only. All 10 `.from('users')` queries key on the verified id: 9 via `.eq('google_id', …)`, the 10th is the upsert whose payload is `{ google_id: verifiedId }` (`api/auth/google.ts:57`). No identity is ever read from body/query. |
| **OAuth CSRF** — `state` bound to the user, validated on callback | ✅ (with F1 caveat) | `lib/auth.ts:57-87` HMAC-SHA256 state, HKDF-derived key, `timingSafeEqual` with length guard, 10-min TTL, payload type-checked. Validated in both callbacks (`api/auth/google.ts:115`, `api/auth/bank.ts:144`). **Caveat:** state proves the *initiator*, not the *consenter* — see F1 for the bank flow. |
| **Ownership** — every read/write operates only on the caller's rows/sheets | ✅ | Config/save/budget/transactions/status all load by verified `google_id`. Sheet reads/writes go through `getSheetsForUser(googleId)` (`lib/sheets.ts:33-59`), which opens the sheet with the caller's *own* stored Google token, so Google's ACL enforces ownership even where `sheetId`/`tab` come from the request (`structure.ts`, `budget.ts`). |
| **Input validation** — zod on every body/query, reject `INVALID_REQUEST`, bound amounts | ✅ | zod schemas in `config.ts`, `save.ts`, `category.ts`, `structure.ts`, `budget.ts`, `bank.ts`; amounts bounded by `MAX_TRANSACTION_AMOUNT` (`lib/constants.ts:28`), sheet id / column / name / tab bounded by the patterns and length caps in `constants.ts`. Stored column mapping re-validated before splicing into an A1 range (`lib/saveflow.ts:112-117`). |
| **No secret leakage** — never log tokens/PEM/sheet contents; errors expose only `code`/`message`, no stack traces | ✅ | All 10 `console.error` sites log only `err.message` / Supabase `error.message` / sanitized `String(err)`. `EnableBankingError` and `SheetsError` carry status/path/short reason only, never response bodies or tokens (`lib/enablebanking.ts:59-102`, `lib/sheets.ts:14-90`). `loadPrivateKey`/session ids never logged. Responses go through `sendError` (`lib/errors.ts`) — structured `{ code, message }` only. |
| **A1 / formula injection** (defense in depth) | ✅ | Tab names single-quoted with `'`→`''` doubling (`lib/sheets.ts:93-95`); ranges built only from pattern-validated column letters + numeric rows; session/account ids `encodeURIComponent`-escaped (`lib/enablebanking.ts:213,246`). Both sheet writes use `valueInputOption: 'RAW'` (`lib/sheets.ts:205,227`) so user text can't become a formula. |
| **XSS / redirect injection** in the public docs page | ✅ | `api/docs.ts:69` interpolates only `GOOGLE_CLIENT_ID` (env-sourced, public by design) via `JSON.stringify`; no user input reaches the HTML. Redirect targets are constant `cleansheets://` deep links with fixed `status` values. |
| **Rate limiting** | ⏸️ Deferred | Documented accepted risk (Vercel free tier) — CLAUDE.md + TASKS.md Deferred section. |

## npm audit

`npm audit --omit=dev` → **0 vulnerabilities** (deployed runtime is clean).

Full-tree audit reports 10 advisories (4 moderate, 6 high) in `undici@5.28.4`
and `smol-toml@1.5.2`. Both are transitive dependencies of `@vercel/node` (a
**devDependency** — types + local dev only): `npm ls undici --omit=dev` returns
an empty tree, i.e. neither ships to the Vercel serverless runtime. The advisories
are DoS / request-smuggling / cookie-parsing issues in undici's HTTP client and
TOML parsing — the backend does not use `@vercel/node`'s HTTP client at runtime.
`npm audit fix --force` would **downgrade** `@vercel/node` to v4 (a breaking
change) to satisfy the resolver, which is not warranted for a dev-only path.
**Accepted; revisit when `@vercel/node` ships a patched undici.**

## Public repo — verified clean (2026-07-19)

`ProjectCleanSheets/backend` is a **public** GitHub repo (owner keeps it public
while on the Vercel free tier, pre-App-Store launch). Confirmed no secret is
exposed through it:

- No `.env`, `*.pem`, or credential/secret file was **ever** committed — full
  history (41 commits, all branches) only ever added source, docs, and
  `.env.example`.
- `.env.example` holds empty placeholders only; a pattern scan of every tracked
  file for Google `GOCSPX-` secrets, PEM private keys, and Supabase JWTs found
  nothing.
- `Credentials/CREDENTIALS.md`, the `.pem`, and the Google `client_secret` JSON
  live in the `CleanSheets` **parent** folder, which is not a git repo — they are
  local-only and never pushed.

The burned secrets (below) were exposed via a chat transcript, **not** the repo.
`.gitignore` blocks `.env*` except `.env.example`, so the history stays clean
going forward. Rotating and storing new values in Vercel env + the out-of-repo
`CREDENTIALS.md` does not publish them.

## Secret rotation — OUTSTANDING (owner action)

On 2026-07-11 the full `.env` was pasted into a chat transcript, so all four
shared secrets are burned and must be rotated before production. These are
external-console actions the review cannot perform; do them, then update Vercel
env vars, local `.env`/`.env.local`, and `Credentials/CREDENTIALS.md`:

1. **`GOOGLE_CLIENT_SECRET`** — regenerate in Google Cloud Console (APIs &
   Services → Credentials → the OAuth client). Old secret stops working
   immediately; redeploy with the new value.
2. **`SUPABASE_SERVICE_ROLE_KEY`** — rotate in Supabase dashboard (Project
   Settings → API → service_role → roll) for **both** the prod and
   `cleansheets-dev` projects.
3. **`ENABLE_BANKING_PRIVATE_KEY`** — generate a new key pair in the Enable
   Banking control panel, replace the PEM env var, keep the old `.pem` out of
   the repo.
4. **`ENCRYPTION_KEY`** — generate a new 32-byte key
   (`openssl rand -base64 32`). Rotating it makes every stored ciphertext
   (`google_refresh_token`, `bank_access_token`) undecryptable, so after
   swapping the key, null those columns so users re-consent — the code already
   degrades gracefully (`getSheetsForUser` → `GOOGLE_TOKEN_EXPIRED` → re-sign-in;
   transactions → `BANK_TOKEN_EXPIRED` → reconnect):
   ```sql
   -- run in BOTH prod and cleansheets-dev after setting the new ENCRYPTION_KEY
   update public.users
     set google_refresh_token = null,
         bank_access_token   = null,
         bank_refresh_token  = null,
         bank_token_expiry   = null;
   ```
   Then re-run the Google and bank consent flows for the dev/test accounts.

## Gate decision

`ENABLE_BANKING_ENV=production` remains **blocked** until (a) F1/task 15 is
resolved or explicitly risk-accepted by the owner, and (b) all four secrets are
rotated and verified. Task 09 stays In Progress until then.
