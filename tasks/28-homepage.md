# 28 — A homepage, so the OAuth consent screen can be published

- **Branch:** `feature/28-homepage`
- **Raised:** 2026-10-21, by the owner hitting a wall in Google Cloud Console
- **Story points:** 1

## Why

The Google OAuth consent screen is stuck in **Testing**, and Testing issues
refresh tokens that expire after **seven days**. That is not a theory: the
owner's Google Sheets grant died on 2026-10-12 and again on 2026-10-19, exactly
a week apart, each time leaving every sheet-backed screen in the app unable to
read anything. It blocked two verifications during the 2026-10-19 session.

**Publish app** is disabled, with:

> *"Valid app name, support email, homepage url, and privacy policy url are
> required for switching the app to external production mode."*

Three of the four exist. App name and support email are Branding-page fields the
owner fills in; the privacy policy URL is live at `/privacy` (task 26). The
missing one is a **homepage**, and `GET /` currently answers **404**.

## Scope

- `public/index.html`, served at `/` — Vercel serves `public/index.html` at the
  root without a rewrite, which is why `/privacy` and `/terms` need rewrites and
  this does not.
- Same visual language as the legal pages: `_style.css` unchanged, same shell.
- What it must contain, because Google's reviewer and a curious user want the
  same things: what the app is, what it does with a bank connection and a Google
  Sheet, and links to the privacy policy and terms.
- **No sign-up, no marketing claims, no analytics.** The privacy policy says
  there is no tracking in the app; a landing page that loaded a tracker would
  make that false.

## Out of scope

- App-store style screenshots or a feature tour. The page exists to be a
  truthful front door and to unblock publishing.
- Domain verification. Publishing is not verification — verification is only
  needed before other people's Google accounts can be let in, and the owner is
  the only user today.

## Acceptance criteria

- [ ] `GET /` returns 200 and renders in both colour schemes.
- [ ] It names the app, says what it does, and links `/privacy` and `/terms`.
- [ ] The links work from the deployed page, not just locally.
- [ ] **Publish app** becomes available in Google Cloud Console once the
      Branding page is filled in with this URL.
