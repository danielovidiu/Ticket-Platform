# Security & Compliance

How authentication, payments, and personal-data handling work in this platform, and
what each piece guarantees. Env var reference lives in `backend/.env.example`.

> This document describes the **design**. For what is actually wrong with the current
> implementation — one critical and three high-severity findings, with reproductions —
> read **[SECURITY_AUDIT.md](./SECURITY_AUDIT.md)** first. A short summary of the gaps is
> in [Known gaps](#known-gaps) below. Where the two documents disagree, the audit wins:
> it was written against the running code.

## Response headers

Set by a single middleware in `server.py` so the guarantee travels with the app rather
than living in a proxy config, and holds in development too.

| Header | Value | Why |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | `/uploads` serves user bytes from the app origin; stops a polyglot being sniffed as HTML |
| `X-Frame-Options` | `DENY` | clickjacking of admin actions |
| `Referrer-Policy` | `no-referrer` | verification and reset tokens travel in query strings |
| `Permissions-Policy` | camera/mic/geolocation off | nothing here needs them |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'; …` | tightened per path (below) |
| `Strict-Transport-Security` | 1 year, `includeSubDomains` | **HTTPS only** — pinning http dev would be self-inflicted downtime |

CSP varies by path: `/uploads` gets a `sandbox`ed policy (which does not affect
`<img>`/`<video>` rendering — verified), `/docs` and `/redoc` get a narrower policy that
permits the Swagger CDN, everything else gets the strict default.

Moving verification and reset tokens out of URL query strings entirely is still
outstanding (audit P1.6); `Referrer-Policy` is the cheaper half of that fix.

## Reporting a vulnerability

Email the maintainer rather than opening a public issue, and allow a reasonable window
before disclosure. If you have a finding in the ticketing or payment flow, include the
`PAYMENTS_MODE` the instance was running.

## Known gaps

The design below is largely sound; the exposure is concentrated in deployment defaults
and the perimeter.

**Fixed:**

| Id | Was | Now |
|---|---|---|
| C1 | `PAYMENTS_MODE` silently fell back to the simulator when `STRIPE_API_KEY` was unset — two unauthenticated endpoints then finalized orders, so tickets were free | Startup refuses `APP_ENV=production` with fake payments, from either a missing key or an explicit `LOCAL_FAKE_PAYMENTS=1` |
| H3 | The first account to register became admin, and the `INITIAL_ADMIN_EMAIL` bootstrap re-promoted the operator without demoting a squatter | Registration order confers nothing; admin comes only from `INITIAL_ADMIN_EMAIL` |
| H2 | Rate-limiter keys were created per IP and per email and never removed — a memory-exhaustion DoS | Periodic sweep drops keys whose window has expired, plus a per-bucket cap with LRU eviction |
| M1 | No security response headers at all | `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, CSP on every response; HSTS on HTTPS; a sandboxed CSP on `/uploads` |
| M2 | Session tokens stored in plaintext — a database read yielded live sessions for every user | Only `sha256(token)` is persisted; migrated in place without logging anyone out |
| — | `POST /auth/logout` read only the cookie, so a `Bearer` client got `200 {"ok":true}` while its session stayed valid (found while fixing M2) | Both call sites share `_presented_token`; logout revokes either form |

**Still open:**

| Id | Gap | Effect |
|---|---|---|
| H1 | `X-Forwarded-For` trusted with no proxy allowlist | Every rate limit bypassable; mail bombing; brute force |
| M3 | `SameSite=None` with no CSRF token | Cross-site writes to `/admin/uploads` |
| M4/M5 | Special-link capacity and per-user cap are TOCTOU | Oversell under concurrency |
| M6–M12, L1–L4 | See the audit | |

H1 is pinned by an `xfail(strict=True)` test in `backend/tests/test_security_hardening.py`,
so the suite goes red the moment it is fixed without removing the marker.

**H1 is now the single most valuable remaining fix.** With H2 done the limiter can no
longer be used to exhaust memory, but it still cannot stop a determined attacker: anyone
can choose their own bucket by setting a header, which leaves `/api/newsletter` and
`/api/auth/forgot-password` usable as mail-bomb amplifiers against third parties.

**Half of the fix is in, and the half that is missing cancels it.** `TRUSTED_IP_HEADER`
now gates which forwarding header the application will believe, and unset means "believe
none of them". That is correct as far as it goes, but `_client_ip()` then falls back to
`request.client.host` on the assumption that it is the socket peer — and under uvicorn it
is not. `proxy_headers` defaults to `True` and `forwarded_allow_ips` to `127.0.0.1`, so
uvicorn's `ProxyHeadersMiddleware` rewrites `request.client.host` from `X-Forwarded-For`
before the application is reached, for any client on that allowlist. A reverse proxy on
the same host is on that allowlist by default, which is the standard container layout.

Reproduced against `/api/contact` (limit 5/60s) on a default `uvicorn server:app`, with
`TRUSTED_IP_HEADER` unset:

```
no header:                200 200 200 200 200 429 429 429 429
rotating X-Forwarded-For: 200 200 200 200 200 200 200 200 200
```

So the application-level guard cannot be verified by reading `server.py` alone — the
process that runs it has to be checked too. Pass `--forwarded-allow-ips` naming the real
proxy, or `""` when nothing fronts the app. This matters most for the planned move off
Vercel: Vercel's Python runtime does not invoke the uvicorn CLI, so a container running
uvicorn behind nginx inherits an exposure the current deployment does not have.

Code at each of these points carries a `SECURITY [id]` comment keyed to the audit:

```bash
grep -rn "SECURITY \[" backend frontend/src
```

## Authentication

Three sign-in methods, all issuing the same first-party opaque session cookie:

- **Email + password** — bcrypt (cost 12). Registration requires ToS acceptance and an
  8-char minimum. Login returns an identical generic `401` for a missing user, an
  OAuth-only account, or a wrong password, and runs a dummy bcrypt verify on the
  missing-user path to flatten timing (a mitigation, not a guarantee of full
  enumeration resistance). Hashing runs on the threadpool
  (`hash_password_async`/`verify_password_async`), never on the event loop: at ~300ms a
  hash, a blocking call makes every login a 300ms denial of service against *every other
  request the worker is serving*, which per-IP rate limiting alone does not bound once the
  attempts come from many addresses. `tests/test_async_bcrypt.py` asserts on the latency,
  since no functional test can see this.
- **Google** — our own OAuth client (server-side code exchange). `state` CSRF cookie;
  `id_token` verified against Google's JWKS.
- **Apple** — `form_post` callback; `id_token` verified against Apple's JWKS. Name/email
  and any private-relay address are captured only on the first authorization (Apple
  sends them once). Requires a public HTTPS callback — not testable on localhost.

**Account linking (verified-email gate).** OAuth logins match by provider `sub` first,
then by email. Email-based auto-linking happens **only** if the existing account's email
is already verified, or the incoming provider asserts the email is verified. Otherwise
the flow is refused with a "use your original method" message — this closes the
pre-registration account-takeover hole that silent merge-by-email would open.

### Sessions & cookies

- `session_token`: opaque 256-bit random, `HttpOnly`, `Secure`+`SameSite=None` on HTTPS
  (or `Lax`+insecure on http dev, derived from `PUBLIC_APP_URL`), 7-day lifetime.
- **Only `sha256(token)` is stored** (audit M2). The plaintext lives in the user's cookie
  and nowhere else, so a leaked backup or dump of `user_sessions` contains nothing
  replayable. Plain SHA-256 rather than a slow KDF is deliberate: the input is 256 bits of
  `secrets`-grade randomness, so there is no dictionary to attack, and this runs on every
  authenticated request where bcrypt's cost would be self-inflicted DoS.
- Accepted as a cookie or as `Authorization: Bearer`. Both `get_current_user` and
  `logout` resolve it through the same helper, so a Bearer client can actually log out.
- `SameSite=None` plus the absence of any CSRF token still leaves multipart POSTs
  cross-site reachable (M3, open).
- Rotated on every login (old token deleted) — defeats fixation.
- Stored with a real `expires_at` datetime and reaped by a MongoDB **TTL index**
  (`expireAfterSeconds=0`). The TTL monitor is best-effort (~60s); `get_current_user`
  also checks expiry explicitly, which is the real guard.
- Password reset performs a **global logout** (deletes all of the user's sessions).

### Signed tokens (`backend/server.py: make_token/read_token`)

JWT HS256 signed with `SESSION_SECRET`, each purpose scoped by a distinct `aud` so a
token from one flow can't be replayed against another:

| Purpose        | TTL     | Notes |
|----------------|---------|-------|
| `email-verify` | 24h     | |
| `pwd-reset`    | 1h      | Single-use: bound to the current password-hash tail |
| `news-confirm` | 7d      | Double opt-in |
| `news-unsub`   | 365d    | One-click unsubscribe; idempotent |

## Payments & fulfillment

- Two modes (`PAYMENTS_MODE`): **fake** (default, no Stripe account — full local
  simulation) and **stripe** (real SDK, requires `STRIPE_WEBHOOK_SECRET`).
  > Fake mode is a development facility with **no authentication on its finalizing
  > endpoints**. It is now opt-in only: `LOCAL_FAKE_PAYMENTS=1` selects it and is refused
  > outright under `APP_ENV=production`, an `sk_...` key selects live Stripe, and anything
  > else is a hard startup failure in production. A missing or mistyped key can no longer
  > downgrade a deployment to free tickets. *(Audit C1 — fixed.)*
- Webhooks verify the Stripe signature via `Webhook.construct_event`; a bad/absent
  signature is `400`.
- **Idempotency**: each processed event id is inserted into `processed_stripe_events`
  (unique index); replays are no-ops, so a webhook + status-poll race can't double-issue
  tickets. `_finalize_paid_reservation` is itself idempotent (guarded pending→paid).
- **Inventory is held, not counted.** Wave stock, special-link capacity and the per-user
  cap are all enforced against concurrent requests, not just sequential ones. Stock and
  link capacity draw down through conditional single-document writes at *reservation*
  time; the per-user cap is confirmed after the insert and resolved by a total order the
  contending requests each compute identically, so losers roll back rather than oversell.
  Holds return on expiry and on rollback. *(Audit M4 and M5 — fixed; `test_oversell_races.py`
  fires simultaneous requests through a barrier and fails against the old code.)*
- Ticket-delivery email (with QR attachments) is transactional and best-effort — a mail
  failure is logged and never rolls back a paid order.

## Consent & marketing (GDPR / CAN-SPAM)

- Opt-ins (`email_opt_in`, `news_opt_in`, `promo_opt_in`) default **off**. Every change
  — at registration, OAuth first login, or in settings — is written to `consent_log`
  with timestamp, IP, policy version, and source.
- Newsletter uses **double opt-in** (nothing is "subscribed" until the emailed confirm
  link is clicked) and provides a one-click unsubscribe plus a `List-Unsubscribe` header.
- **Event change notices are transactional, and deliberately bypass the opt-ins.** A
  venue move, a time change or a cancellation goes to the holders of *issued* tickets for
  that event regardless of `news_opt_in`, and carries no `List-Unsubscribe` header. That
  is the correct treatment: the message concerns a purchase the recipient has already
  made, which is what makes it transactional under both GDPR (performance of a contract,
  not consent) and CAN-SPAM. The exemption is only as good as the targeting, so the
  audience is derived from tickets rather than from any mailing list — refunded holders
  are excluded, and there is no path from this endpoint to a non-buyer's inbox. Anything
  promotional must go through the newsletter instead.
- The notice body is admin-authored free text rendered into HTML mail, so it is escaped
  at the template (`mailer._tpl_event_notice`) rather than interpolated raw like the
  older templates around it.
- No third-party analytics. The former PostHog/session-recording snippet (which used an
  Emergent-owned key) has been removed. Any future analytics must be gated behind the
  `CookieConsent` opt-in, not fired on load.
- CSV export uses the stdlib writer and neutralizes spreadsheet formula injection.

## Data-subject rights

- **Export** (`GET /auth/export`): machine-readable JSON of the user's account,
  reservations, tickets, invoices, payments, consent log, session metadata, and
  newsletter status.
- **Deletion** (`DELETE /auth/account`): anonymize-in-place, not hard delete. Email is
  scrubbed to `deleted+<id>@anon.invalid`, name/phone/picture blanked, and
  `password_hash`/`google_sub`/`apple_sub` unset; all sessions killed; newsletter
  unsubscribed. **Invoices and tickets are retained** (with the now-anonymized user
  reference) for fiscal/audit obligations. The last remaining admin cannot delete
  themselves.
- **Audit log** (`audit_log`): role changes, refunds, event cancel/delete, event change
  notices (who mailed which event's holders, with the recipient count), newsletter
  deletes, and account deletions.

## Retention

| Data | Retention |
|------|-----------|
| Invoices / tickets | ~10 years (Romanian fiscal law) — kept through account deletion, anonymized |
| Sessions | 7 days (TTL) |
| Consent log / audit log | Indefinite (compliance evidence) |

**Only the session row is actually enforced** (by the MongoDB TTL index). The rest of
this table is a stated policy with no job behind it: `outbox`, `contact_messages`,
`payment_transactions` and `event_notices` grow without bound and have no documented
retention at all. A retention job is audit item P3.18.

`event_notices` holds the sent text of every event change notice with the sending admin's
id — a deliberate record, so two admins do not announce the same cancellation twice and so
"was anyone told?" has an answer. It stores no recipient addresses, only a count.

## Out of scope for code (operational follow-ups)

A written Privacy Policy + Terms of Service (the UI links to `/privacy` and `/terms`),
a cookie/subprocessor list, signed DPAs with each subprocessor (Stripe, Resend, Google,
Apple, the Mongo host), and a breach-notification runbook. The code provides the
mechanisms; these documents and agreements must be supplied operationally.
