# Deploying to Vercel + MongoDB Atlas

One Vercel project serves both halves of this repo. `vercel.json` declares two
[services](https://vercel.com/docs/services): the CRA frontend and the FastAPI backend,
with top-level rewrites sending `/api/*` to the backend and everything else to the
frontend.

```
                       ┌─ /api/*  ──▶  backend service   (Python 3.13, server:app)
  supersanity.app ─────┤
                       └─ /*      ──▶  frontend service  (create-react-app, build/)
```

The service receives the **original** path, so the app's `/api` router prefix is
unchanged. Because both halves answer on one domain, the frontend calls `/api/...`
relative and the session cookie is same-site — no CORS preflight, no `SameSite=None`.

> **Services is a Vercel Beta feature and is permission-gated per account.** If the
> first deploy rejects `vercel.json`, that gate is why. The fallback is two separate
> Vercel projects (a static frontend and a Python backend) with
> `REACT_APP_BACKEND_URL` pointing at the backend's domain — at the cost of
> cross-origin cookies, so you'd then leave `COOKIE_SAMESITE` unset.

## 1. MongoDB Atlas

1. Create a cluster and a database user.
2. **Network Access → Add IP Address → `0.0.0.0/0`.** Vercel functions have no stable
   egress IPs on Hobby/Pro, so an allowlist of specific addresses cannot work. The
   database user's password is the only thing standing in front of the cluster —
   make it a long random one.
3. Take the `mongodb+srv://...` connection string for `MONGO_URL`.

Nothing creates the database ahead of time; `DB_NAME` is created on first write.

## 2. Vercel Blob

Uploaded gallery/artist media cannot live on the function's filesystem — it is read-only
outside `/tmp` and every instance gets a fresh one. Create a Blob store under
**Storage → Create → Blob** and connect it to the project. Vercel then injects
`BLOB_READ_WRITE_TOKEN`, which is the only switch `backend/storage.py` looks at: with it
set, uploads go to Blob and are served from Vercel's CDN as absolute URLs; without it,
they go to `backend/uploads` exactly as they do on a laptop.

## 3. Environment variables

Set these on the project (**Settings → Environment Variables**), not in a committed file.

| Variable | Value | Why |
| --- | --- | --- |
| `MONGO_URL` | `mongodb+srv://…` | Atlas connection string |
| `DB_NAME` | e.g. `supersanity` | |
| `SESSION_SECRET` | `python -c "import secrets; print(secrets.token_hex(32))"` | **Required.** The app refuses to start without it on a serverless host — see below |
| `PUBLIC_APP_URL` | `https://<your-domain>` | OAuth callbacks and every email link resolve against this |
| `COOKIE_SAMESITE` | `lax` | Frontend and API share an origin here; the derived default (`none`) would needlessly expose the session cookie cross-site |
| `TRUSTED_IP_HEADER` | `x-vercel-forwarded-for` | Makes the rate limiter work. Vercel sets this header itself and discards any client copy |
| `INITIAL_ADMIN_EMAIL` | your address | The only way an account becomes admin. Without it nobody can reach the admin UI |
| `APP_ENV` | `development` | See the warning below |
| `LOCAL_FAKE_PAYMENTS` | `1` | See the warning below |
| `BLOB_READ_WRITE_TOKEN` | *(injected)* | Added automatically when the Blob store is connected |
| `RESEND_API_KEY`, `MAIL_FROM` | optional | Without them, mail lands in the `outbox` collection instead of being sent |

`SESSION_SECRET` is non-negotiable here even though `APP_ENV` is not `production`. The
development fallback generates a secret per process, and a serverless deployment has one
process per instance — a verification or reset link signed by the instance that sent the
email would be rejected by whichever instance the user's click lands on. It fails
intermittently, looks like a token-expiry bug, and never reproduces locally. The app
raises at import rather than let you find that out in production.

`CORS_ORIGINS` can stay unset: same-origin requests never reach the CORS middleware.

### ⚠️ This deployment runs the fake payment simulator

`APP_ENV=production` requires a real Stripe `sk_...` key, so a deployment without Stripe
has to run as `development`, and that means `LOCAL_FAKE_PAYMENTS=1`. In that mode
`/api/payments/status/{id}` and `/api/webhook/stripe` finalize orders **with no
authentication and no signature check**: anyone who can reach the URL can issue
themselves real tickets and a real invoice for free (SECURITY_AUDIT.md, finding C1).

So until Stripe is wired up, put the deployment behind
**Settings → Deployment Protection → Vercel Authentication**, which requires a Vercel
account on the team to load any page. Switching to real payments later is three
variables — `APP_ENV=production`, `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET` — plus
removing `LOCAL_FAKE_PAYMENTS`; the app refuses to boot if you get that combination
half-right.

## 4. Deploy

```bash
vercel link
vercel deploy --prod
```

Or connect the GitHub repo and push to `main`. (The old GitHub Pages workflow has been
removed — it built a frontend under `PUBLIC_URL=/Ticket-Platform` that pointed at no
backend at all.)

## 5. Verify

```bash
curl -s https://<your-domain>/api/events | head -c 200
```

Then check the function logs for `Indexes ensured`. That line comes from the startup
hook, which also tells you whether the admin bootstrap found your account.

Database setup runs once, not on every cold start: `init_app()` compares a marker
document in `app_meta` against `SCHEMA_VERSION` and the current `INITIAL_ADMIN_EMAIL`,
and returns immediately when they match. Changing `INITIAL_ADMIN_EMAIL` re-runs the
promotion on the next boot; bump `SCHEMA_VERSION` in `server.py` when a future migration
needs to re-run against an already-initialised database.

## Security headers on the frontend

The `security_headers` middleware in `server.py` only sees requests that reach the
backend — which, under this routing, is `/api/*` and nothing else. The HTML and JS come
from the frontend service, so the M1 headers are re-declared there in `vercel.json`
rather than inherited.

`Referrer-Policy: no-referrer` is the one that earns its place: email-verification and
password-reset tokens arrive as query strings on **frontend** URLs, and that page loads
third-party images. Without it, the token is in the `Referer` of every one of those
requests.

There is deliberately no `Content-Security-Policy` on the frontend. A correct one has to
account for CRA's inlined runtime chunk, Tailwind's injected styles, and the Unsplash and
Blob image hosts; a wrong one white-screens the site with no server-side error. Worth
adding, worth doing against a preview deployment with the console open.

## What is still per-instance

The rate limiter holds its buckets in process memory. With `TRUSTED_IP_HEADER` set the
keys are honest, but each instance enforces its own copy of the allowance, so the real
limit is roughly `N × configured` under concurrent traffic. Moving it to Redis (or
Vercel KV) is the fix; it is not one this deployment does.
