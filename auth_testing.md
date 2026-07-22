# Auth & fulfillment — local testing

The app runs fully without any external provider credentials: password auth works out
of the box, email lands in `db.outbox` instead of a real inbox, and payments use the
local fake simulator. Google/Apple/Stripe/Resend are all env-gated.

Base URL below is `http://localhost:8000`, `$DB` is your `DB_NAME`. Use a cookie jar to
hold the session.

## Password auth

```bash
# register (auto-logs-in, sets session cookie)
curl -c cj.txt -X POST localhost:8000/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"a@b.co","password":"hunter2pw","name":"A","tos_accepted":true,"news_opt_in":true}'

curl -b cj.txt localhost:8000/api/auth/me            # -> your user (no password_hash)
curl localhost:8000/api/auth/methods                 # -> {"password":true,"google":false,"apple":false}

# wrong password / missing user / OAuth-only account all return the SAME generic 401
curl -X POST localhost:8000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"a@b.co","password":"WRONG"}'
```

## Email verification & password reset (tokens land in db.outbox)

```bash
mongosh $DB --eval 'db.outbox.findOne({kind:"verify_email"}).payload.verify_url'
curl "localhost:8000/api/auth/verify?token=<token from that url>"

curl -X POST localhost:8000/api/auth/forgot-password -d '{"email":"a@b.co"}' -H 'content-type: application/json'
mongosh $DB --eval 'db.outbox.findOne({kind:"password_reset"}).payload.reset_url'
curl -X POST localhost:8000/api/auth/reset-password -H 'content-type: application/json' \
  -d '{"token":"<token>","new_password":"brandnew99"}'
# -> all prior sessions invalid (global logout); the reset token is single-use
```

## Google / Apple (fake creds — verify machinery, not a live login)

Set `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` and hit `/api/auth/google/start` → it 302s to
Google with a `state` cookie; the callback rejects a mismatched state with 400. The real
JWT signature-verification paths are covered by `backend/tests/test_oauth_verify.py`
(signs a token with a local RSA key served as the mock JWK; asserts the genuine
`jwt.decode` accepts valid and rejects wrong-audience/issuer/expired/tampered). Apple's
`form_post` + `SameSite=None` state cookie needs a public HTTPS callback (staging only).

```bash
cd backend && venv/bin/python -m pytest tests/test_oauth_verify.py -q
```

## Newsletter double opt-in

```bash
curl -X POST localhost:8000/api/newsletter -d '{"email":"n@x.co"}' -H 'content-type: application/json'
mongosh $DB --eval 'db.newsletter_subscriptions.findOne({email:"n@x.co"}).status'   # pending
curl "localhost:8000/api/newsletter/confirm?token=<from outbox>"                     # -> confirmed
curl -X POST localhost:8000/api/newsletter/unsubscribe -d '{"token":"<unsub token>"}' -H 'content-type: application/json'
```

## Payments (fake mode) — full purchase to ticket email

```bash
curl -b cj.txt -X POST localhost:8000/api/reservations -H 'content-type: application/json' \
  -d '{"event_id":"<id>","wave_id":"<id>","quantity":2}'
curl -b cj.txt -X POST localhost:8000/api/checkout -H 'content-type: application/json' \
  -d '{"reservation_id":"<id>","origin_url":"http://localhost:3000"}'
curl localhost:8000/api/payments/status/<session_id>          # -> payment_status: paid
mongosh $DB --eval 'db.outbox.findOne({kind:"ticket_delivery"}).subject'   # ticket email queued
```

## Payments (stripe mode) — webhook signature fully testable locally

Boot with `STRIPE_API_KEY=sk_test_...` and `STRIPE_WEBHOOK_SECRET=whsec_...`, sign a
payload with the real `stripe.WebhookSignature`, and POST it: valid signature accepted,
replaying the same `event.id` is a no-op (idempotency), tampered body / bad signature is
`400`. Live `checkout.Session.create` / `Customer.create` still need a real Stripe test key.

## Data rights

```bash
curl -b cj.txt localhost:8000/api/auth/export      # JSON bundle of everything about you
curl -b cj.txt -X DELETE localhost:8000/api/auth/account   # anonymize; invoices retained
```
