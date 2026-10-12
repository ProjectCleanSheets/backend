# 27 — `+` in the `bank` query parameter must mean a space

- **Branch:** `fix/27-bank-query-plus-encoding`
- **Carried out of:** task 24, which listed this as optional
- **Story points:** 1

## Why

`GET /api/auth/bank?bank=&country=` forwards `bank` straight to Enable Banking's
`POST /auth`. The query parser in front of `startQuerySchema` does **not** treat
`+` as a space, so `?bank=Danske+Bank` arrives — and is forwarded — as the
literal string `Danske+Bank`. Enable Banking answers **422 "Wrong ASPSP name
provided"**, which this endpoint turns into a 400 on the **first screen a real
user ever reaches**.

Nothing is broken today: the iOS app sends `%20`, pinned by a test. This removes
the trap for any other client, and for anyone hand-testing with curl.

**Task 24 made it concrete.** The confirmed production name is `Danske Bank` —
and of the 96 Danish ASPSPs in the production listing, the overwhelming majority
carry a space: `Jyske Bank`, `Spar Nord Bank`, `Arbejdernes Landsbank`,
`Sparekassen Kronjylland`. The one query parameter that must be exact is the one
most likely to contain the character that silently changes.

## What it does

Decode `+` to a space, then **trim**, before the length check:

```ts
bank: z
  .string()
  .transform((value) => value.replace(/\+/g, ' ').trim())
  .pipe(z.string().min(1).max(MAX_BANK_NAME_LENGTH))
  .optional(),
```

Trimming matters: without it `?bank=+` decodes to a lone space, passes
`min(1)`, and is forwarded for Enable Banking to reject with a 422 the user
cannot act on. With it, the request is refused here as `INVALID_REQUEST` — our
own error, about our own input.

## Verified

| Sent | Forwarded |
|---|---|
| `Danske+Bank` | `Danske Bank` |
| `Danske%20Bank` | `Danske Bank` |
| `Mock+ASPSP` | `Mock ASPSP` |
| `+` | refused, 400 `INVALID_REQUEST` |
| *(omitted)* | `undefined` — sandbox fallback unchanged |

`tsc --noEmit` green.

## Acceptance criteria

- [x] `+` reaches Enable Banking as a space.
- [x] `%20` is unaffected, so the app's existing behaviour and its test still hold.
- [x] A `bank` that is only separators is refused here rather than forwarded.
- [x] Omitting `bank` still falls back to the Mock ASPSP in sandbox.
