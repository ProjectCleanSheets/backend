// Timestamp formatting for everything this backend puts in a `format: date-time`
// field. One rule, one home: the contract depends on it, and two copies of it
// are exactly how the two would drift (task 23).

/**
 * RFC 3339 at **whole-second** precision — the only shape of `date-time` the iOS
 * client can actually read.
 *
 * swift-openapi-runtime decodes every `format: date-time` with its *default*
 * transcoder: a bare `ISO8601DateFormatter`, i.e. `.withInternetDateTime` and
 * **no fractional seconds**. `2026-12-14T09:30:12.473Z` returns nil there, and a
 * `date-time` failure fails the decode of the **whole response**, not the one
 * field — so a single stray millisecond blanks a screen for a reason neither
 * repo's logs would name. `GET /api/auth/bank/status` is read at every app
 * launch, which makes it a cold-start failure rather than a cosmetic one.
 *
 * Milliseconds arrive from both directions: Drive answers
 * `2026-09-11T20:14:03.000Z` (task 22), and the bank consent expiry is minted
 * here as `new Date(Date.now() + …)`, which lands on a whole second about once
 * in a thousand times (task 23 / ledger CR-06). Truncating at every point a
 * timestamp leaves this backend keeps the contract decodable under the *default*
 * configuration on both sides — the app should not have to be configured into
 * being able to read us, and the fix must not depend on which of two mutually
 * exclusive client configurations is in force.
 *
 * Returns '' for a missing or unparseable value; each caller decides what that
 * means (Drive drops the file, the bank status reports no expiry).
 */
export function toWholeSecondISO(value: string | Date | null | undefined): string {
  const ms = value instanceof Date ? value.getTime() : value ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    return '';
  }
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}
