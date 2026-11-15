# 37 — Send PSU headers on user-initiated bank fetches

- **Status:** Backlog, low priority. Split out of task 29 (2026-11-15).
- **Size:** 1 pt.

## Why
Task 29 showed Danske doesn't enforce PSD2's 4-a-day limit on unattended fetches today,
and lists no required PSU headers. Other banks do (Enable Banking's 0.16.9 notes:
Länsförsäkringar raises `RateLimitException` when the daily limit is reached; Alior adds
`isDirectPsu` to avoid it). Marking a pull-to-refresh as user-initiated is the correct
use of the API and protects other banks' users once they connect.

## Scope
- On `GET /api/transactions`, forward the caller's IP (`x-forwarded-for`, first hop) and
  `user-agent` as `Psu-Ip-Address` and `Psu-User-Agent` on the Enable Banking transaction
  calls (`lib/enablebanking.ts`).
- Never log the IP.
- Skip a header if the value is missing instead of sending an empty one.

## Done when
Production fetches carry both headers (check one request), Danske still returns 200, and
no log line contains an IP.
