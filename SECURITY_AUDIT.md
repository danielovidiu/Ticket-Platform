# Security audit — Supersanity ticket platform

**Scope:** `danielovidiu/Ticket-Platform` @ `274cc90` (main). Backend `backend/server.py`
(2332 lines) + `cms_routes.py` + `mailer.py`; frontend `frontend/src` (React 19 / CRA).
**Method:** full manual read of the backend and the auth/render paths, dependency review,
git-history secret scan, and live probing of a locally running instance.
**Date:** 2026-07-23.

> **Second pass — 2026-08-16.** The original scope has been overtaken: `server.py` is now
> 4136 lines against the 2332 read here, and `shop_routes.py` (730 lines, 21 routes) did
> not exist when this was written and was never in scope at all. A pass over that delta is
> recorded in [Second pass](#second-pass--code-added-after-the-original-scope). It found
> one issue, **S1**, verified and fixed.

Findings marked **[verified]** were reproduced against a running server; the rest are
established by code reading. Where I expected a bug and testing disproved it, that is
recorded too — see [False alarms](#false-alarms-checked-and-cleared).

---

## Executive summary

The identity layer is genuinely good. Password storage, OAuth verification, the
account-linking gate, session rotation, and the GDPR machinery are all better than
typical for a project this size, and several of the hard problems (verified-email
linking, webhook idempotency, atomic stock decrement) are solved correctly.

The exposure is concentrated somewhere else: **the perimeter and the deployment
defaults.** The single most serious issue is that the payment layer silently defaults to
a simulator that hands out tickets for free, and nothing prevents that mode from
reaching production. Second is that every rate limit in the application can be bypassed
with one spoofed HTTP header, which I verified. Neither is a subtle cryptographic flaw —
both are the kind of thing that gets exploited within days of a public launch.

| Severity | Count | Theme |
|---|---|---|
| Critical | 1 | Payment bypass via default config — **fixed** |
| High | 3 | Rate-limit bypass, memory DoS, admin bootstrap race — **1 of 3 fixed (H3)** |
| Medium | 11 | Headers, CSRF, session storage, TOCTOU oversell, upload trust — **M1–M6, M10 and M11 fixed; M7–M9, M12 open** |
| Low | 4 | Info leaks, incomplete refund path |

### Remediation status

| Id | Status | Note |
|---|---|---|
| C1 | **Fixed** | Startup fails closed; verified across a 5-scenario matrix |
| H3 | **Fixed** | First-arrival admin removed entirely; verified on an empty database |
| H2 | **Fixed** | Periodic sweep + per-bucket LRU cap |
| M1 | **Fixed** | Security-headers middleware; path-specific CSP |
| M2 | **Fixed** | `sha256` at rest, migrated in place with no forced logout |
| M3 | **Fixed** | `SameSite=Lax` unconditionally + an `Origin` guard ahead of authentication |
| M4, M5 | **Fixed** | Both oversells closed without transactions; races reproduced first |
| M6 | **Fixed** | Typed patch models on event/artist updates; the dotted-path write is gone |
| L5 | **Fixed** | Bearer clients could not actually log out (found while fixing M2) |
| H1 | **Open — half fixed** | App-side `TRUSTED_IP_HEADER` shipped; uvicorn's `proxy_headers` default still rewrites `request.client.host`, so the bypass survives. Pinned by an `xfail(strict=True)` regression test. Top priority |
| S1 | **Fixed** | Second pass: concurrent order cancel credited stock 6× (verified 5 → 17); write is now conditional |
| M10 | **Fixed** | HTML cleaned server-side with nh3 on save/publish/restore; DOMPurify upgraded past its own bypass |
| M11 | **Fixed** | Embed host allowlist + `sandbox`; CSP `frame-src` already blocked the payload, now matched by the code |
| M7–M9, M12, L1–L4 | Open | See the remediation plan |
| Stale deps | **Fixed** | 126 → 38 runtime packages; `starlette` past CVE-2024-47874 |
| Test suite | **Fixed** | 240 passed / 1 xfailed, from 12 failed / 29 errors / 7 passed |

---

## Strengths

These are real and worth protecting during remediation — do not regress them.

**Credential handling.** bcrypt at cost 12; the 72-byte truncation is handled explicitly
rather than left to silently error. Login returns a byte-identical `401` for a missing
user, an OAuth-only account, and a wrong password, and runs a dummy bcrypt verify on the
missing-user path so timing doesn't separate the cases. Registration collisions return a
generic message. Password reset performs a global session purge.

**OAuth is implemented properly, not hand-waved.** Server-side code exchange; `id_token`
verified through `jwt.PyJWKClient` against the provider's live JWKS with `audience` and
`issuer` pinned — real signature verification, not decode-without-verify. `state` is
compared with `secrets.compare_digest`. Cookie `SameSite` is correctly differentiated
(`lax` for Google's same-site redirect, `none` for Apple's cross-site form POST).
`_safe_return()` rejects `//`-prefixed and absolute paths, closing open-redirect.

**The verified-email linking gate** (`_get_or_create_user`) is the standout. Matching by
provider `sub` first, then permitting email-based linking only when one side has already
proven the address, closes the pre-registration account-takeover hole that silent
merge-by-email opens. Many production systems get this wrong.

**Payment integrity, when live mode is on.** Real `Webhook.construct_event` signature
verification, and replay protection via a unique index on `processed_stripe_events.event_id`
rather than a read-then-write check.

**Inventory concurrency on the main path.** `_atomic_hold_wave_stock` decrements with a
conditional `$elemMatch` and asserts `modified_count == 1` — correct under concurrency.
Ticket scanning is likewise first-scan-wins via a conditional update.

**Data protection.** GDPR export and an erasure that anonymizes rather than hard-deletes,
so invoices survive fiscal retention while PII is scrubbed. Consent log captures IP and
policy version per change. Append-only audit log on role changes, refunds, cancellations,
deletions. Newsletter is genuine double opt-in with `List-Unsubscribe`, and the CSV
export neutralizes spreadsheet formula injection.

**Fail-fast configuration.** Production refuses to boot without `SESSION_SECRET` or with
a wildcard CORS origin while credentials are enabled. Last-admin lockout is guarded in
both role-demotion and self-deletion.

**Supply chain hygiene at the app layer.** No secret has ever been committed — the only
historic hit is the PostHog client key, since removed. `frontend/package.json` carries an
extensive `resolutions` block pinning transitive CVEs.

**Upload deletion is path-traversal safe.** `_delete_upload_file` rejects separators and
dotfiles, resolves, and re-checks the parent directory before unlinking.

---

## Critical

### C1 — Fake payment mode is the silent default; there is no production guard **[verified]** — FIXED

> **Resolved.** `PAYMENTS_MODE` selection was rewritten to fail closed:
> `LOCAL_FAKE_PAYMENTS=1` is the only way to reach the simulator and is refused under
> `APP_ENV=production`; an `sk_...` key selects live Stripe; anything else raises at
> startup in production instead of downgrading. Verified across five scenarios
> (dev-no-key, prod-no-key, prod-fake-flag, prod-key-without-webhook-secret,
> prod-correct) and pinned by
> `test_security_hardening.py::TestPaymentModeFailsClosed`. The original finding follows.

`server.py:73-78`

```python
_force_fake = os.environ.get("LOCAL_FAKE_PAYMENTS", "").strip() == "1"
PAYMENTS_MODE = "stripe" if (STRIPE_API_KEY.startswith("sk_") and not _force_fake) else "fake"
```

An unset or malformed `STRIPE_API_KEY` selects `fake` **silently**. `APP_ENV=production`
does not override it. The current `backend/.env` has no Stripe key at all, so the
deployed default is the simulator.

In `fake` mode:

- `GET /api/payments/status/{session_id}` (**no authentication**) unconditionally sets
  `payment_status = "paid"` and calls `_finalize_paid_reservation`, which issues real
  tickets, writes a real invoice, and emails real QR codes.
- `POST /api/webhook/stripe` (**no authentication, no signature**) accepts plain JSON
  `{"session_id", "payment_status"}` and finalizes the order.

Verified against the running instance:

```
$ curl -X POST localhost:8000/api/webhook/stripe -H 'Content-Type: application/json' \
       -d '{"session_id":"cs_local_probe","payment_status":"paid"}'
{"received":true}   [HTTP 200]
```

**Attack.** Reserve a ticket normally, read the `session_id` returned by `/api/checkout`,
POST it to the webhook, receive tickets. No payment. No authentication on the finalizing
call. Repeatable up to the per-user cap, and with multiple accounts, to the full event
capacity.

**Compromised:** all ticket revenue; event inventory; invoice-series integrity (invoices
numbered for orders that were never paid). This is a whole-business failure, not a
data-confidentiality one.

**Fix.** Refuse to start when `APP_ENV=production` and `PAYMENTS_MODE == "fake"`. Gate
both the fake `payment_status` branch and the fake webhook branch on an explicit
`LOCAL_FAKE_PAYMENTS=1` rather than on "Stripe isn't configured", so a missing key is a
hard failure instead of a silent downgrade.

---

## High

### H1 — Every rate limit is bypassable with a spoofed `X-Forwarded-For` **[verified]**

`server.py:42` and `server.py:261` both take the client IP as:

```python
request.headers.get("x-forwarded-for", "").split(",")[0].strip() or request.client.host
```

The header is trusted unconditionally, with no trusted-proxy allowlist and no
`--forwarded-allow-ips` on uvicorn. A client that sets it directly chooses its own
rate-limit bucket.

Verified — 14 requests to `/api/newsletter` (limit 10/60s):

```
Fixed    X-Forwarded-For: 200 200 200 200 200 200 200 200 200 200 429 429 429 429
Rotating X-Forwarded-For: 200 200 200 200 200 200 200 200 200 200 200 200 200 200
```

28 requests produced **24 queued emails to a single arbitrary address** in a few seconds.
With `RESEND_API_KEY` set those are 24 real deliveries.

**Attack.** (a) Mail-bomb any third party through `/api/newsletter` and
`/api/auth/forgot-password`, burning the sending domain's reputation and likely getting
the Resend account suspended. (b) Unlimited password brute force — `_email_rate_check`
keys on email so a single account is still protected, but spraying one common password
across many accounts is not. (c) Unlimited `/api/contact` and `/api/reservations` volume.

**Compromised:** availability; sender-domain reputation; any account with a weak
password.

**Fix.** Only honour `X-Forwarded-For` from a configured trusted-proxy CIDR; otherwise
use `request.client.host`. Run uvicorn with `--forwarded-allow-ips` set to the proxy.

#### Status: part one done, part two outstanding — still exploitable **[re-verified]**

`TRUSTED_IP_HEADER` implements the first sentence: no forwarding header is believed
unless it is named, and unset is the default. The second sentence was never applied, and
it turns out to carry the fix rather than merely reinforce it.

`_client_ip()` falls back to `request.client.host` believing it to be the socket peer.
Under uvicorn it is not. `proxy_headers` defaults to `True` and `forwarded_allow_ips` to
`127.0.0.1` (uvicorn 0.51.0), so `ProxyHeadersMiddleware` overwrites `request.client.host`
from `X-Forwarded-For` before the ASGI app is called, for every client on that allowlist —
which includes any reverse proxy sharing the host. The application's own guard is applied
to a value that was already substituted underneath it.

Re-verified against `/api/contact` (limit 5/60s), default `uvicorn server:app`,
`TRUSTED_IP_HEADER` unset:

```
no header:                200 200 200 200 200 429 429 429 429
rotating X-Forwarded-For: 200 200 200 200 200 200 200 200 200
```

The `xfail(strict=True)` marker is therefore still correct and must stay. Note the
consequence for reviewers: this finding cannot be closed by reading `server.py`, because
the defect lives in how the process is launched.

Scope by deployment shape:

| Shape | Exposed? |
|---|---|
| `uvicorn` on a laptop or a container, direct | Yes, from any client the allowlist covers (`127.0.0.1` by default) |
| `uvicorn` behind nginx/Caddy on the same host | Yes — the proxy is on the allowlist, so a client-supplied header is honoured unless the proxy replaces it |
| Vercel Python runtime (current production) | No — the uvicorn CLI is not what serves requests there |

Remaining work: pass `--forwarded-allow-ips` naming the real proxy (or `""` when nothing
fronts the app), or set `FORWARDED_ALLOW_IPS`. This becomes urgent with the planned move
off Vercel to a container, which is exactly the shape in the second row.

### H2 — Rate-limiter state grows without bound (memory-exhaustion DoS) — FIXED

> **Resolved.** `_rate_check` now backs both the IP limiter and the per-email limiter, and
> bounds the table two ways: a sweep (at most once every 60s, so it can't be used to burn
> CPU) drops keys whose window has fully expired, and each bucket has a hard
> `RATE_LIMIT_MAX_KEYS` cap with LRU eviction as a backstop for a burst that outruns the
> sweep. Verified by driving 500 distinct keys through a short-window bucket (2 keys
> survive the sweep) and 500 through a capped bucket (stays at the cap). Note the limiter
> is still per-process, so N workers means N times the configured allowance — that is a
> correctness caveat, not the memory issue. The original finding follows.

`_rate_buckets` is a `defaultdict(lambda: defaultdict(deque))`. Entries are created per
`(bucket, ip)` and per `(bucket, email)` and **never removed** — expired timestamps are
popped from each deque, but the empty deque and its key stay forever.

Combined with H1, an attacker chooses the key, so this is directly drivable: each
spoofed IP or submitted email permanently allocates a dict entry plus a deque. Millions
of requests, millions of retained keys, until the worker OOMs.

**Compromised:** availability. The limiter is also per-process, so it already provides no
protection across multiple workers or nodes.

**Fix.** Evict empty deques, cap the key count, and move to Redis for any multi-node
deployment.

### H3 — The first account to register becomes an administrator — FIXED

> **Resolved.** The count-based rule is gone from both `register()` and
> `_get_or_create_user()`; a new `_initial_role()` grants admin only to
> `INITIAL_ADMIN_EMAIL`. Startup additionally warns when no admin account exists at all,
> since that is now a reachable state. Verified against an empty database: the first two
> registrants get `user`, the configured address gets `admin`. Pinned by
> `test_security_hardening.py::TestAdminBootstrap`, which also greps `server.py` to fail
> if a count-based rule is ever reintroduced. The original finding follows.

`register()` (`server.py:537`) and `_get_or_create_user` (`server.py:376`) both assign
`role: "admin"` when `users.count_documents({}) == 0`.

`INITIAL_ADMIN_EMAIL` re-promotes a known address on every startup, but it does not
*prevent* someone else from claiming the first slot. Between the moment the service is
publicly reachable and the moment the real operator registers, **any stranger who hits
`/api/auth/register` first gets full admin** — and the bootstrap does not demote them.

**Compromised:** everything. Admin can read all users, export the newsletter list, alter
prices, issue special links, refund orders, and change roles.

**Fix.** When `INITIAL_ADMIN_EMAIL` is set, grant admin *only* to that address and never
by first-arrival. Otherwise require an explicit one-time bootstrap token.

---

## Medium

### M1 — No security response headers at all **[verified]** — FIXED

> **Resolved.** A middleware in `server.py` now sets `nosniff`, `X-Frame-Options: DENY`,
> `Referrer-Policy: no-referrer`, `Permissions-Policy`, and a CSP on every response, with
> HSTS added only when `PUBLIC_APP_URL` is HTTPS (pinning http dev would be self-inflicted
> downtime). CSP is path-specific: `/uploads` gets a `sandbox`ed policy, `/docs` a narrower
> one permitting the Swagger CDN, everything else the strict default. Verified live on
> success, 401 and 404 paths, and confirmed in the browser that the sandboxed CSP does
> **not** affect `<img>`/`<video>` rendering — the gallery and a 7-image lightbox render
> intact with no CSP violations. The original finding follows.

```
$ curl -D - localhost:8000/api/auth/methods
HTTP/1.1 200 OK
date: ...
server: uvicorn
content-length: 46
content-type: application/json
```

Absent: `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options` /
`frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.

The `Referrer-Policy` gap is the sharpest one here, because **email-verification and
password-reset tokens travel in the URL query string** (`/verify?token=`,
`/reset-password?token=`). With no policy set, the browser default (`strict-origin-when-
cross-origin`) protects cross-origin, but any same-origin sub-resource, and any
`window.open`/link from that page, still carries the full URL — and the token is
additionally exposed in browser history, and in any proxy or CDN access log.

`X-Content-Type-Options: nosniff` matters specifically because `/uploads` is served from
the application origin (see M8).

**Compromised:** admin actions via clickjacking; reset tokens via referrer/log leakage.

### M2 — Session tokens are stored in the database in plaintext — FIXED

> **Resolved.** Only `sha256(token)` is persisted; `_hash_token` is applied on issue,
> lookup, rotation and logout. The startup migration hashes pre-existing rows **in place
> and does not log anyone out** — the value being hashed is exactly what the user's cookie
> already holds, so the next request hashes the same plaintext and matches. Verified by
> planting a legacy plaintext row, restarting, and confirming the untouched cookie still
> authenticates (401 → migrate → 200). Rows are identified by shape (64 hex chars =
> already migrated) because the old rows carry no flag. The original finding follows.

`_issue_session` inserts `secrets.token_urlsafe(32)` verbatim, and `get_current_user`
looks it up by equality. Any read-only exposure of `user_sessions` — a backup, a log, an
injection, a misconfigured Mongo — yields directly usable session cookies for every
logged-in user, admins included.

**Fix.** Store `sha256(token)` and look up by hash. The token stays a bearer secret in
the cookie; the database stops holding a credential.

### M3 — `SameSite=None` with no CSRF token; multipart upload is exposed — **FIXED**

> Partly overtaken by events before the full fix: `COOKIE_SAMESITE` had already been
> changed to default to `lax` unconditionally, which alone closes the attack described
> below. The finding as written — "on HTTPS the session cookie is `SameSite=None`" — was
> stale by then. What remained, and is now also fixed, is the absence of any independent
> check.

On HTTPS the session cookie *was* `SameSite=None; Secure`, and there was no CSRF token or
`Origin` check anywhere.

JSON bodies are protected incidentally: `application/json` forces a CORS preflight, which
the origin allowlist rejects. But `multipart/form-data` is a **CORS-safelisted content
type** — no preflight. `POST /api/admin/uploads` is therefore reachable cross-site: an
attacker page an authenticated admin visits can push files into the platform's upload
directory. The attacker cannot read the response, so this is write-only, but it enables
storage abuse and content planting.

`POST /api/auth/apple/callback` is form-encoded for the same reason (unavoidable — it's
Apple's protocol), and is protected by the `state` cookie instead.

**Fix (applied).** Both halves of the original recommendation:

1. `COOKIE_SAMESITE` defaults to `lax` unconditionally; `none` is still permitted for a
   genuinely cross-site frontend, validated at startup and warned about.
2. `csrf_origin_guard` refuses any state-changing request whose `Origin` is present and
   not in the allowlist, **before authentication runs**. That is what covers the case
   `SameSite` structurally cannot: subdomains are same-site, so a hijacked
   `anything.example.com` still gets the cookie — but it is not the same *origin*.

A missing `Origin` is allowed on purpose: browsers always send it on a cross-origin write,
so its absence identifies a non-browser caller (Stripe's webhook, `curl`, the test suite on
Bearer tokens). Rejecting those breaks them and stops nobody. The Apple callback is exempt
because it is a legitimate cross-site POST from Apple, already guarded by its `state`
cookie.

No token scheme: a double-submit token needs a JS-readable cookie and client plumbing on
every call site, for coverage the origin check already provides. See SECURITY.md → CSRF.

### M4 — Special-link capacity check is TOCTOU (oversell) — **FIXED**

`_resolve_pricing_source` validated `special["used"] + quantity <= capacity` at
*reservation* time, but `used` was only incremented in `_finalize_paid_reservation`.
Unlike wave stock — which uses a correct conditional atomic decrement — nothing held
special-link capacity during the window between reserve and pay.

**Attack.** Fire N concurrent reservations against one special link; all pass the check;
all can be paid. **Compromised:** capacity control on invite/comp links, which are
exactly the ones with discounted or zero pricing. Reproduced at six-for-two before the
fix (`test_oversell_races.py`).

**Fix.** `_atomic_hold_special_link` draws the capacity down *at reservation*, with the
same conditional single-document write wave stock already used. The comparison is an
`$expr` against the document's own `capacity`, so a mid-flight admin edit cannot widen
the window either. `_finalize_paid_reservation` no longer increments — the hold is
already taken — and `_release_reservation_holds` gives it back when a reservation
expires or is rolled back.

### M5 — Per-user ticket cap is TOCTOU — **FIXED**

`_enforce_user_ticket_cap` counted existing tickets plus pending reservations, then the
insert happened separately. Concurrent requests all read the same pre-state and all
passed. **Compromised:** the per-event scalping limit — six simultaneous requests took
six tickets against a cap of two.

**Fix.** The cap is now confirmed *after* the insert rather than before it, which is what
makes it enforceable without a transaction: only once a request has a row can the others
see it. `_confirm_user_ticket_cap` orders the contending reservations by
`(created_at, reservation_id)` — a total order every racer computes identically — and
each keeps only what those ahead of it leave room for. Losers delete their reservation
and release their holds. `_precheck_user_ticket_cap` survives as a fast rejection, and is
explicitly *not* the guarantee.

The rollback deletes before releasing: a crash between the two strands stock that an
admin can recover, where the reverse order would leave a live reservation holding stock
already given back.

### M6 — Admin update endpoints accept an unvalidated `dict` — **FIXED**

`admin_update_event` and `admin_update_artist` took `body: dict` and `$set` it wholesale
after popping only `_id`/`event_id`. Any field name could be written, including dotted
paths that reach into nested documents (`waves.0.available`).

Admin-only, so this is privilege *use* rather than escalation — but it converted a
compromised or careless admin session into arbitrary document mutation, and it bypassed
every `EventIn` validator. Editors do not have this route; that is the saving grace.

**The half that actually bit.** Skipped validation was the visible problem; the dotted
path was the real one. MongoDB reads a dotted key as a *path*, so `waves.0.available`
was a write straight into a wave subdocument — bypassing the reconciliation that derives
remaining stock from capacity minus what has sold, and leaving no trace anywhere. A
single PATCH could un-sell-out an event, or set a wave's price to zero for the next
buyer. `admin_update_artist` was worse still: it never popped `artist_id`, so one
request could rename the primary key and orphan the record outright.

**Fix (applied).** `EventPatchIn` / `ArtistPatchIn` — every field optional, dumped with
`exclude_unset=True` so absent still means "leave it alone" and a request as small as
`{"is_published": true}` does not blank the title. Unknown keys are dropped rather than
written, which is what closes the dotted path: `$set` now only ever receives names the
model declares.

`WavePatchIn` deliberately has no `available` field. Remaining stock is the server's
number, and a client that can name it can hand itself inventory.

Extra keys are **ignored, not rejected**. The admin UI edits by sending back the whole
document it was given — ids, timestamps, `status` and all — so `extra="forbid"` would
have turned every save into a 422. The tradeoff is that a mistyped field name now
no-ops silently instead of being written; that is the better failure of the two.

One consequence worth noting: a body of nothing but unknown keys now dumps to `{}`, and
Mongo rejects an empty `$set`. The handler skips the write instead. That path was
unreachable before precisely *because* the junk was being written.

`test_mass_assignment.py` (19 tests) pins it; 12 of them fail against the old handler.

**Not part of this finding, checked while fixing it.** `admin_update_product`
(`shop_routes.py`) already filters through an explicit allowlist, and `admin_set_role`
only ever writes a role validated against a four-value enum. Both take `body: dict`, so
they match on a grep, but neither is a mass-assignment hole.

### M7 — `origin_url` from the client drives Stripe redirect URLs

`create_checkout` builds `success_url` and `cancel_url` from `body.origin_url` with no
validation, and passes them to Stripe. It should be derived from `PUBLIC_APP_URL`
server-side; the client has no legitimate reason to choose it.

### M8 — Upload type is decided by client-declared `Content-Type`, and original bytes are stored verbatim

`admin_upload_media` maps `file.content_type` to an extension. Images have a thumbnail
re-encoded through Pillow, but **the original file is written unmodified**
(`write_bytes(data)`), and videos are never re-encoded at all. Nothing sniffs the actual
bytes.

The extension allowlist contains no HTML-ish or SVG type, and files are served from
`/uploads` with a server-generated UUID name, so this is not directly stored XSS today.
It becomes one the moment `nosniff` is missing (M1) and a browser sniffs a polyglot, or
the moment SVG is added to the allowlist. Combined with M3 the write is reachable
cross-site.

**Fix.** Verify the magic bytes, re-encode images, and serve `/uploads` with `nosniff`
plus `Content-Disposition: attachment` for non-image types.

### M9 — Request size is checked after the body is fully read

`data = await file.read()` loads the entire upload into memory, *then* compares against
`MAX_UPLOAD_BYTES`. Starlette spools to disk past a threshold, so this is disk-then-RAM
rather than pure RAM, but the 25 MB ceiling is enforced too late to protect either.

Relatedly, no Pydantic model in the codebase sets `max_length`. `ContactMsg.message`,
event descriptions, and CMS block payloads are unbounded, so a single request can store
an arbitrarily large document.

### M10 — CMS HTML is sanitized only in the browser — **FIXED**

`CustomHTML` ran `DOMPurify.sanitize` at render time; the raw HTML was stored server-side
unsanitized. Any consumer that is not this React component — an email, a future SSR pass,
a mobile client, a direct API read — received the unsanitized string.

The config also enabled `USE_PROFILES: { svg: true }`, which widened the mXSS surface for
no benefit visible in the block set. The explicit `FORBID_TAGS`/`FORBID_ATTR` lists were
redundant with DOMPurify's defaults and gave a false impression of being the protection.

**Why this was worse than "defence in depth in the wrong place".** The whole guarantee
rested on the DOMPurify build in whichever browser loaded the page. That is not a
hypothetical dependency: the version pinned here was **3.4.12, which has a published
bypass** (patched in 3.4.13, upgraded in the same change). A stored payload plus a
bypassable renderer is a stored XSS with an expiry date on the mitigation.

**Fix (applied).** `backend/sanitize.py` cleans HTML with **nh3** (Rust `ammonia`) at
three chokepoints: the editor's save, publish, and version-restore. `bleach` was not used
— it is archived, and its `html5lib` parser diverges from browser parsing, which is
exactly where mXSS lives; nh3 parses with html5ever.

The allowlist is nh3's default tag set, which was *verified* to contain no `script`,
`iframe`, `object`, `embed`, `form`, `style`, `svg` or `math` rather than assumed. URL
schemes are restricted to `http`, `https`, `mailto`, `tel` — `data:` is excluded, since it
lets an attacker inline a whole document into an `href`.

Sanitization keys on the **prop name** (`props.html`), not the block `type`, so a new
HTML-rendering block is covered the day it is added rather than the day someone remembers
to extend a list.

The client-side pass stays, as genuine defence in depth and because content stored before
this fix never went through the server. It was narrowed to `USE_PROFILES: { html: true }`
so the two passes agree on what is allowed, and the misleading `FORBID_*` lists were
deleted rather than left to read as protection they were not providing.

`test_html_sanitization.py` (17 tests) asserts against **what is in MongoDB**, not the
response body — a test reading only the response would pass against a server that
sanitized on read and still stored live payloads. 11 of the 17 fail with the server-side
call removed.

No migration was needed: a survey of `cms_pages` found **zero** blocks carrying
`props.html` across all 11 pages, drafts and published alike. The publish and restore
gates cover anything authored between that survey and deployment.

### M11 — Editor-controlled `iframe` with arbitrary origin and no sandbox — **FIXED**

`VideoEmbed` rewrote recognised YouTube/Vimeo URLs, but fell through to `src = props.url`
for anything else, rendering `<iframe src={...}>` with no `sandbox` and no origin
allowlist. An editor — a lower-privileged role than admin — could embed any third-party
page inside a Supersanity URL: convincing credential phishing under the real domain. React
19 neutralizes `javascript:` here, so this was framing abuse, not script execution.

**Already blunted before it was fixed, by accident.** The frontend CSP added for the
clickjacking work carries `frame-src https://www.youtube.com https://player.vimeo.com`,
and a browser enforces it — verified directly: framing `https://example.com` from a page
under that policy is refused, while the YouTube frame loads. So the phishing outcome was
blocked in production even with the passthrough still in the code. That is worth writing
down precisely because it is the kind of mitigation nobody can see from the source, and
the next person to debug a blank embed would have widened the CSP to fix it.

**Fix (applied).** `frontend/src/lib/embeds.js` resolves an author-supplied URL to a
canonical embed src or to **nothing**. There is no passthrough: `resolveEmbed` returns
`null` for anything it does not recognise, and the component renders no iframe at all.

The input side stays generous on purpose — watch links, `youtu.be`, `shorts`, `m.`,
`nocookie`, Vimeo channel and unlisted-hash links all resolve — because an editor who
cannot embed a video reaches for the custom-HTML block instead, and that is a worse place
to be. What is constrained is the **output**: always `www.youtube.com` or
`player.vimeo.com`, parsed with `new URL()` so `https://youtube.com.evil.example/…` is a
different host rather than a substring match.

The iframe now carries `sandbox="allow-scripts allow-same-origin allow-presentation
allow-popups"`. That is the half a CSP cannot do — `frame-src` says who may be framed,
`sandbox` says what they may then do. `allow-top-navigation` is absent, so an embed cannot
move the visitor off the page; so are `allow-forms`, `allow-modals` and `allow-downloads`.

**Failure is now visible to the person who can fix it.** An unresolvable URL renders
nothing on the public site — a visitor can do nothing about it and a broken-embed notice
is worse than an absent block — but the CMS preview shows an explicit "unsupported video
URL" panel with the offending string. Previously both audiences got an empty box.

Pinned from both sides: `embeds.test.js` and `VideoEmbed.test.jsx` (26 tests) assert the
DOM, and `test_embed_allowlist.py` asserts that the code's emit-list and the `frame-src`
in **both** deployed CSPs agree in both directions — a host in the code but not the CSP is
an embed that breaks only in production, and a host in the CSP but not the code is a
permission granted for nothing. Restoring the passthrough fails 4 frontend tests; widening
either CSP fails 2 backend ones.

### M12 — Email inputs are not checked for CRLF

`_valid_email` requires an `@`, a dot in the domain, and a length between 3 and 254. It
does not reject `\r`/`\n`. Resend takes JSON so header injection is not reachable today,
but the validator is the wrong place to rely on the transport, and the address flows into
`List-Unsubscribe` header construction.

---

## Low

- **L1** — The password-reset token embeds the last 12 characters of the bcrypt hash
  (`ph` claim) for single-use enforcement. JWT payloads are base64, not encrypted, so a
  fragment of the hash is readable by anyone who sees the reset URL. Not practically
  crackable without the salt, but a comparison hash of the *hash* would achieve the same
  invalidation with no disclosure.
- **L2** — `GET /api/payments/status/{session_id}` is unauthenticated and returns the
  full transaction document (user_id, amount) to anyone holding the session id.
- **L3** — `admin_refund` marks rows refunded but neither returns stock to the wave nor
  calls Stripe. Refunded inventory is permanently lost from sale.
- **L4** — `_cleanup_expired_reservations` only runs when someone reserves for that same
  event, so expired holds on a quiet event never return stock.
- **L5 — FIXED. Logout silently no-opped for Bearer clients.** Found while fixing M2, not
  in the original review. `get_current_user` accepted the session token from either the
  cookie or `Authorization: Bearer`, but `POST /auth/logout` read only the cookie — so a
  Bearer client (a mobile app, a script, the test fixtures) received `200 {"ok": true}`
  while its session remained valid server-side. A logout that reports success without
  revoking anything is worse than one that fails loudly. Both now resolve the token
  through a shared `_presented_token` helper. This surfaced because the new M2 test
  asserted on the database row rather than trusting the 200.

---

## Second pass — code added after the original scope

**Date:** 2026-08-16. **Reviewed:** everything in `backend/*.py` that changed between
`274cc90` and `84dec83` — 3570 added lines across `server.py` (+2242), `shop_routes.py`
(+730, entirely new), `cms_routes.py` (+392), `mailer.py` (+349), `storage.py` (+130).
That covers event notices, the SMTP backend, async bcrypt, both oversell fixes, door
denial, per-ticket refunds, the ticket status model, the CSRF middleware, and the whole
shop.

### S1 — Concurrent order cancellation credits stock more than once **[verified]** — FIXED

`admin_update_order` read the order, released its stock, then wrote the new status with an
**unconditional** `$set`. Every request that got past the flow check therefore did the
whole job, including the side effects — and nothing made the transition exclusive.

**Reproduced.** Six concurrent `PATCH /api/admin/shop/orders/{id}` with
`{"status": "cancelled"}` against one paid order holding 2 units: **all six returned 200**
and each credited the stock, taking the variant from 5 to **17** where 7 was correct.

Sequential double-clicks were never affected — the second request fails the flow check,
since `cancelled` has no onward transitions. Only genuinely concurrent requests raced,
which makes this a retry/double-submit bug rather than an attack: an admin on a slow
connection, or a client that retries a timed-out PATCH.

The same shape applied to `shipped`, where the repeatable side effect is a shipping email
to the buyer rather than inventory.

**What makes it notable** is that the correct pattern was already in the file, eight lines
above: `expire_stale_orders` flips the status first and releases only on
`modified_count`, with a comment explaining exactly why. This path had simply been missed.

**Fix (applied).** The status write is now conditional on the status the request read, and
returns 409 when it loses; the release happens *after* the successful flip, so stock is
never credited against an order still marked paid. Pinned by
`test_oversell_races.py::TestShopOrderCancelIsNotRepeatable`.

### Checked and cleared in this pass

- **Mail header injection.** Event titles are admin-controlled and reach the mail
  `Subject`; recipients come from the database. Probed `_build_mime` directly with `\n`
  and `\r\n` in both the subject and the recipient — Python's `EmailMessage` raises
  `ValueError` rather than emitting the header, so `Bcc:` cannot be smuggled in. The
  resulting send fails and is reported in the notify endpoint's `failed` count.
- **Shop stock holds.** `hold_stock` is a conditional atomic decrement
  (`$elemMatch` on `stock: {$gte: qty}` plus `$inc`) — the M4 lesson, already applied.
  Partial holds roll back before the order is created.
- **Shop pricing.** `shop_checkout` takes an address and nothing else; every number is
  recomputed server-side from the database. No client-supplied amount reaches Stripe.
- **Shop order IDOR.** `GET /shop/orders/{id}` returns 404 rather than 403 for another
  user's order, so it does not confirm the id exists.
- **Shop admin surface.** All 8 admin shop routes sit behind `require_admin`;
  `admin_update_product` filters through an explicit key allowlist (see M6).
- **Door denial authz.** `/scan/deny` is behind the same guard as `/scan`, and the
  `denied` status is terminal against a rescan.

### Not re-reviewed

`cms_routes.py` (+392) and `storage.py` (+130) were read for authz and for the M10/M11
sanitisation findings only. M10 and M11 have since been fixed (above); the CMS
content pipeline no longer carries an open finding.

## False alarms (checked and cleared)

Recording these so they are not re-investigated, and so the report is not padded.

- **`javascript:` URLs in rich text.** `renderInline` puts `[text](url)` straight into
  `<a href>` with no scheme validation. React 19.0.0 replaces `javascript:` URLs with a
  throwing stub (confirmed in the shipped `react-dom` build), so this is not XSS. The
  residual is only that arbitrary external links can be authored — by admins/editors, who
  can already do that.
- **`stripe.error.SignatureVerificationError`.** The webhook's `except` clause references
  the legacy `stripe.error` module, removed in some 12.x+ versions — which would have
  turned a bad signature into a 500. Verified present as a working alias in the pinned
  `stripe==14.4.1`. Not a bug now, but it is deprecated surface; prefer the top-level
  `stripe.SignatureVerificationError`.
- **Secrets in git history.** Full-history regex scan for Stripe/Resend/AWS/Google/private-key
  patterns returned only the PostHog client key (write-only, already removed). No `.env`
  was ever committed.

---

## Remediation plan

Ordered by risk reduced per unit of work. P0 is the "do not launch without this" set.

### P0 — before any public deployment

1. **Fail closed on payments.** Refuse startup when `APP_ENV=production` and
   `PAYMENTS_MODE == "fake"`. Gate the fake `payment_status` and webhook branches on
   `LOCAL_FAKE_PAYMENTS=1` explicitly, so an absent Stripe key raises instead of
   downgrading. *(C1)*
2. **Trust `X-Forwarded-For` only from a configured proxy.** Add `TRUSTED_PROXY_IPS`;
   fall back to `request.client.host` otherwise; run uvicorn with
   `--forwarded-allow-ips`. *(H1)*
3. **Close the admin bootstrap race.** First-arrival admin only when
   `INITIAL_ADMIN_EMAIL` is unset *and* `APP_ENV != production`; otherwise admin is
   granted solely to that address. *(H3)*
4. **Bound the rate-limiter.** Delete empty deques, cap total keys, shed oldest. *(H2)*

### P1 — first week

5. **Security headers middleware** — HSTS, `nosniff`, `frame-ancestors 'none'` for
   `/admin`, `Referrer-Policy: no-referrer`, a CSP. *(M1)*
6. **Move verification/reset tokens out of the query string** — accept them in a POST
   body from a form on the landing page, so they never enter history, referrers, or
   access logs. *(M1)*
7. **Hash session tokens at rest** (`sha256`), with a one-time migration that invalidates
   existing sessions. *(M2)*
8. **`SameSite=Lax` + `Origin` check** on state-changing routes. *(M3)*
9. **Harden uploads** — sniff magic bytes, re-encode images, serve `/uploads` with
   `nosniff` and `Content-Disposition`, enforce the size cap by streaming. *(M8, M9)*

### P2 — correctness and hardening

10. **Atomic special-link capacity** — conditional `$inc` on reserve, mirroring
    `_atomic_hold_wave_stock`, with release on expiry. *(M4)*
11. **Atomic per-user cap** — a unique-ish counter or conditional update. *(M5)*
12. ~~**Replace `body: dict` with typed patch models** on event and artist updates.~~ *(M6 —
    done: `EventPatchIn` / `ArtistPatchIn`)*
13. **Derive checkout URLs from `PUBLIC_APP_URL`.** *(M7)*
14. **Sanitize CMS HTML on write**; drop the SVG profile; allowlist iframe origins and
    add `sandbox`. *(M10, M11)*
15. **`max_length` on every Pydantic string field**; reject CRLF in emails. *(M9, M12)*

### P3 — operational, not code

16. **Restore the test suite** (see below) — a security fix with no regression test is a
    fix with a shelf life.
17. **Rotate `SESSION_SECRET`** on any suspicion; document that rotation invalidates all
    verification, reset, and unsubscribe links in flight.
18. **Retention job** — the schedule is documented but nothing enforces it. Sessions are
    reaped by the TTL index; `outbox`, `consent_log`, and `audit_log` grow forever.
19. **Backups + restore drill** for Mongo, and confirm backups are encrypted at rest —
    they now contain session tokens (until P1.7) and full PII.
20. **Subprocessor DPAs and the legal texts** (Privacy Policy, ToS, cookie list). The
    code implements the mechanisms; the agreements are still outstanding.

---

## Stale code and dependencies

### The test suite was broken and predated the auth rewrite — FIXED

Was **12 failed, 29 errors, 7 passed** — only `tests/test_oauth_verify.py` ran. The rest
assumed the retired Emergent container: `sys.path.insert(0, "/app/backend")`,
`open("/app/frontend/.env")`, a hardcoded `use('test_database')` in every mongosh helper,
and `UMB_*_TOKEN` variables from a runner that no longer exists.
`test_security_hardening.py` failed at import and still advertised rate-limit coverage of
`/api/auth/session`, deleted in the auth rewrite.

Now **105 passed, 2 xfailed**. What changed:

- `tests/support.py` (new) — all configuration derived from `backend/.env`, the file the
  server itself reads; pymongo instead of mongosh subprocesses; namespaced test data with
  teardown plus an age-gated sweep for interrupted runs.
- `tests/conftest.py` — real role fixtures (admin/editor/door/user). Identities are
  created directly in the database rather than through `POST /api/auth/register`, because
  that endpoint is rate-limited to 5 per 5 minutes and fixtures must not spend a security
  control's budget; registration keeps its own dedicated coverage.
- Whole-session skip with one actionable message when the server isn't up.
- `test_daniel_admin_rbac.py` → `test_rbac.py`. The original asserted that one specific
  personal Gmail address held the admin role and grepped `/var/log/supervisor` for a log
  line — one machine's state, not a rule. The replacement covers the actual matrix
  (anonymous 401 / user 403 / editor split / door split / admin 200).
- New regression tests for C1 and H3, and `xfail(strict=True)` markers for H1 and M1 so
  the open findings are visible and cannot be silently closed.
- `python3 -c` subprocess calls now use `sys.executable`; on this machine `python3` is
  the system 3.9, not the venv.

### Python dependencies — FIXED

> **Resolved.** `requirements.txt` is now compiled by `pip-compile` from a hand-written
> `requirements.in`, with test/lint tooling split into `requirements-dev.in`/`.txt` and
> constrained by the runtime lockfile. **126 → 38 runtime packages** (46 including dev).
> Every package listed below is gone, `starlette` is pinned to 0.40+ past
> CVE-2024-47874, and the project venv was rebuilt and re-verified: server boots, all
> endpoints respond, 105 tests pass. Note `fastapi`'s own floor is `starlette>=0.37.2`
> and the resolver will pick that floor — the explicit `starlette>=0.40` line in
> `requirements.in` is what keeps the CVE fix, so don't drop it when bumping fastapi.
>
> The original finding follows.

`backend/requirements.txt` was an unfiltered `pip freeze` of 126 packages. Cross-checking
against imports actually present in `backend/*.py`, these were **entirely unused**:

| Package | Note |
|---|---|
| `openai`, `google-genai`, `google-generativeai`, `google-ai-generativelanguage`, `tiktoken`, `tokenizers`, `huggingface_hub`, `hf-xet` | AI SDKs from the scaffold — never imported |
| `boto3`, `botocore`, `s3transfer`, `s5cmd` | AWS — never imported |
| `pandas`, `numpy` | never imported |
| `passlib` | superseded; `server.py` calls `bcrypt` directly |
| `python-jose`, `ecdsa`, `rsa` | superseded by `PyJWT`. **`ecdsa` carries the unfixed Minerva timing CVE (CVE-2024-23342)** — harmless while unused, but it is in the image |
| `oauthlib`, `requests-oauthlib` | OAuth is hand-rolled on `httpx` |
| `aiohttp`, `Jinja2`, `MarkupSafe`, `jq`, `fastuuid`, `ast_serialize`, `librt` | unused |
| `black`, `flake8`, `mypy`, `isort`, `pytest`, `pytest-xdist`, `pycodestyle`, `pyflakes`, `mccabe` | dev tooling shipped in the production dependency set |

That is roughly **60 of 126 packages** removable. Each one is attack surface in the
deployed image and noise in every future CVE triage.

**Version concerns:**

- `fastapi==0.110.1` / `starlette==0.37.2` — Starlette below 0.40 is affected by
  **CVE-2024-47874** (unbounded multipart part count → DoS). This project has a multipart
  upload endpoint, so it is reachable. Upgrade.
- `uvicorn==0.25.0` — old; the upgrade is also what makes `--forwarded-allow-ips`
  behave predictably for H1.
- `motor==3.3.1` is in maintenance mode; the driver's future is `pymongo`'s native async
  API.

### Deprecated framework usage

`@app.on_event("startup")` / `@app.on_event("shutdown")` (`server.py:2253, 2268, 2330`)
have been deprecated in FastAPI for several releases in favour of a `lifespan` context
manager, and will be removed. Three call sites.

### Dead configuration

`APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` are read at startup and gate
`APPLE_ENABLED`, but are **never used** — the flow requests `response_type=code id_token`
and only ever verifies the `id_token`, never exchanging the code, so the client-secret JWT
those three values exist to sign is never constructed. They are required-but-inert: an
operator must supply a private key that does nothing.

### Stale artifacts — FIXED

- `test_reports/*.json` — six tracked "iteration" QA reports describing the pre-rewrite
  codebase. **Deleted.**
- `graphify-out/` — 3.4 MB of generated knowledge graph. **Added to `.gitignore`.**
- `/api/seed` docstring read "Public for MVP convenience" while the route is
  `Depends(require_admin)`. **Corrected** — it read like a vulnerability to anyone
  auditing.

### Still stale (not addressed)

- **`@app.on_event`** — three call sites, deprecated in FastAPI. Still functional on the
  upgraded stack (verified on fastapi 0.139 / starlette 1.3), but it emits deprecation
  warnings on every run and will eventually be removed. Migrate to a `lifespan` handler.
- **Dead Apple configuration** — `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` are
  read and gate `APPLE_ENABLED` but are never used, because the code exchange whose
  client-secret JWT they would sign is never performed. Documented in `.env.example` and
  commented at the definition site; not removed, since removing them changes when the
  Apple button appears.

---

## What an attacker gets, by entry point

| Entry point | Requires | Yields | Status |
|---|---|---|---|
| `/api/webhook/stripe` in fake mode | nothing | free tickets, forever (C1) | **closed** — production cannot run fake mode |
| Registering first on a fresh deploy | timing | full admin (H3) | **closed** — admin is config-only |
| Spoofed `X-Forwarded-For` → memory growth | nothing | worker OOM (H2) | **closed** — table is bounded |
| Read access to a Mongo backup | a leaked dump | every live session token (M2) | **closed** — hashes only; PII still exposed |
| Spoofed `X-Forwarded-For` → limit bypass | nothing | mail bombing; brute force (H1) | **open — top priority** |
| A compromised editor account | phishing an editor | site-wide iframe phishing under the real domain (M11) | open |
| An admin visiting a hostile page | no interaction beyond the visit | arbitrary file writes to `/uploads` (M3) | open |
