# Deploying to Vercel + MongoDB Atlas

One Vercel project serves both halves of this repo. `vercel.json` declares two
[services](https://vercel.com/docs/services): the Vite frontend and the FastAPI backend,
with top-level rewrites sending `/api/*` to the backend and everything else to the
frontend.

```
                       ┌─ /api/*  ──▶  backend service   (Python 3.13, server:app)
  supersanity.app ─────┤
                       └─ /*      ──▶  frontend service  (Vite, build/)
```

The service receives the **original** path, so the app's `/api` router prefix is
unchanged. Because both halves answer on one domain, the frontend calls `/api/...`
relative and the session cookie is same-site — no CORS preflight, no `SameSite=None`.

> **Services is a Vercel Beta feature and is permission-gated per account.** If the
> first deploy rejects `vercel.json`, that gate is why. The fallback is two separate
> Vercel projects (a static frontend and a Python backend) with
> `VITE_BACKEND_URL` pointing at the backend's domain — at the cost of
> cross-origin cookies, so you'd then leave `COOKIE_SAMESITE` unset.
>
> The `VITE_` prefix is load-bearing, not decoration: Vite exposes only variables that
> carry it. Setting `REACT_APP_BACKEND_URL` here — the name this used to have — would
> not error. Vite would decline to expose it, `src/api.js` would fall back to `""`, and
> every API call would go to the frontend's own origin and 404.

**The frontend service declares its own SPA fallback, and has to.** This app is a single
page: only `/index.html` exists on disk, and every route below it — `/login`, `/events`,
`/shop/:slug` — is resolved by the router in the browser. A hard navigation to one of
those (`startLogin()` does exactly that, via `window.location.assign("/login?...")`), or
a refresh, asks Vercel for a file that was never built. The `rewrites` block inside the
`frontend` service is what answers those with `index.html` instead of a 404.

Nothing declared it before, because the `create-react-app` framework preset supplied the
fallback implicitly and nobody had to know. `framework: "vite"` does not: Vite builds
multi-page sites too, so Vercel will not assume a single-page fallback. Switching the one
line to `vite` silently removed deep-link routing, and only a hard navigation revealed it
— client-side clicks kept working, so the app looked fine until someone hit Sign In or
pressed reload.

Two details make this the fix rather than a near miss. Rewrites run **after** the
filesystem check, so real files (`/assets/*`, `/favicon.ico`) still serve themselves and
only unmatched paths reach `index.html`. And `/api/*` is claimed by the *top-level*
rewrite before the frontend service is ever selected, so this catch-all cannot swallow an
API call. That ordering matters: [routing into a service is
final](https://vercel.com/docs/services/routing) — if nothing inside the service matches,
Vercel returns the service's 404 rather than falling back to another top-level rule.

## 1. MongoDB Atlas

1. Create a cluster and a database user.
2. **Network Access → Add IP Address → `0.0.0.0/0`.** Vercel functions have no stable
   egress IPs on Hobby/Pro, so an allowlist of specific addresses cannot work. The
   database user's password is the only thing standing in front of the cluster —
   make it a long random one.
3. Take the `mongodb+srv://...` connection string for `MONGO_URL`.

Nothing creates the database ahead of time; `DB_NAME` is created on first write.

## 2a. Large video: the client-upload route

Vercel refuses any request body over about **4.5 MB** before a function is reached, so a
video cannot be posted to the Python API at all. Measured on this project: a 4 MB body
gets a `401` from the app, a 5 MB body gets a `413` from the edge. Relaying it in pieces
does not help either — Blob's multipart upload wants **5 MiB parts**, which is larger than
a request the platform will carry.

So the browser sends large video **straight to Blob**, using a short-lived token minted by
`frontend/api/blob-upload.js`. That file is JavaScript in an otherwise Python backend for
one reason: Vercel's Python SDK has no `handleUpload`, and the token format is not
documented well enough to reimplement.

Three things have to line up, and all three are in the repo:

| | Where |
|---|---|
| The function | `frontend/api/blob-upload.js` |
| Its route, **before** the `/api` catch-all | `vercel.json` → `rewrites[0]` |
| The browser's permission to reach Blob | `vercel.json` → CSP `connect-src https://*.blob.vercel-storage.com` |

It authenticates by asking this deployment's own `/api/auth/me` with the caller's cookie,
so "who may upload" has one implementation rather than two that can disagree. Content
types are restricted to MP4/WebM/MOV and the size to 100 MB.

**A file that arrives this way is not sniffed by the Python container check** — it never
passes through it. The allow-list in that function is the whole of the gate, which is the
trade the platform's limit forces.

Without a Blob store connected, `GET /api/uploads/config` reports `direct_upload: false`
and the editor uses the ordinary API route, which is what happens on a laptop and on the
VPS.

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
| `REQUIRE_PHONE` | *(blank)* | Set to `1` to make the phone number mandatory at signup. Blank = collected but optional; name and surname are always required |
| `APP_ENV` | `development` | Leave it. It does **not** gate payments, and `production` additionally makes an explicit `CORS_ORIGINS` mandatory — see the warning below |
| `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET` | `sk_…`, `whsec_…` | Both, to take payments. Without them the app starts only in simulator mode — see the warning below |
| `LOCAL_FAKE_PAYMENTS`, `I_ACCEPT_FREE_TICKETS_IN_PUBLIC` | `1`, `1` | Simulator mode, for a deployment that sells nothing. **Both** are required here — the first on its own is refused. See the warning below |
| `BLOB_READ_WRITE_TOKEN` | *(injected)* | Added automatically when the Blob store is connected. Also **required** by the client-upload route below — `handleUpload` signs its tokens with it, and OIDC credentials will not do. |
| `RESEND_API_KEY`, `MAIL_FROM` | **effectively required in production** | Without them, mail lands in the `outbox` collection instead of being sent — see below. An SMTP backend exists but is the wrong fit for serverless |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | optional, **Production scope only** | Google sign-in. All three or none — see below |

### Google sign-in

Live on this deployment. The three variables above are read at import, so they do nothing
until a **redeploy** — changing them alone leaves the running deployment reporting
`"google": false`.

Set-up, once, in the Google Cloud Console:

1. **Credentials → OAuth client (Web application) → Authorized redirect URIs**, add
   `https://<your-domain>/api/auth/google/callback`. This is the step that is easy to
   miss: a downloaded client JSON often carries only `javascript_origins`, which belongs
   to the browser-side flow. This app does the server-side code exchange, and without a
   registered redirect URI Google fails with `redirect_uri_mismatch` before the consent
   screen ever appears.
2. **OAuth consent screen → External.** The app asks for `openid email profile` — all
   non-sensitive, so Google's app verification does **not** apply and there is nothing to
   submit or wait for.
3. Leave the screen in *Testing* and add yourself under Test users, or publish it.
   Publishing needs an Authorized domain you can verify ownership of, and `vercel.app` is
   a public-suffix domain nobody owns — so a custom domain is a prerequisite for
   publishing, not for the flow working.

Scope the variables to **Production only**. A preview deployment has a different
hostname, so its `g_state` cookie is set on one origin while Google returns the user to
the production callback on another; the cookie is absent there and the callback fails the
state check with `400 Invalid OAuth state`. Left unset on Preview, `GOOGLE_ENABLED` is
false and the button simply does not render — the better failure.

`GOOGLE_CLIENT_SECRET` belongs in the dashboard, not in `vercel env add`: piping a secret
through a shell writes it to history. Never in a committed file — the client JSON that
Google hands you is exactly the shape that ends up in a repo by accident.

Verify without a browser:

```bash
curl -s https://<your-domain>/api/auth/methods            # -> "google": true
curl -sI "https://<your-domain>/api/auth/google/start"    # -> 302 to accounts.google.com
```

Check the `redirect_uri` inside that 302 matches the registered one character for
character; that is what catches a typo before a user meets `redirect_uri_mismatch`.

`SESSION_SECRET` is non-negotiable here even though `APP_ENV` is not `production`. The
development fallback generates a secret per process, and a serverless deployment has one
process per instance — a verification or reset link signed by the instance that sent the
email would be rejected by whichever instance the user's click lands on. It fails
intermittently, looks like a token-expiry bug, and never reproduces locally. The app
raises at import rather than let you find that out in production.

`CORS_ORIGINS` can stay unset: same-origin requests never reach the CORS middleware.

### Transactional mail

`RESEND_API_KEY` is listed as optional because the app starts without it, not because a
deployment should go without. With no key, `send_mail` writes to the `outbox` collection
and returns success — nothing warns you. Verification links, password resets, ticket
delivery and **event change notices** all go quiet at once, and the failure looks like
nothing at all: a cancellation reports "sent to 47 holders" and reaches nobody.

Two variables:

```
RESEND_API_KEY=re_...
MAIL_FROM=Supersanity <tickets@your-domain>
```

There is also an SMTP backend (`SMTP_HOST` and friends — see `backend/.env.example`),
which takes over when `RESEND_API_KEY` is unset. **Prefer Resend on this host.** A Vercel
Function pays a fresh TCP + TLS + AUTH handshake on every invocation, outbound SMTP ports
are commonly blocked or throttled on serverless platforms, and a slow relay burns function
duration you are billed for. SMTP is there for a laptop, a container, or a VM — and for
SES/Postmark if you would rather own that relationship. Gmail is a testing convenience
only: it rewrites the From header to the authenticated account and caps at ~500
recipients/day, which one large event's change notice can exhaust.

`MAIL_FROM` must be on a domain verified in Resend (**Domains → Add**, then the DNS
records it gives you). Resend supplies `onboarding@resend.dev` for testing without a
verified domain, but it will only deliver to the address that owns the Resend account —
fine for a smoke test, useless for real buyers.

Both are read at import, like the Google variables, so changing them needs a **redeploy**
to take effect.

Verify after deploying by triggering the cheapest real send — a password reset for an
address you control:

```bash
curl -s -X POST https://<your-domain>/api/auth/forgot-password \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
```

It always returns `{"ok":true}` (it will not confirm whether an address exists), so the
result is in your inbox, or in Resend's own **Logs** tab, which shows delivery, bounce and
rejection per message. If the mail never appears and Resend's log is empty, the key was
not picked up and the message is sitting in `outbox`.

### ⚠️ Payments: the simulator, and getting off it

Payment mode is not gated on `APP_ENV`. It is gated on `_is_public_deployment()`, and
Vercel sets `VERCEL=1` itself — so **every deployment here counts as public** whatever
`APP_ENV` says. That leaves two supported states:

* **`STRIPE_API_KEY` is an `sk_...` key.** Real Stripe. `STRIPE_WEBHOOK_SECRET` is then
  mandatory and the app refuses to start without it. An `sk_test_...` key is fine and
  takes the same path — the check is the `sk_` prefix, not the word "live". A
  restricted `rk_...` key does **not** pass it.
* **No key.** The app refuses to start at all, unless you opt in to the simulator with
  **both** `LOCAL_FAKE_PAYMENTS=1` **and** `I_ACCEPT_FREE_TICKETS_IN_PUBLIC=1`.
  `LOCAL_FAKE_PAYMENTS=1` on its own is refused, because this host is public.

In simulator mode `/api/payments/status/{id}` and `/api/webhook/stripe` finalize orders
**with no authentication and no signature check**: anyone who can reach the URL can
issue themselves real tickets and a real invoice for free (SECURITY_AUDIT.md, finding
C1). A deployment running it belongs behind **Settings → Deployment Protection →
Vercel Authentication**, which requires a Vercel account on the team to load any page.

Switching to real payments is **four** changes:

1. Add `STRIPE_API_KEY` (`sk_...`).
2. Add `STRIPE_WEBHOOK_SECRET` (`whsec_...`), from an endpoint registered against
   `https://<your-domain>/api/webhook/stripe`.
3. Delete `LOCAL_FAKE_PAYMENTS`.
4. Delete `I_ACCEPT_FREE_TICKETS_IN_PUBLIC`. **This is the one that gets forgotten.**
   Left set, a later typo in the Stripe key — anything not starting `sk_` — stops being
   a startup failure and quietly selects the simulator again, which is the whole
   condition the guard exists to prevent.

Add the two Stripe variables **before** deleting the two simulator ones: with all four
absent the app raises on startup rather than falling back, so a deploy landing between
the halves fails outright.

Leave `APP_ENV` alone. It buys nothing here — the hardening it gates is already on via
`VERCEL=1` — and `production` additionally makes an explicit `CORS_ORIGINS` mandatory,
which is one more way to fail to boot.

Note that turning Vercel Authentication **on** blocks Stripe too: its webhook POSTs get
the login challenge, so payments never finalize and reservations expire as if abandoned.
Once real payments are in, C1 is closed and the protection has served its purpose.

Verify from outside afterwards — `/api/health` withholds the mode deliberately:

```bash
curl -s -X POST https://<your-domain>/api/webhook/stripe \
  -H 'content-type: application/json' --data 'not-json'
```

`{"detail":"Invalid signature"}` is Stripe mode. `{"detail":"Invalid payload"}` is still
the simulator.

**If you used a Stripe sandbox.** Sandboxes are isolated environments with their own
keys, webhook endpoints and data. If the endpoint was created inside one, the API key
has to come from that same sandbox. A mismatched pair reports no error anywhere — the
Checkout Sessions are simply created in one environment and the endpoint listens in
another, and every order hangs as pending until it expires.

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
curl -s https://<your-domain>/api/health
```

```json
{"ok":true,"commit":"9275e58…","schema_version":3,"schema_version_expected":3,"db":true}
```

`commit` is the build that is actually serving traffic — Vercel injects
`VERCEL_GIT_COMMIT_SHA` on every deployment, so this is how you confirm a fix reached
production without reading the dashboard. Set `GIT_COMMIT` by hand on any other host.

The two version fields are the migration check. `schema_version_expected` is compiled
into the running code; `schema_version` is what the database records having completed.
Equal (and `ok: true`) means init finished and every migration behind that number has
run. Expected ahead of actual means the new build is live but has not yet cold-started
into its migrations — the window in which a backfill looks like it silently failed.

The endpoint is unauthenticated so a monitor can read it, and deliberately says nothing
about how the app is configured. Keep it that way: `PAYMENTS_MODE` in particular must
never appear here, because the fake-payment fallback issues real tickets for free
(SECURITY_AUDIT.md C1) and this URL is public.

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
