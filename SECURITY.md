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

### The document needs its own copy — the middleware cannot cover it

That middleware protects **API responses**. The page an attacker would actually frame is
the React build, served by Vercel or by nginx, and those requests never reach FastAPI. So
the same headers are declared twice more, and the three copies have to be kept in step:

| Where | Covers |
|---|---|
| `server.py: security_headers` | `/api`, `/uploads` and `/docs` responses |
| `vercel.json` → `services.frontend.headers` | the SPA on Vercel |
| `DEPLOY_VPS.md` → nginx `server` block | the SPA on the VPS |

The VPS copy carries a **second** policy inside `location /uploads/`, because nginx serves
uploaded media directly and the app's sandboxed CSP never runs for it. Two nginx traps
worth knowing: `add_header` inside a `location` *replaces* the inherited set rather than
adding to it (so every header is repeated there), and without `always` the headers are
dropped on error responses — a framed 404 is still a framed page.

**The frontend CSP.** `script-src 'self'` with no `'unsafe-inline'`, which works because
the CRA build emits no inline scripts — check with
`grep -c '<script>' frontend/build/index.html` after a build, and if that stops being `0`,
fix the build rather than relaxing the policy. `style-src` does need `'unsafe-inline'`:
React renders `style={{…}}` as inline attributes.

Verified by serving the production build behind the exact policy and walking eight routes:
zero violations. That test is also what caught the mistake worth repeating — fonts are
declared from `api.fontshare.com` but *served* from `cdn.fontshare.com`, so the first
draft would have shipped a site with no custom fonts.

> **`connect-src 'self'` assumes the API is same-origin.** It is, on both deployments —
> Vercel rewrites `/api/*` to the backend service, and nginx proxies it — which is why
> `REACT_APP_BACKEND_URL` is built empty. Split the two onto different hosts and every
> API call fails silently until the API origin is added here.

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
| M3 | `SameSite=None` plus no CSRF defence left `multipart/form-data` writes reachable cross-site — JSON was safe only by accident, via the preflight the allowlist rejects | Cookie defaults to `SameSite=Lax`, and an `Origin` guard refuses cross-origin writes ahead of authentication. See **CSRF** below |
| M6 | `PATCH /admin/events/{id}` and `/admin/artists/{id}` took an untyped `dict` and `$set` it wholesale, so the caller chose the *key names* — and a dotted one like `waves.0.available` wrote straight into a wave, past the code that derives stock from what has sold | `EventPatchIn` / `ArtistPatchIn`; unknown keys are dropped, so `$set` only ever sees names the model declares. See **Admin patch bodies** below |
| S1 | Cancelling a paid shop order released its stock and then wrote the status with an unconditional `$set` — six concurrent cancels all returned 200 and each credited the stock (verified: a variant went 5 → 17 where 7 was right) | The status write is conditional on the status the request read, 409 when it loses, and the release happens after the flip |
| M10 | CMS custom HTML was cleaned only by DOMPurify at render time, so MongoDB held the raw string and every non-React consumer got it — and the pinned DOMPurify (3.4.12) had a published bypass | Cleaned server-side with `nh3` on save, publish and version-restore (`backend/sanitize.py`); DOMPurify upgraded to 3.4.13 and narrowed to match. See **CMS HTML** below |
| — | `POST /auth/logout` read only the cookie, so a `Bearer` client got `200 {"ok":true}` while its session stayed valid (found while fixing M2) | Both call sites share `_presented_token`; logout revokes either form |

**Still open:**

| Id | Gap | Effect |
|---|---|---|
| H1 | `X-Forwarded-For` trusted with no proxy allowlist | Every rate limit bypassable; mail bombing; brute force |
| M7–M9, M11, M12, L1–L4 | See the audit | M11 (editor `iframe`, no sandbox) is the last open item in the CMS HTML path |

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

## CSRF

Two layers, covering different things. Neither is a token scheme — see the note at the end
for why.

**1. `SameSite=Lax` on the session cookie.** Default, unconditional, and it refuses to send
the cookie on a cross-site POST at all. `COOKIE_SAMESITE=none` is still accepted for a
genuinely cross-site frontend, but it is validated at startup and logs a warning.

**2. An `Origin` guard** (`csrf_origin_guard`) on every state-changing method, which is
what covers the two things `SameSite` cannot:

- **Subdomains are same-site.** `SameSite` considers `anything.example.com` same-site with
  `example.com`, so a hijacked or user-content subdomain still receives the cookie. A
  different host is a different *origin*, so the guard rejects it.
- **One env var should not be the whole defence.** If `COOKIE_SAMESITE` is ever set to
  `none`, this still stands.

It runs **before authentication**, so a valid admin session does not buy a foreign page a
write, and the refusal costs no database work.

Three deliberate choices in it, each of which breaks something if reversed:

- **A missing `Origin` is allowed.** Browsers always send it on a cross-origin write, so
  its absence means the caller is not a browser — the Stripe webhook, `curl`, the test
  suite on Bearer tokens. Refusing that breaks them and stops no attacker, who cannot
  suppress the header from a browser.
- **`POST /api/auth/apple/callback` is exempt.** Sign in with Apple posts it from Apple's
  origin; that is a legitimate cross-site write, and it carries its own `state` cookie for
  the same purpose.
- **`PUBLIC_APP_URL` is unioned into the allowlist.** `CORS_ORIGINS` only needs to list
  origins making *cross-origin* calls, so a single-origin deployment can legitimately omit
  its own address — and a guard built on that list alone would then reject the frontend's
  own requests, in production only.

**Why no CSRF token.** A double-submit token needs a JS-readable cookie, which widens what
an XSS can do, and adds client plumbing that must not be forgotten on any new call site.
`Lax` plus an origin check covers the realistic attacks — including the subdomain case a
token would also cover — at a fraction of the surface. `backend/tests/test_csrf_origin.py`
pins both the refusals and the exemptions.

## Rate limiting — which of the two to reach for

There are **two** limiters, and picking the wrong one is how you lock a legitimate user
out of their own endpoint. Both share `_rate_check`, so both are bounded by the H2 sweep
and the per-bucket LRU cap; they differ only in what they key on and *when they run*.

| | `rate_limit(bucket, n, window)` | `_email_rate_check(bucket, identity, n, window)` |
|---|---|---|
| Where | `dependencies=[...]` on the route | Called inside the handler |
| Keys on | Client IP (`_client_ip`) | Whatever you pass — an email, a `user_id` |
| Runs | **Before** authentication | After, once you have an identity |

**The rule.** If the endpoint is unauthenticated, key on IP — there is no identity yet.
If it is authenticated and the cost belongs to the account rather than the connection,
key on the account, inside the handler. If it is unauthenticated but *about* a specific
account, use both: `/auth/login` does exactly that, 10 per IP and 10 per email in the same
5-minute window, so neither one attacker's connection nor one targeted account can be
worked over.

**The trap, and it is not obvious.** FastAPI resolves `dependencies=[...]` *before* the
handler's own parameter dependencies — so an IP-keyed limiter on an admin route runs
**before `require_admin`**. Anonymous traffic can then spend the budget, and the real
admin meets a `429` on a route only they can use. On something like
`POST /admin/events/{id}/notify` that means an attacker who cannot authenticate at all
can still stop a cancellation notice going out, which is the moment it matters most. That
endpoint therefore checks *inside* the handler, keyed on `user["user_id"]`, after auth has
resolved:

```python
@api.post("/admin/events/{event_id}/notify")          # no dependencies=[...] limiter
async def admin_event_notify(event_id: str, body: EventNoticeIn, user=Depends(require_admin)):
    _email_rate_check("event_notify", user["user_id"], 30, 3600)
```

The three identity-keyed buckets in the codebase — the exceptions worth knowing:

| Bucket | Keyed on | Budget |
|---|---|---|
| `auth_login_email` | email | 10 / 5 min |
| `auth_verify_resend_email` | email | 3 / 15 min |
| `event_notify` | admin `user_id` | 30 / hour |

Everything else is IP-keyed on the route; `grep -n 'rate_limit("' backend/*.py` lists them.

**Two caveats that apply to both.** The table lives in process memory, so N workers means
N times the configured allowance — which is why `DEPLOY_VPS.md` runs a single uvicorn
worker, and why moving the limiter to Redis is a prerequisite for ever running more than
one. And IP keying is only as honest as `TRUSTED_IP_HEADER` plus a proxy that overwrites
rather than appends: that is H1, still open.

## Roles — enforced server-side, and checked exhaustively

Four roles: `user`, `door`, `editor`, `admin`. The React app hides what a role cannot use,
which is a courtesy, not a control — every route carries its own dependency, and calling
the endpoint directly gets 401 or 403 regardless of what the UI showed.

| Guard | Routes | Reachable by |
|---|---|---|
| `require_admin` | 47 | admin |
| `require_admin_or_editor` | 20 | admin, editor |
| `require_admin_or_door` | 2 | admin, door |
| `get_current_user` | 23 | any signed-in user |
| *(none)* | 37 | public |

`test_rbac.py` used to check a hand-written list of **8 routes out of 66** under `/admin`.
The rule held, but nothing verified it, so "we wrote them all correctly" and "they are all
enforced" were the same sentence. It now **derives the route table from the application
object** and sweeps every guarded route with every wrong identity — 321 assertions. A new
endpoint is covered the moment it exists.

**Two things that derivation alone cannot do**, both learned by breaking them on purpose:

1. A route that *loses* its guard drops out of the derived table, so the HTTP tests
   silently stop covering it. A structural test walks the app and fails on any `/admin`
   path with no auth dependency.
2. A route that is *widened* — `require_admin` to `require_admin_or_editor` — is simply
   re-filed, and "editors are refused here" stops being generated for it. **That mutation
   passed** before it was addressed. So the access model is pinned in
   `tests/rbac_inventory.txt`: 92 lines of who-may-reach-what, asserted against the live
   table. Changing who can reach a route now requires editing a checked-in file in the
   same commit, which is a diff a reviewer sees.

The negative sweep is exhaustive because a rejected request never reaches the handler —
authorization resolves before body validation, so even `POST` with no body returns 401/403
rather than 422, and sweeping every route with the wrong identity has no side effects. The
positive direction is asserted on `GET` routes only: proving the guards let the right role
through must not mean seeding databases, sending mail and deleting records on every run.

## Admin patch bodies — never take a bare `dict`

A route that accepts `body: dict` and hands it to `$set` gives the caller two things, and
the second is the dangerous one:

1. **Skipped validation.** Every `EventIn` constraint is bypassed, so types and ranges the
   create path enforces mean nothing on update.
2. **The key names.** MongoDB reads a dot as a *path*. `{"waves.0.available": 999999}` is
   not a field called `waves.0.available` — it is a write into the first wave's stock,
   which never touches the reconciliation that derives remaining stock from capacity minus
   what has sold. Same shape gets you `waves.0.price_ron`.

That was audit M6, on `PATCH /admin/events/{id}` and `PATCH /admin/artists/{id}`. The
routes are admin-only, so it was privilege *use* rather than escalation — but combined
with M3 (before it was fixed) the write was reachable cross-site.

**The pattern to follow** for any new admin update route:

- A patch model with **every field optional**, separate from the create model. Absent has
  to mean "leave it alone", not "reset to the default".
- `model_dump(exclude_unset=True)` — this is what makes it a PATCH. Without it,
  `{"is_published": true}` writes back every other field as its default and blanks the
  title on the way past.
- **Do not declare server-owned fields.** `WavePatchIn` has no `available`: remaining stock
  is the server's number, and a client that can name it can hand itself inventory. Same
  reasoning for ids, timestamps, and lifecycle fields like `status` / `cancelled_at`.
- Guard the empty `$set`. Once unknown keys are dropped, a body of pure junk dumps to `{}`,
  and Mongo rejects that — a path that was unreachable *because* the junk used to be
  written.

Extra keys are **ignored rather than rejected** (Pydantic's default). This is a deliberate
call: the admin UI edits by sending back the whole document it was handed, ids and
timestamps included, so `extra="forbid"` would turn every save into a 422. The cost is
that a mistyped field name silently no-ops instead of being written, which is the better
of the two failures. If a future route has a hand-written client, `extra="forbid"` there
is strictly better.

`admin_update_product` (`shop_routes.py`) reaches the same place by a different road — an
explicit allowlist of writable keys — and `admin_set_role` only ever writes a role checked
against a four-value enum. Both still have `body: dict` in the signature and so match a
grep for the bug; neither is one.

`backend/tests/test_mass_assignment.py` pins the contract from the outside — dotted paths,
unknown keys, wave stock, and that a full round-trip from the UI still saves.

## CMS HTML — two passes, and the server one is the guarantee

The custom-HTML block is the only place in the frontend that calls
`dangerouslySetInnerHTML`. It is cleaned twice:

| Where | What |
|---|---|
| `backend/sanitize.py`, on write | `nh3` (Rust `ammonia`), at save, publish and version-restore |
| `blocks/index.jsx`, on render | `DOMPurify`, `USE_PROFILES: { html: true }` |

**The server pass is the one that counts.** Client-side-only sanitization meant MongoDB
stored the raw string, so every consumer that is not that one React component — an email,
`GET /api/cms/pages`, an export, a future SSR pass — received the attacker's markup, and
the entire guarantee depended on the DOMPurify build in the visitor's browser. That
dependency bit: the pinned version was 3.4.12, which has a published bypass.

**Allowlist.** nh3's default tag set, verified to contain no `script`, `iframe`, `object`,
`embed`, `form`, `style`, `svg` or `math`. URL schemes are limited to `http`, `https`,
`mailto`, `tel` — `data:` is excluded because it inlines a whole document into an `href`.

**Sanitization keys on the prop name, not the block type.** Any block with a `props.html`
is cleaned, so a new HTML-rendering block is covered the day it is added rather than the
day someone remembers to extend a list.

**Adding a block that renders HTML?** Name the prop `html` and both passes cover it for
free. If you need a different name, extend `sanitize_blocks` in the same change — not
afterwards.

`svg` is deliberately absent from both passes: it widened the mXSS surface for a
capability no block uses. `iframe` is absent too — video embeds are their own block type
with a URL prop, and allowing raw iframes here would reintroduce audit M11 sideways. M11
itself, on that dedicated embed block, is still open.

`backend/tests/test_html_sanitization.py` asserts against **what is in MongoDB** rather
than the response body: a test reading only the response would pass against a server that
sanitized on read and still stored live payloads.

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
- **`GET /admin/newsletter.csv` is open to the `editor` role as well as `admin`, and that
  is deliberate** — editors run the mailings, so requiring an admin to hand them the list
  each time would move the same file around by less careful means. It is the largest
  single pile of personal data the API will return in one response, so the trade is worth
  stating rather than leaving to be inferred from `require_admin_or_editor`: an editor
  account is a subscriber-list export, and should be provisioned and revoked on that
  basis. Pinned by `test_untested_routes.py::TestNewsletterExport`.

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
- **Audit log** (`audit_log`): role changes, refunds (per order and per ticket), door
  denials — who refused whom, for which event, and the stated reason — event cancel/delete, event change
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
