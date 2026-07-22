# Supersanity

Ticketing platform for a Bucharest music & performance collective — public site, CMS,
box office (reserve → Stripe checkout → QR ticket), door scanner, and a self-owned,
GDPR/CAN-SPAM-aware user-management stack.

- **Backend**: FastAPI + MongoDB (Motor), single module `backend/server.py` (+
  `cms_routes.py`, `mailer.py`).
- **Frontend**: React 19 (CRA/craco), `frontend/`.

## Run it locally

```bash
# backend
cd backend
python -m venv venv && venv/bin/pip install -r requirements.txt
cp .env.example .env          # defaults work out of the box (fake payments, outbox email)
venv/bin/uvicorn server:app --port 8000

# frontend
cd frontend
yarn install && yarn start    # http://localhost:3000
```

Everything works with **no external credentials**: password auth is native, emails land
in the `outbox` collection (and the logs), and payments run a local simulator. Google,
Apple, Stripe, and Resend all switch on only when their env vars are set — see
`backend/.env.example`.

## Auth methods

Email/password (bcrypt), direct Google OAuth, and Apple Sign In — all issuing one
first-party HttpOnly session cookie. Account linking uses a verified-email gate. Email
verification and password reset are built in. See **[SECURITY.md](./SECURITY.md)** for
the full model and **[auth_testing.md](./auth_testing.md)** for copy-paste test flows.

## Payments

`PAYMENTS_MODE` is `fake` by default (full local simulation). Set a real `sk_...` key +
`STRIPE_WEBHOOK_SECRET` to go live: checkout via Stripe Checkout, fulfillment on a
signature-verified, idempotent webhook, tickets delivered by email with QR attachments.

## Compliance

Consent logging, newsletter double opt-in + one-click unsubscribe, data export, and
anonymizing account deletion (invoices retained for fiscal law). No third-party
analytics. Details and the operational follow-ups (Privacy Policy, ToS, DPAs) are in
[SECURITY.md](./SECURITY.md).
