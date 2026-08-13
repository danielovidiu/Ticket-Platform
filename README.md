# Supersanity

Ticketing platform for a Bucharest music & performance collective — public site, CMS,
box office (reserve → Stripe checkout → QR ticket), door scanner, a merchandise webshop,
and a self-owned, GDPR/CAN-SPAM-aware user-management stack.

- **Backend**: FastAPI + MongoDB (Motor), single module `backend/server.py` (+
  `cms_routes.py`, `shop_routes.py`, `mailer.py`, `storage.py`).
- **Frontend**: React 19 (CRA/craco), `frontend/`.
- **Deploying**: one Vercel project, two services — see **[DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md)**.

> **Status: hardening in progress.**
> A security audit found one critical and three high-severity issues. **Three are fixed** —
> C1 (payment bypass), H2 (limiter memory DoS) and H3 (admin takeover) — along with M1
> (security headers) and M2 (plaintext session tokens). **H1 (spoofable rate-limit key)
> is only half fixed and is still exploitable under uvicorn** — see the checklist below.
> **P1–P3 remain open**, including M3: there is no CSRF token or Origin check on
> state-changing routes. Full detail in **[SECURITY_AUDIT.md](./SECURITY_AUDIT.md)**.

## Run it locally

```bash
# backend
cd backend
python -m venv venv && venv/bin/pip install -r requirements.txt
cp .env.example .env
venv/bin/uvicorn server:app --port 8000 --reload

# frontend
cd frontend
yarn install && yarn start    # http://localhost:3000
```

Everything works with **no external credentials**: password auth is native, emails land
in the `outbox` collection (and the logs), and payments run a local simulator. Google,
Apple, Stripe, Resend and SMTP all switch on only when their env vars are set — see
`backend/.env.example`. To read mail in a real client instead of out of Mongo, point
`SMTP_HOST` at a relay or a local catcher; see [auth_testing.md](./auth_testing.md).

That convenience is exactly what makes the deployment checklist below non-optional: the
same defaults that make a fresh checkout work are unsafe on a public host.

## Before you deploy

The audit's P0 items.

- [x] **Payments fail closed.** *(C1)* The app now refuses to start when
      `APP_ENV=production` would run the simulator — whether from a missing/malformed
      `STRIPE_API_KEY` or an explicit `LOCAL_FAKE_PAYMENTS=1`. There is no longer a path
      where a typo in the key silently downgrades production to free tickets.
- [x] **Admin bootstrap race closed.** *(H3)* First-arrival-becomes-admin is gone
      entirely. Admin comes only from `INITIAL_ADMIN_EMAIL`, applied both at registration
      and at startup; every other account is created as `user`. A deployment with no
      `INITIAL_ADMIN_EMAIL` logs a loud warning that no admin exists.
- [x] **Rate limiter bounded.** *(H2)* A periodic sweep drops expired keys and each bucket
      has an LRU-evicting cap, so attacker-chosen keys can no longer grow the table until
      the worker OOMs. Still per-process: N workers means N times the allowance.
- [x] **Security headers.** *(M1)* `nosniff`, `X-Frame-Options`, `Referrer-Policy`,
      `Permissions-Policy` and a path-specific CSP on every response, plus HSTS on HTTPS.
- [x] **Session tokens hashed at rest.** *(M2)* Only `sha256(token)` is stored; existing
      sessions were migrated in place without logging anyone out.
- [ ] **Trusted-proxy handling.** *(H1 — half done, still exploitable)* `X-Forwarded-For`
      used to be trusted unconditionally, so every rate limit was bypassable by rotating
      the header and `/api/newsletter` and `/api/auth/forgot-password` worked as mail-bomb
      amplifiers. The application-level half shipped: forwarding headers are believed only
      when `TRUSTED_IP_HEADER` names one. Set it to `x-vercel-forwarded-for` on Vercel, or
      to `x-forwarded-for` behind a proxy that **replaces** rather than appends.

      **The other half did not, and it defeats the first.** `_client_ip()` falls back to
      `request.client.host` believing it to be the socket peer. Under uvicorn it is not:
      `proxy_headers` defaults to `True` and `forwarded_allow_ips` to `127.0.0.1`, so
      uvicorn rewrites `request.client.host` from `X-Forwarded-For` before the app ever
      sees the request — for any client on the allowlist, which includes every reverse
      proxy on the same host. Verified against `/api/contact` (limit 5/60s) on a default
      `uvicorn server:app`:

      ```
      no header:              200 200 200 200 200 429 429 429 429
      rotating X-Forwarded-For: 200 200 200 200 200 200 200 200 200
      ```

      The audit's remediation was always two-part; only part one was done. Run uvicorn
      with `--forwarded-allow-ips` naming the proxy (or `""` when nothing fronts it), or
      set `FORWARDED_ALLOW_IPS`. This is the top open item — see
      [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) H1.

Configuration the app already enforces (it refuses to start otherwise): `APP_ENV=production`,
a 32-byte `SESSION_SECRET`, and an explicit `CORS_ORIGINS` allowlist. `SESSION_SECRET` is
required on any serverless host regardless of `APP_ENV`, because the dev fallback is
per-process and instances do not share it. Set `INITIAL_ADMIN_EMAIL` too, or nobody can
administer the site.

Then work through P1–P3 in the audit.

## Auth methods

Email/password (bcrypt cost 12), direct Google OAuth, and Apple Sign In — all issuing one
first-party HttpOnly session cookie. Account linking uses a verified-email gate. Email
verification and password reset are built in. See **[SECURITY.md](./SECURITY.md)** for
the full model and **[auth_testing.md](./auth_testing.md)** for copy-paste test flows.

## Payments

`PAYMENTS_MODE` is `fake` by default — a full local simulation with no Stripe account,
intended for development only (see the deployment checklist). Setting a real `sk_...` key
plus `STRIPE_WEBHOOK_SECRET` switches to live Stripe Checkout, with fulfillment on a
signature-verified, idempotent webhook and tickets delivered by email with QR attachments.

## Webshop

Merchandise alongside the tickets: admin-managed catalogue with per-product size
variants, a cart persisted per signed-in account in MongoDB, and Stripe Checkout in RON.
No guest checkout — an account is required, so orders always have an owner.

Stock is **held at checkout**, not on payment, by a single filtered `$inc` that only
matches a variant with enough left; abandoned orders release their hold after
`HOLD_MINUTES`. Fulfilment moves pending → paid → shipped → delivered, and the paid
transition comes only from the Stripe webhook, never the client.

Prices are VAT-inclusive. The rate starts from `VAT_RATE` (0.21 — Romania's standard
rate since August 2025) and is editable at runtime in **Admin → Shop settings**, so a
statutory change needs no redeploy. Invoices store the rate they were issued under, so
changing it never rewrites history. Fiscal numbering is one unbroken series, allocated
by an atomic counter.

## Event change notices

When an event moves, shifts its hour, changes lineup or is called off, **Admin → Events →
Notify** emails the people holding tickets for it. The audience is computed server-side
from *issued* tickets: refunded buyers are excluded, and one buyer is one email however
many tickets they hold. The composer shows the recipient count before anything is sent.

Nothing sends itself. Saving an event is silent, so a typo fix never mails anyone — an
admin picks the change kind, writes the message, and confirms. Cancelling an event still
refunds every ticket, but now hands straight over to the composer instead of doing it in
silence. Past notices are listed per event so the same change isn't announced twice.

The message is admin-written; the surrounding email is derived from the event record —
cover image, title, current date, doors, venue and lineup — and the free text is escaped
on the way in. These are transactional messages about a ticket the recipient already
holds, so unlike the newsletter they carry no `List-Unsubscribe` header and ignore
marketing opt-ins. Sends are capped per admin per hour, keyed on the account rather than
the IP so anonymous traffic cannot spend a real admin's budget before a cancellation.

## Compliance

Consent logging, newsletter double opt-in + one-click unsubscribe, data export, and
anonymizing account deletion (invoices retained for fiscal law). Event change notices are
transactional and bypass the marketing opt-ins on purpose — which is only defensible
because their audience is derived from issued tickets, never from a list. No third-party
analytics. Details and the operational follow-ups (Privacy Policy, ToS, DPAs) are in
[SECURITY.md](./SECURITY.md).

## Tests

The suite is **integration-style**: it drives a live server over HTTP and reads MongoDB
directly for role fixtures. Start the backend first.

```bash
cd backend && venv/bin/uvicorn server:app --port 8000
```

```bash
cd backend && venv/bin/python -m pytest
```

**364 passed, 1 xfailed.** Point it at another environment with `TICKET_PLATFORM_URL`;
everything else (Mongo URL, database name) comes from `backend/.env`, the same file the
server reads. If the server isn't running the whole session skips with one clear message
instead of a wall of connection errors.

The single `xfail` is deliberate: it is audit finding H1 (X-Forwarded-For rate-limit
bypass), recorded as `xfail(strict=True)` so the gap stays visible *and* so fixing it
turns the suite red until the marker is removed. That mechanism has already earned its
keep twice. M1 was marked the same way, and closing it forced the marker's removal rather
than letting the stale expectation sit there. And when this README began claiming H1 was
fixed, the marker was what proved otherwise — the test still fails, because the fix is
only half applied (see the checklist above). Trust the marker over the prose.

Test data is namespaced (`@pytest.invalid` addresses, `TEST_` title prefixes), removed at
teardown, and swept on start if a previous run was interrupted.

> Rewritten from the Emergent-era original, which assumed `/app/backend` on `sys.path`,
> read `/app/frontend/.env`, shelled out to `mongosh` against a hardcoded `test_database`,
> and expected `UMB_*_TOKEN` environment variables from a runner that no longer exists.
> It scored 12 failed / 29 errors / 7 passed.

## Repository map

| Path | What it is |
|---|---|
| `backend/server.py` | API: auth, ticketing, payments, admin, uploads, invoices. Security-relevant spots are marked `SECURITY [id]`, keyed to the audit — `grep -rn "SECURITY \[" backend frontend/src` |
| `backend/cms_routes.py` | CMS pages, theme, nav |
| `backend/shop_routes.py` | Webshop: catalogue, cart, checkout, orders, fulfilment |
| `backend/storage.py` | Media uploads — Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set, local `./uploads` otherwise |
| `backend/mailer.py` | Mail: templates + three backends (Resend → SMTP → `db.outbox`) |
| `backend/tests/` | Integration suite (see **Tests**); `support.py` holds the fixtures and cleanup |
| `backend/requirements.in` | Intended direct dependencies. `requirements.txt` is an unfiltered freeze — ~60 of its 126 packages are unused |
| `frontend/src/` | React app |
| `DEPLOY_VERCEL.md` | Deploying to Vercel + Atlas, and verifying a deploy via `/api/health` |
| `SECURITY.md` | How the security model works, and its known gaps |
| `SECURITY_AUDIT.md` | Full audit: findings, attack paths, remediation plan |
| `auth_testing.md` | Manual auth test flows |
| `CMS_GUIDE.md` | CMS usage |
| `test_reports/`, `test_result.md` | **Stale.** Pre-rewrite QA artifacts; safe to delete |

## Is it deployed?

```bash
curl -s https://<your-domain>/api/health
```

Returns the commit serving traffic plus the schema version the database has migrated to,
so "did my fix actually ship?" is one request rather than a dashboard hunt. Details in
[DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md).
