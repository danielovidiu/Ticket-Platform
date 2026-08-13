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

## Google / Apple

**Google is live in production** against a real OAuth client — see the Google sign-in
section of `DEPLOY_VERCEL.md` for the Console set-up and the environment variables. Apple
is not configured.

Locally, and for anyone without credentials, the machinery below is verifiable with fake
ones: what it exercises is the state/redirect plumbing and the token verification, not a
live login.

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

## Event change notices — who gets one

Admin-only. Reaches holders of **issued** tickets for one event; refunded holders are
excluded and a buyer with four tickets is one recipient.

```bash
# how far it would reach, before writing anything — a preview never sends
curl -b cj.txt localhost:8000/api/admin/events/<event_id>/notice-preview
# -> {"recipient_count":1,"title":...,"facts":{...}}

curl -b cj.txt -X POST localhost:8000/api/admin/events/<event_id>/notify \
  -H 'content-type: application/json' \
  -d '{"kind":"venue","message":"We moved to Control Club, 5 min away."}'
# -> {"ok":true,"recipient_count":1,"sent":1,"failed":0,...}

mongosh $DB --eval 'db.outbox.find({kind:"event_notice"},{to:1,subject:1})'
curl -b cj.txt localhost:8000/api/admin/events/<event_id>/notices   # what already went out
```

`kind` is one of `venue` · `time` · `lineup` · `cancelled` — anything else is `422`, as is
an empty message. Non-admins get `403`. Sends are capped per admin per hour (keyed on the
account, not the IP, so an anonymous flood cannot spend an admin's budget).

Targeting is the thing worth testing. Give one user two `issued` tickets and another a
`refunded` one, then check the outbox holds exactly one message:

```bash
mongosh $DB --eval 'db.outbox.countDocuments({kind:"event_notice"})'
```

To eyeball the rendered email, write the stored HTML out and open it:

```bash
mongosh $DB --quiet --eval 'db.outbox.findOne({kind:"event_notice"},{_id:0,html:1}).html' > /tmp/notice.html
```

## Pointing local dev at a real inbox

Everything above reads `db.outbox`, the third and last backend. `send_mail` picks the
first one configured:

| Backend | Switch | When |
|---|---|---|
| Resend | `RESEND_API_KEY` | Production. An HTTP API survives serverless; SMTP largely does not |
| SMTP | `SMTP_HOST` | Any relay — SES, Postmark, Gmail, or a local catcher. Best for a laptop |
| outbox | *(neither set)* | Default. Nothing leaves the process |

All of these are read **at import**, so `--reload` on a running process will not pick up
a change — restart the server.

**A local catcher** is the least friction: no account, no credentials, nothing can escape
to a real person. Mailpit serves a web inbox on `:8025`:

```bash
docker run -d --rm -p 1025:1025 -p 8025:8025 axllent/mailpit
```

```
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURITY=none
```

Leave `SMTP_USER` blank and AUTH is skipped entirely, which is what a catcher expects.

**Gmail** works with an App Password (Google Account → Security → App passwords; requires
2-Step Verification). The account password will be refused — "less secure app access" was
removed in 2022.

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=<16-char app password>
MAIL_FROM=You <you@gmail.com>
```

Two Gmail-specific traps: it **rewrites `MAIL_FROM`** to the authenticated address unless
that address is a verified "Send mail as" alias, so a mismatched `MAIL_FROM` is silently
ignored; and it caps sending at ~500 recipients/day (~2000 on Workspace). Event notices
fan out one message per holder, so a large event can hit that cap and lock sending for a
day. Fine for testing, not for buyers. **SES and Postmark** take the same four variables
with no such rewriting, and are the right choice if you want SMTP in production.

**Resend** needs a key and a sender. `onboarding@resend.dev` is their shared testing
address: no DNS setup, but it only delivers to the address that owns the Resend account.

Whichever you pick, **nothing lands in `outbox` any more** once a backend is configured —
verify from the return value (`{"ok":true,"provider":"smtp"|"resend",...}`) and from the
relay's own logs. An `{"ok":false,...}` means the send was rejected; it is logged and
never raises, by design, so a mail failure cannot roll back a paid order. A failing
backend does **not** fall through to the outbox: that would record a success for a message
nobody received.

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
