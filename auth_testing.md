# Auth & fulfillment — local testing

The app runs fully without any external provider credentials: password auth works out
of the box, email lands in `db.outbox` instead of a real inbox, and payments use the
local fake simulator. Google/Apple/Stripe/Resend are all env-gated.

Base URL below is `http://localhost:8000`, `$DB` is your `DB_NAME`. Use a cookie jar to
hold the session.

## Password auth

First name, surname, email and phone are all mandatory, and registration issues **no
session** — the account is inert until the emailed link is clicked.

```bash
# register -> {"ok":true,"verification_required":true,"email":"a@b.co"}. No cookie is set.
curl -X POST localhost:8000/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"a@b.co","password":"hunter2pw","first_name":"Ana","last_name":"Popescu",
       "phone":"+40 721 234 567","tos_accepted":true,"news_opt_in":true}'
# the phone is stored normalized (+40721234567) and `name` is derived ("Ana Popescu")

# signing in before verifying -> 403 {"reason":"email_not_verified","email":"a@b.co"}
curl -X POST localhost:8000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"a@b.co","password":"hunter2pw"}'

# no session to authenticate with yet, so the resend route takes the address instead
curl -X POST localhost:8000/api/auth/resend-verification -H 'content-type: application/json' \
  -d '{"email":"a@b.co"}'                            # -> always {"ok":true} (no enumeration)

curl localhost:8000/api/auth/methods                 # -> {"password":true,"google":false,"apple":false}

# wrong password / missing user / OAuth-only account all return the SAME generic 401
curl -X POST localhost:8000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"a@b.co","password":"WRONG"}'
```

`/api/auth/me` returns two derived booleans the UI keys off: `email_verified` and
`profile_complete` (first name + surname + phone all present). An account that is signed
in but incomplete — every Google/Apple sign-up, since no provider returns a phone number
— is redirected to `/complete-profile`, and `POST /api/reservations` refuses it with
`{"reason":"profile_incomplete"}`.

```bash
# the completion form and Settings both write through the same route; it can fill a
# blank but never empty one
curl -b cj.txt -X PATCH localhost:8000/api/auth/profile -H 'content-type: application/json' \
  -d '{"first_name":"Ana","last_name":"Popescu","phone":"0721 234 567"}'
```

## Email verification & password reset (tokens land in db.outbox)

```bash
mongosh $DB --eval 'db.outbox.findOne({kind:"verify_email"}).payload.verify_url'
curl "localhost:8000/api/auth/verify?token=<token from that url>"
# -> {"ok":true,"email":...,"profile_complete":...}; sign in afterwards, no session here

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
