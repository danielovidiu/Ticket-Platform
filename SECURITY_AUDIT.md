# Security audit — Supersanity ticket platform

**Scope:** `danielovidiu/Ticket-Platform` @ `274cc90` (main). Backend `backend/server.py`
(2332 lines) + `cms_routes.py` + `mailer.py`; frontend `frontend/src` (React 19 / CRA).
**Method:** full manual read of the backend and the auth/render paths, dependency review,
git-history secret scan, and live probing of a locally running instance.
**Date:** 2026-07-23.

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
| Medium | 11 | Headers, CSRF, session storage, TOCTOU oversell, upload trust |
| Low | 4 | Info leaks, incomplete refund path |

### Remediation status

| Id | Status | Note |
|---|---|---|
| C1 | **Fixed** | Startup fails closed; verified across a 5-scenario matrix |
| H3 | **Fixed** | First-arrival admin removed entirely; verified on an empty database |
| H1, H2 | Open | Pinned by an `xfail(strict=True)` regression test |
| M1 | Open | Pinned by an `xfail(strict=True)` regression test |
| M2–M12, L1–L4 | Open | See the remediation plan |
| Stale deps | **Fixed** | 126 → 38 runtime packages; `starlette` past CVE-2024-47874 |
| Test suite | **Fixed** | 105 passed / 2 xfailed, from 12 failed / 29 errors / 7 passed |

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

### H2 — Rate-limiter state grows without bound (memory-exhaustion DoS)

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

### M1 — No security response headers at all **[verified]**

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

### M2 — Session tokens are stored in the database in plaintext

`_issue_session` inserts `secrets.token_urlsafe(32)` verbatim, and `get_current_user`
looks it up by equality. Any read-only exposure of `user_sessions` — a backup, a log, an
injection, a misconfigured Mongo — yields directly usable session cookies for every
logged-in user, admins included.

**Fix.** Store `sha256(token)` and look up by hash. The token stays a bearer secret in
the cookie; the database stops holding a credential.

### M3 — `SameSite=None` with no CSRF token; multipart upload is exposed

On HTTPS the session cookie is `SameSite=None; Secure` and there is no CSRF token or
`Origin` check anywhere.

JSON bodies are protected incidentally: `application/json` forces a CORS preflight, which
the origin allowlist rejects. But `multipart/form-data` is a **CORS-safelisted content
type** — no preflight. `POST /api/admin/uploads` is therefore reachable cross-site: an
attacker page an authenticated admin visits can push files into the platform's upload
directory. The attacker cannot read the response, so this is write-only, but it enables
storage abuse and content planting.

`POST /api/auth/apple/callback` is form-encoded for the same reason (unavoidable — it's
Apple's protocol), and is protected by the `state` cookie instead.

**Fix.** Use `SameSite=Lax` unless the frontend genuinely sits on a different site; add
an `Origin`/`Referer` check on state-changing routes.

### M4 — Special-link capacity check is TOCTOU (oversell)

`_resolve_pricing_source` validates `special["used"] + quantity <= capacity` at
*reservation* time, but `used` is only incremented in `_finalize_paid_reservation`.
Unlike wave stock — which uses a correct conditional atomic decrement — nothing holds
special-link capacity during the window between reserve and pay.

**Attack.** Fire N concurrent reservations against one special link; all pass the check;
all can be paid. **Compromised:** capacity control on invite/comp links, which are
exactly the ones with discounted or zero pricing.

### M5 — Per-user ticket cap is TOCTOU

`_enforce_user_ticket_cap` counts existing tickets plus pending reservations, then the
insert happens separately. Concurrent requests all read the same pre-state and all pass.
**Compromised:** the per-event scalping limit.

### M6 — Admin update endpoints accept an unvalidated `dict`

`admin_update_event` and `admin_update_artist` take `body: dict` and `$set` it wholesale
after popping only `_id`/`event_id`. Any field name can be written, including dotted
paths that reach into nested documents (`waves.0.available`).

Admin-only, so this is privilege *use* rather than escalation — but it converts a
compromised or careless admin session into arbitrary document mutation, and it bypasses
every `EventIn` validator. Editors do not have this route; that is the saving grace.

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

### M10 — CMS HTML is sanitized only in the browser

`CustomHTML` runs `DOMPurify.sanitize` at render time; the raw HTML is stored server-side
unsanitized. Any consumer that is not this React component — an email, a future SSR pass,
a mobile client, a direct API read — receives the unsanitized string. Sanitize on write
as well as on render.

The config also enables `USE_PROFILES: { svg: true }`, which widens the mXSS surface for
no benefit visible in the block set. The explicit `FORBID_TAGS`/`FORBID_ATTR` lists are
redundant with DOMPurify's defaults and give a false impression of being the protection.

### M11 — Editor-controlled `iframe` with arbitrary origin and no sandbox

`VideoEmbed` (`blocks/index.jsx:270`) rewrites recognised YouTube/Vimeo URLs, but falls
through to `src = props.url` for anything else, rendering `<iframe src={...}>` with no
`sandbox` and no origin allowlist. An editor — a lower-privileged role than admin — can
embed any third-party page inside a Supersanity URL: convincing credential phishing under
the real domain. React 19 neutralizes `javascript:` here, so this is framing abuse, not
script execution.

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

---

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
12. **Replace `body: dict` with typed patch models** on event and artist updates. *(M6)*
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
| Spoofed `X-Forwarded-For` | nothing | all rate limits void; mail bombing; DoS (H1, H2) | open |
| Read access to a Mongo backup | a leaked dump | every live session token; all PII (M2) | open |
| A compromised editor account | phishing an editor | site-wide iframe phishing under the real domain (M11) | open |
| An admin visiting a hostile page | no interaction beyond the visit | arbitrary file writes to `/uploads` (M3) | open |
