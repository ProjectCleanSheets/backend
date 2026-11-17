# 40 — One Actual-cell read-modify-write

- **Status:** Backlog. From task 30 finding #4 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
- **Size:** 1 pt.

## Why
`save.ts` (`locateActualCell`) and `category.ts` each do the same two-column read, "blank counts as 0" and rounding. 32 and 35 would add a third copy.

## Scope
Move "find the category row and its current Actual" and "add an amount to it" into `lib/saveflow.ts`; both endpoints call it. Behaviour and responses unchanged. Tests for the new helper.

## Order
After 39, **before 32**.
