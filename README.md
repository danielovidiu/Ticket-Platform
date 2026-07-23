# Supersanity

Ticketing platform for a Bucharest music & performance collective — public site, CMS,
box office (reserve → Stripe checkout → QR ticket), door scanner, and a self-owned,
GDPR/CAN-SPAM-aware user-management stack.

- **Backend**: FastAPI + MongoDB (Motor), single module `backend/server.py` (+
  `cms_routes.py`, `mailer.py`).
- **Frontend**: React 19 (CRA/craco), `frontend/`.

> **Status: hardening in progress.**
> A security audit found one critical and three high-severity issues. **C1 (payment
> bypass), H3 (admin takeover) and H2 (limiter memory DoS) are fixed**, along with M1
> (security headers) and M2 (plaintext session tokens). **H1 remains open** and is now
> the top priority: `X-Forwarded-For` is trusted unconditionally, so every rate limit is
> still bypassable. See **[SECURITY_AUDIT.md](./SECURITY_AUDIT.md)** and the checklist
> below before deploying.

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
Apple, Stripe, and Resend all switch on only when their env vars are set — see
`backend/.env.example`.

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
- [ ] **Trusted-proxy handling.** `X-Forwarded-For` is trusted unconditionally, so every
      rate limit in the app is bypassable by rotating the header (verified). Gate it on a
      proxy allowlist and run uvicorn with `--forwarded-allow-ips`. **This is the top
      remaining item** — until it lands, `/api/newsletter` and `/api/auth/forgot-password`
      work as mail-bomb amplifiers against arbitrary third parties. *(H1)*

Configuration the app already enforces (it refuses to start otherwise): `APP_ENV=production`,
a 32-byte `SESSION_SECRET`, and an explicit `CORS_ORIGINS` allowlist. Set
`INITIAL_ADMIN_EMAIL` too, or nobody can administer the site.

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

## Compliance

Consent logging, newsletter double opt-in + one-click unsubscribe, data export, and
anonymizing account deletion (invoices retained for fiscal law). No third-party
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

**115 passed, 1 xfailed.** Point it at another environment with `TICKET_PLATFORM_URL`;
everything else (Mongo URL, database name) comes from `backend/.env`, the same file the
server reads. If the server isn't running the whole session skips with one clear message
instead of a wall of connection errors.

The single `xfail` is deliberate: it is audit finding H1 (X-Forwarded-For rate-limit
bypass), recorded as `xfail(strict=True)` so the gap stays visible *and* so fixing it
turns the suite red until the marker is removed. That mechanism has already earned its
keep — M1 was marked the same way, and closing it forced the marker's removal rather than
letting the stale expectation sit there.

Test data is namespaced (`@pytest.invalid` addresses, `TEST_` title prefixes), removed at
teardown, and swept on start if a previous run was interrupted.

> Rewritten from the Emergent-era original, which assumed `/app/backend` on `sys.path`,
> read `/app/frontend/.env`, shelled out to `mongosh` against a hardcoded `test_database`,
> and expected `UMB_*_TOKEN` environment variables from a runner that no longer exists.
> It scored 12 failed / 29 errors / 7 passed.

## Repository map

| Path | What it is |
|---|---|
| `backend/server.py` | API: auth, ticketing, payments, admin, uploads. Security-relevant spots are marked `SECURITY [id]`, keyed to the audit — `grep -rn "SECURITY \[" backend frontend/src` |
| `backend/cms_routes.py` | CMS pages, theme, nav |
| `backend/mailer.py` | Resend / `db.outbox` mail abstraction |
| `backend/requirements.in` | Intended direct dependencies. `requirements.txt` is an unfiltered freeze — ~60 of its 126 packages are unused |
| `frontend/src/` | React app |
| `SECURITY.md` | How the security model works, and its known gaps |
| `SECURITY_AUDIT.md` | Full audit: findings, attack paths, remediation plan |
| `auth_testing.md` | Manual auth test flows |
| `CMS_GUIDE.md` | CMS usage |
| `test_reports/` | **Stale.** Pre-rewrite QA artifacts; safe to delete |
