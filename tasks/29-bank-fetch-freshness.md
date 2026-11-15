# 29 — Find out why a refresh returns stale bank data, and fix it

- **Status:** Done 2026-11-15 as investigation only (1 pt); Part 2 not needed. From `../../TESTING-1.0.md` #3 (backend half). App half is app task 52.
- **Size:** 3 pts (1 investigation + 2 fix).

## What was seen
On the owner's iPhone, pull-to-refresh returned nothing new. Soon after, a refresh from
the simulator surfaced new entries, which then also appeared on the phone. Both hit the
same production backend and the same Danske consent.

## Part 1 — Investigate the exact cause (do this first, report before fixing)
Establish which of these it is, with evidence, not inference:
1. **Unattended-access limit.** `lib/enablebanking.ts` sends no PSU headers, so each fetch
   likely counts against PSD2's 4 unattended accesses per day. Look for
   `ASPSP_RATE_LIMIT_EXCEEDED` / 429s in the Vercel production logs around the reports,
   and check `required_psu_headers` for Danske in `GET /aspsps`.
2. **Bank-side caching.** Danske or Enable Banking may serve a cached snapshot for
   unattended calls. Compare two fetches minutes apart with and without PSU headers
   (use the probe; each run costs one of the four daily accesses, so plan the runs).
3. **Timing only.** The new transactions may simply have booked between the two refreshes.
   Compare their booking times with the refresh times in the logs.
4. **Something in our code** (the 30-day window, `_log` dedup, a silent error mapped to an
   empty list). Rule it out from the logs of the empty fetch.

Write the finding into this file under "Finding" before starting Part 2. If the cause is
not (1), stop and agree a new scope with the owner.

## Part 2 — Fix (if the cause is the unattended limit)
Forward the user's presence on queue fetches: take the phone's IP (`x-forwarded-for` on
Vercel) and user agent from the incoming request and send them as `Psu-Ip-Address` and
`Psu-User-Agent`, plus any other header Danske lists as required. No app change needed.
Never log the IP.

## Done when
- The Finding section names the cause, with the log lines or probe output that show it.
- If fixed: several refreshes in a row return current data with no rate-limit errors,
  checked against production.

## Finding
Probed production on 2026-11-15 (Danske, production app, real consent), 12:44–12:45 UTC:

1. **Unattended limit: ruled out.** 5 fetches with `Psu-Ip-Address`/`Psu-User-Agent`,
   then 6 without, within ~40 s: all **200**, identical data (12 transactions in 5 days).
   No rate-limit headers on the responses. `GET /aspsps?country=DK` lists no
   `required_psu_headers` for Danske. Request ids: attended `3e530b25…`, `af6a0d92…`,
   `524448a8…`, `1928cb61…`, `25527999…`; unattended `d3753e61…`, `6a5555e2…`,
   `6e075a30…`, `5ff1a335…`, `7e3e3948…`, `a7774b8b…`.
2. **Bank-side caching: not shown.** Nothing booked between fetches, so a snapshot can't be
   told apart from live data today. No sign of it.
3. **Timing: likely.** Danske books 1–4 days after the purchase (an Apple Pay purchase on
   11-11 booked 11-13). A booking landing between the phone refresh and the simulator
   refresh looks exactly like the report.
4. **Our code: likely, app side.** The app's `refresh()` returns at once if a fetch is
   already running (TESTING #9 → app 53), and the app doesn't refresh on return to the
   foreground (app 52). Backend logs from the original report are past Vercel's retention.

**Outcome:** no backend fix for #3; app 52 + 53 are the fix. Sending PSU headers is still
the correct way to mark a user-initiated fetch, and some banks (e.g. Länsförsäkringar)
enforce the limit, so it's filed separately as task 37 at low priority.
