# 13 — Constants & naming cleanup

- **Branch:** `chore/constants-cleanup`
- **Depends on:** 05 (refactors its code — branched from `feature/sheet-save`, merge after 05)
- **Story points:** 2

## Scope

Code-quality pass over the whole backend; zero behavior change.

- New `lib/constants.ts` holding values shared by more than one file:
  request-validation patterns and length caps (sheet id, column letters,
  section/category/tab/transaction-id), the default F/G/H/I column layout,
  the shared sheet scan depth, money precision (2 decimals) and the
  transaction amount bound, `MS_PER_DAY`, ISO date length/pattern.
- Single-use tuning values stay in their own file but get a named constant
  and a comment (title-search radii and header lookaheads in structure
  detection, `_log` scan depth, consent-day cap, error-detail truncation,
  key sizes in crypto/auth).
- Rename non-descriptive identifiers: `EbTransaction` →
  `EnableBankingTransaction`, logtab `text()` → `cellText()`, sheets `a1()`
  → `a1Range()`, single-letter loop vars in `api/sheet/structure.ts`.

## Out of scope

- Any API contract, DB schema, error-code, or openapi.json change.
- HTTP status codes and idiomatic epoch math (`Date.now() / 1000`) stay inline.

## Acceptance criteria

- [ ] No bare numeric literal or duplicated pattern whose meaning isn't
      obvious from an adjacent named constant or comment.
- [ ] Values used by more than one file live in `lib/constants.ts`; values
      used once stay local and named.
- [ ] API responses, error codes, and openapi.json byte-identical in meaning
      (no contract drift).
- [ ] `tsc --noEmit` passes; task-05 stub tests still pass.
