# 26 — Privacy policy and terms, served from the backend

- **Branch:** `feature/26-legal-pages`
- **Story points:** 1
- **Raised by:** the owner, 2026-10-10, while registering a **production** Enable
  Banking application

## Why

Enable Banking's production application form requires a **Privacy URL** and a
**Terms URL**, and verifies they are valid and stay reachable. CleanSheets had
neither: this backend serves only `/api/*`, there is no website, and no policy
had ever been written because the only user was the owner.

That is the single field blocking the production application — which in turn is
the only way to read Danske Bank's exact ASPSP name and close **task 24** /
ledger **CR-05**.

## What this adds

- `public/privacy.html`, `public/terms.html`, `public/_style.css`
- Two rewrites so the URLs are clean:
  `/privacy` → `/privacy.html`, `/terms` → `/terms.html`

Live at `https://backend-beryl-phi-32.vercel.app/privacy` and `/terms` once
deployed. Verified locally against `vercel dev`: both answer **200** with the
right `<title>`.

## The content is accurate, not boilerplate

Written from this repository rather than from a template, so it describes what
the code actually does:

- **Read-only bank access**, PSD2 via Enable Banking, consent expiring on the
  bank's schedule (`ENABLE_BANKING_CONSENT_DAYS`, 90 days requested).
- **Transaction data is not stored server-side** — fetched per request and passed
  through. What *is* stored is the account row, the encrypted Google refresh
  token, the sheet id and column mapping, and the bank session reference.
- **Drive access is `drive.metadata.readonly`** — names and ids only, never the
  contents of files other than the chosen spreadsheet.
- **Account deletion leaves the spreadsheet alone**, including the hidden `_log`
  tab, matching what `DELETE /api/user/account` actually does and what app task
  20's screen already promises.
- The four processors are named: Google, Enable Banking, Supabase, Vercel.

## Limits, stated plainly

This is an honest description of the system written by its developer. **It is not
legal advice and has not been reviewed by a lawyer.** It is adequate for
registering a production application and for the owner connecting their own
account. Before strangers connect real bank accounts under PSD2 and the GDPR, it
needs proper review — the owner was told this before asking for it.

Two values are placed rather than derived and should be confirmed: **governing
law (Denmark)** and the data-protection contact
(`k.danilovs2905@gmail.com`, matching the existing sandbox application).

## Acceptance criteria

- [x] `/privacy` and `/terms` answer 200 with readable pages.
- [x] Content matches the system's real behaviour, checked against the code.
- [x] Dark mode and small screens handled; no external assets or fonts, so the
      pages cannot break on a CDN or a font host.
- [ ] Deployed, and the live URLs confirmed reachable before they are pasted into
      the Enable Banking form.
