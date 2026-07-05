# 10 — Swagger API docs

- **Branch:** rides on `feature/scaffold-auth` (dev tooling for testing all tasks)
- **Depends on:** 01
- **Story points:** 2

## Scope

- `openapi.json` — OpenAPI 3.0 spec for all backend endpoints. **Every task that adds
  or changes an endpoint must update this file** — the docs page is only useful if it
  stays current.
- `api/docs.ts` — serves Swagger UI (CDN assets, no extra npm deps):
  - `GET /api/docs` — interactive Swagger UI page
  - `GET /api/docs?spec=1` — the raw OpenAPI JSON
  - Google Sign-In button on the page issues a real ID token in the browser and
    auto-attaches it as `Authorization: Bearer <token>` to Try-it-out requests
    (manual Authorize button still works too)

## One-time setup (Google Cloud Console)

The web OAuth client needs these **Authorized JavaScript origins** for the sign-in
button to work:
- `http://localhost:3000` (local `vercel dev`)
- `https://backend-beryl-phi-32.vercel.app` (production)

## Out of scope

- Auth-gating the docs page itself (endpoints are already auth-gated; spec is not secret)

## Acceptance criteria

- [ ] `/api/docs` renders Swagger UI listing all current endpoints with schemas and
      the shared error response format.
- [ ] After Google sign-in on the page, Try-it-out requests succeed against auth-gated
      endpoints without manually copying tokens.
- [ ] No new npm dependencies; `tsc --noEmit` passes.
