# 20 — Fix malformed `example` in the refresh 401 response

- **Branch:** `fix/openapi-refresh-example`
- **Depends on:** 19 (fixes a defect introduced by it)
- **Story points:** 1
- **Source:** `../CROSS_REPO_LEDGER.md` **CR-03** (app → backend)

## Scope

`openapi.json` only. In `POST /api/auth/session/refresh` → `responses.401.content`,
the `example` object sits as a **sibling** of `application/json` rather than inside
the media-type object. OpenAPIKit (via swift-openapi-generator, the app's locked
bridge) reads that stray key as a vendor extension and fails the whole app build
with `Found at least one vendor extension property that does not begin with 'x-'`.

Move the `example` inside the `application/json` object, matching the shape the
correct `bank`/`transactions` examples elsewhere in the file already use. Content
of the example is unchanged.

## Out of scope

- Any code, schema, endpoint, or error-code change — the served contract's
  *meaning* is identical before and after; only the JSON nesting is wrong.
- The unrelated `components.schemas.UserConfig.properties.columnMapping`
  `allOf` + `nullable` construct (see Notes) — it does not violate the OAS 3.0
  spec and the app's generator handles it today. Changing it could change the
  app's generated client for no benefit.

## Acceptance criteria

- [x] `paths./api/auth/session/refresh.post.responses.401.content` has exactly one
      key, `application/json`, whose object holds both `schema` and `example`.
- [x] No other `content` object anywhere in the file has a non-media-type key
      (swept programmatically — this was the only occurrence).
- [x] `openapi.json` parses as JSON and passes OpenAPI 3.0 spec conformance
      (`redocly lint --extends=minimal` → valid).
- [x] The fixed nesting is byte-equivalent in meaning to the patch the app applied
      locally, so `app/BackendContract/openapi.json` can be re-copied verbatim.
- [x] `/api/docs` still renders (the page serves this file unmodified).

## Notes

`redocly lint` under its default *recommended* ruleset reports one further error,
`nullable-type-sibling`, on `UserConfig.columnMapping` (`allOf` + `nullable: true`
with no `type`). That is a style rule, not a spec violation: the file is valid
under `--extends=minimal` (spec conformance only) and the app's codegen accepts
it. Left alone deliberately — deciding it needs the app agent to confirm what
`"type": "object"` would do to the generated Swift. The other 18 findings are
warnings (`operationId`, `info.license`) and were pre-existing.
