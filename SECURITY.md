# Security & Compliance

How authentication, payments, and personal-data handling work in this platform, and
what each piece guarantees. Env var reference lives in `backend/.env.example`.

> This document describes the **design**. For what is actually wrong with the current
> implementation — one critical and three high-severity findings, with reproductions —
> read **[SECURITY_AUDIT.md](./SECURITY_AUDIT.md)** first. A short summary of the gaps is
> in [Known gaps](#known-gaps) below. Where the two documents disagree, the audit wins:
> it was written against the running code.

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

**Still open:**

| Id | Gap | Effect |
|---|---|---|
| H1 | `X-Forwarded-For` trusted with no proxy allowlist | Every rate limit bypassable; mail bombing; brute force |
| H2 | Rate-limiter buckets never evict | Memory-exhaustion DoS |
| M1 | No security response headers | Clickjacking; reset tokens leak via referrer and logs |
| M2 | Session tokens stored in plaintext | A database read yields live sessions for every user |
| M3 | `SameSite=None` with no CSRF token | Cross-site writes to `/admin/uploads` |
| M4/M5 | Special-link capacity and per-user cap are TOCTOU | Oversell under concurrency |

H1 and M1 are pinned by `xfail(strict=True)` tests in `backend/tests/test_security_hardening.py`,
so the suite goes red the moment either is fixed without removing the marker.

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
  enumeration resistance).
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
  Stored in Mongo **in plaintext** and matched by equality — a database read is a
  session compromise (audit M2). `SameSite=None` plus the absence of any CSRF token
  leaves multipart POSTs cross-site reachable (M3).
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
- Ticket-delivery email (with QR attachments) is transactional and best-effort — a mail
  failure is logged and never rolls back a paid order.

## Consent & marketing (GDPR / CAN-SPAM)

- Opt-ins (`email_opt_in`, `news_opt_in`, `promo_opt_in`) default **off**. Every change
  — at registration, OAuth first login, or in settings — is written to `consent_log`
  with timestamp, IP, policy version, and source.
- Newsletter uses **double opt-in** (nothing is "subscribed" until the emailed confirm
  link is clicked) and provides a one-click unsubscribe plus a `List-Unsubscribe` header.
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
- **Audit log** (`audit_log`): role changes, refunds, event cancel/delete, newsletter
  deletes, and account deletions.

## Retention

| Data | Retention |
|------|-----------|
| Invoices / tickets | ~10 years (Romanian fiscal law) — kept through account deletion, anonymized |
| Sessions | 7 days (TTL) |
| Consent log / audit log | Indefinite (compliance evidence) |

**Only the session row is actually enforced** (by the MongoDB TTL index). The rest of
this table is a stated policy with no job behind it: `outbox`, `contact_messages`, and
`payment_transactions` grow without bound and have no documented retention at all. A
retention job is audit item P3.18.

## Out of scope for code (operational follow-ups)

A written Privacy Policy + Terms of Service (the UI links to `/privacy` and `/terms`),
a cookie/subprocessor list, signed DPAs with each subprocessor (Stripe, Resend, Google,
Apple, the Mongo host), and a breach-notification runbook. The code provides the
mechanisms; these documents and agreements must be supplied operationally.
