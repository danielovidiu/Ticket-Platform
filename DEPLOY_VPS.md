# Deploying to a root VPS

The alternative to [DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md): one Ubuntu box you control, with
MongoDB, uvicorn and nginx on it, Cloudflare in front. Roughly €22–38/month all-in against
~€145 for the managed stack.

What you gain is not only the bill. Three things this codebase does are workarounds for
serverless, and they stop being necessary here:

* **`storage.py`'s Blob backend.** Leave `BLOB_READ_WRITE_TOKEN` unset and uploads go to
  local disk, which is what the code wanted all along. Relative `/uploads/...` paths become
  servable, which also fixes the missing cover image in event-notice emails.
* **The per-process rate limiter.** One long-lived process means the configured allowance is
  the real allowance — audit finding H1's remaining half, closed by deployment shape rather
  than by code. This is why the unit below runs **one** worker; see the note there.
* **`MONGO_MAX_POOL_SIZE=5`**, which exists to survive serverless fan-out. A persistent
  process holds a normal pool.

And one thing you gain outright: running Mongo as a **single-node replica set** enables
multi-document transactions, which standalone MongoDB does not support at all. That makes
audit findings M4 and M5 — the TOCTOU oversells — fixable without migrating off Mongo.

What you take on: you are the 15-minute incident response, and backups holding ten years of
invoices are yours to prove. Section 8 is the one you cannot skip.

---

## 0. Why one worker is enough — bcrypt is off the event loop

Worth understanding before section 4, because the worker count depends on it.

bcrypt at cost 12 is ~250–300 ms of CPU, and `hash_password`/`verify_password`
(`backend/server.py:541`) are blocking. They used to be called straight from the async
handlers for login, registration and password reset, which stalled the entire worker for
that long on every attempt — not just the caller's request, but every other request in
flight, ticket purchases included.

Vercel hid it completely: one request per function instance, and the platform added
instances. A long-lived uvicorn worker does not. Measured on this codebase, an unrelated
`GET /api/auth/methods` issued while one login was hashing:

| | Unrelated GET |
|---|---|
| bcrypt on the event loop | **356 ms** — fully queued behind the hash |
| bcrypt on the threadpool | **8 ms** |

Routes now `await hash_password_async` / `verify_password_async`, which hand the work to the
threadpool — bcrypt releases the GIL while hashing, so several run genuinely in parallel
across the 4 vCPU while the loop keeps accepting requests. The synchronous versions remain
for `_DUMMY_HASH`, computed once at import.

`tests/test_async_bcrypt.py` guards it, and guards it the only way that works: this is a
regression that breaks no functional test, because every response stays correct — only
latency under concurrency changes. So the test asserts on latency.

**Consequence for this deployment:** one worker is correct. Had the blocking version
survived you would need several workers to absorb it, which would reinstate the
`N × configured` rate-limit problem this deployment exists to solve.

---

## 1. Base system

Ubuntu 24.04 LTS. Everything below assumes a non-root user with sudo; do not run the app as
root.

```bash
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Harden SSH in `/etc/ssh/sshd_config` — `PermitRootLogin no`, `PasswordAuthentication no` —
then `systemctl restart ssh`. **Confirm you can still log in from a second terminal before
closing the first one.**

```bash
apt update && apt upgrade -y
apt install -y nginx mongodb-org python3-venv python3-dev build-essential \
               ufw fail2ban unattended-upgrades rclone age git
ufw default deny incoming && ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable
dpkg-reconfigure --priority=low unattended-upgrades
```

MongoDB is not in Ubuntu's repos — add the official one first, per
[MongoDB's install docs](https://www.mongodb.com/docs/manual/administration/install-on-linux/),
and pin a current 7.x or 8.x.

**Optional hardening worth doing:** once Cloudflare is proxying (section 6), restrict 80/443
to [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) so nobody can reach the origin
directly and forge the client-IP header the rate limiter trusts.

---

## 2. MongoDB — bound to localhost, as a replica set

Edit `/etc/mongod.conf`:

```yaml
net:
  bindIp: 127.0.0.1        # never 0.0.0.0 — this port must not face the internet
  port: 27017

replication:
  replSetName: rs0         # a one-member set is still a replica set
```

```bash
systemctl restart mongod
mongosh --eval 'rs.initiate({_id:"rs0", members:[{_id:0, host:"127.0.0.1:27017"}]})'
mongosh --eval 'rs.status().members[0].stateStr'   # -> PRIMARY
```

### Enabling authentication

Localhost-only binding already stops the internet reaching it; auth is defence in depth
against a compromised app process. There is an ordering trap: **create the user before
enabling auth**, and a replica set with auth requires internal keyfile authentication *even
with one member*. Skip the keyfile and `mongod` will refuse to start.

```bash
mongosh --eval 'db.getSiblingDB("admin").createUser({
  user:"supersanity", pwd:"<generate a long random one>",
  roles:[{role:"readWrite", db:"supersanity"},{role:"clusterMonitor", db:"admin"}]})'

openssl rand -base64 756 > /etc/mongo-keyfile
chown mongodb:mongodb /etc/mongo-keyfile && chmod 400 /etc/mongo-keyfile
```

Then add to `/etc/mongod.conf` and restart:

```yaml
security:
  authorization: enabled
  keyFile: /etc/mongo-keyfile
```

Your connection string becomes:

```
MONGO_URL=mongodb://supersanity:<pwd>@127.0.0.1:27017/?replicaSet=rs0&authSource=admin
```

---

## 3. The application

```bash
sudo -u deploy -i
git clone <your remote> /home/deploy/ticket-platform
cd /home/deploy/ticket-platform/backend
python3 -m venv venv && venv/bin/pip install -r requirements.txt
cp .env.example .env      # then edit — see section 9 for what changes
mkdir -p uploads
```

`requirements.txt` is an unfiltered freeze carrying ~60 unused packages (see
`requirements.in`). Regenerating it with `pip-compile requirements.in` before deploying gives
a smaller install and a smaller attack surface. Optional, but this is the natural moment.

---

## 4. systemd

`/etc/systemd/system/supersanity.service`:

```ini
[Unit]
Description=Supersanity API
After=network.target mongod.service
Requires=mongod.service

[Service]
Type=exec
User=deploy
Group=deploy
WorkingDirectory=/home/deploy/ticket-platform/backend
EnvironmentFile=/home/deploy/ticket-platform/backend/.env
# FORWARDED_ALLOW_IPS comes from the EnvironmentFile above and is read by uvicorn
# itself, so the app's startup guard and uvicorn's proxy handling cannot disagree.
# Set it to 127.0.0.1 here: nginx is on this host, and the nginx block OVERWRITES
# X-Forwarded-For rather than appending, which is what makes trusting it safe.
ExecStart=/home/deploy/ticket-platform/backend/venv/bin/uvicorn server:app \
          --host 127.0.0.1 --port 8000 --workers 1 --proxy-headers
Restart=always
RestartSec=3

# Least privilege — the app needs to write uploads and nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/deploy/ticket-platform/backend/uploads

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now supersanity
journalctl -u supersanity -f
```

**On `--workers 1`.** The rate limiter holds its buckets in process memory, so each worker
enforces its own copy of the allowance — with N workers the real limit is N × configured,
which is exactly the gap audit finding H1 leaves open. One worker keeps the configured number
honest, and given section 0 it comfortably covers this load: ~3 req/s average, with the
on-sale burst bounded by 700 tickets. If you ever do need more workers, move the limiter to
Redis *first* — don't just raise the number.

---

## 5. nginx

`/etc/nginx/sites-available/supersanity`:

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain;

    ssl_certificate     /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;

    # Cloudflare puts the visitor's address in CF-Connecting-IP. Load the CF ranges
    # (see https://www.cloudflare.com/ips/) so $remote_addr becomes the real client.
    include /etc/nginx/cloudflare-ips.conf;
    real_ip_header CF-Connecting-IP;

    client_max_body_size 25M;          # media uploads go through here

    # Security headers for the DOCUMENT. The FastAPI middleware sets its own on /api
    # responses, but the page a browser could frame is this static build, served by
    # nginx — the app never sees that request, so without these the SPA ships with no
    # clickjacking, sniffing or referrer protection at all. On Vercel the equivalent
    # lives in vercel.json; keep the two in step.
    #
    # `always` so they survive error responses (a 404 page is still framable).
    add_header X-Content-Type-Options  "nosniff" always;
    add_header X-Frame-Options         "DENY" always;
    add_header Referrer-Policy         "no-referrer" always;
    # camera=(self), not camera=(): an empty allowlist denies the camera to THIS origin
    # too, which silently breaks the door scanner with no permission prompt.
    add_header Permissions-Policy      "camera=(self), microphone=(), geolocation=()" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    # No 'unsafe-inline' in script-src: the CRA build emits no inline scripts, so the
    # strict form works as-is. Verify with `grep -c "<script>" frontend/build/index.html`
    # after a build — if that ever stops being 0, fix the build, don't relax this.
    # style-src does need it: React renders style={{...}} as inline attributes.
    set $csp "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com; font-src 'self' data: https://fonts.gstatic.com https://api.fontshare.com https://cdn.fontshare.com; img-src 'self' data: blob: https://images.unsplash.com; media-src 'self' blob:; frame-src https://www.youtube.com https://player.vimeo.com; connect-src 'self'";
    add_header Content-Security-Policy $csp always;

    # Source maps are never served, whatever is on disk.
    #
    # The build already emits none (craco.config.js sets devtool=false for production),
    # so this catches the case that config cannot: a build made before that change, a
    # deploy that ran with it patched out, or a stray .map copied in by hand. A rule the
    # server enforces outlives a flag someone has to remember.
    #
    # Regex locations win over prefix ones, so this also covers /uploads/.
    location ~ \.map$ {
        access_log off;
        return 404;
    }

    # Static build. try_files falls back to index.html so React Router owns the routes.
    root /home/deploy/ticket-platform/frontend/build;
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Uploaded media, served by nginx rather than through StaticFiles in the app.
    #
    # This location bypasses FastAPI entirely, so the sandboxed CSP that server.py
    # applies to /uploads never runs here — it has to be restated. Uploaded bytes are
    # stored verbatim (audit M8), which is precisely why this must not inherit the
    # document policy above.
    #
    # nginx gotcha, and the reason every header is repeated: `add_header` in a location
    # block REPLACES the inherited set rather than adding to it. Declaring one here and
    # not the others would silently drop nosniff and X-Frame-Options for this path.
    location /uploads/ {
        alias /home/deploy/ticket-platform/backend/uploads/;
        access_log off;
        expires 30d;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options        "DENY" always;
        add_header Referrer-Policy        "no-referrer" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header Content-Security-Policy "default-src 'none'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; sandbox" always;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        # Set, never forward: nginx overwrites whatever the client sent, so the header
        # the rate limiter trusts cannot be spoofed. This pairs with
        # TRUSTED_IP_HEADER=x-real-ip in .env.
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    server_name your-domain;
    return 301 https://$host$request_uri;
}
```

```bash
ln -s /etc/nginx/sites-available/supersanity /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Build the frontend with the API on the same origin, so `REACT_APP_BACKEND_URL` can be empty:

```bash
cd frontend && yarn install && yarn build
```

---

## 6. Cloudflare

1. Point the domain's nameservers at Cloudflare; set the A record to the VPS IP, **proxied**
   (orange cloud).
2. **SSL/TLS → Full (strict)**, and generate an **Origin Certificate** for the files nginx
   references above. "Flexible" leaves the Cloudflare↔origin hop unencrypted — do not use it.
3. Caching: the default is fine for the static build. Add a rule to **cache `/uploads/*`
   aggressively** — that is most of your egress, and it is what makes bandwidth a non-issue.
4. **Add a rule to bypass cache for `/api/*`.** A cached API response served to the wrong
   session is the worst bug on this list.
5. Leave "Always Use HTTPS" on.

---

## 7. Certificates

With the Cloudflare Origin Certificate there is no certbot and no renewal cron — it is valid
for years and only ever presented to Cloudflare. If you later serve the origin directly,
switch to Let's Encrypt.

---

## 8. Backups — the part you cannot skip

Invoices are fiscal records under ~10-year retention (SECURITY.md → Retention). Atlas was
doing this for you; now it is yours.

`/usr/local/bin/supersanity-backup`:

```bash
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Dump, compress, and encrypt before it ever leaves the box. The archive holds PII and
# fiscal records; the recipient key's private half must live somewhere that is NOT this
# server, or the encryption is theatre.
mongodump --uri="$MONGO_URL" --archive --gzip \
  | age -r "$BACKUP_AGE_RECIPIENT" > "$TMP/db-$STAMP.age"

rclone copy "$TMP/db-$STAMP.age" b2:supersanity-backups/db/
rclone sync /home/deploy/ticket-platform/backend/uploads b2:supersanity-backups/uploads/
rclone delete --min-age 30d b2:supersanity-backups/db/
```

Run it daily with a systemd timer (`supersanity-backup.timer`, `OnCalendar=daily`,
`RandomizedDelaySec=1h`, `Persistent=true`), and point a
[healthchecks.io](https://healthchecks.io) ping at the end of the script so a *silent* backup
failure pages you. A backup job that stops running without telling anyone is the normal way
this goes wrong.

### Rehearse the restore

An untested backup is not a backup. Do this once now, and again after any Mongo upgrade:

```bash
rclone cat b2:supersanity-backups/db/db-<stamp>.age \
  | age -d -i ~/backup-key.txt \
  | mongorestore --uri="$MONGO_URL" --archive --gzip \
      --nsFrom='supersanity.*' --nsTo='restore_test.*'

mongosh --eval 'db.getSiblingDB("restore_test").invoices.countDocuments()'
```

Restoring into `restore_test` rather than over the live database means the rehearsal itself
can't be the outage.

---

## 9. Cutover checklist

Environment differences from the Vercel deployment:

| Variable | Set to | Why |
|---|---|---|
| `MONGO_URL` | the local replica-set URI | Section 2 |
| `BLOB_READ_WRITE_TOKEN` | **unset** | Switches `storage.py` to local disk |
| `PUBLIC_APP_URL` | `https://your-domain` | Every emailed link resolves against it |
| `TRUSTED_IP_HEADER` | `x-real-ip` | Matches what nginx sets in section 5 |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | **Required** — the app refuses to boot without it (audit H1). nginx is on this host and overwrites `X-Forwarded-For`, which is what makes trusting it safe. Read by uvicorn too, so the two cannot drift |
| `COOKIE_SAMESITE` | `lax` | Frontend and API share an origin |
| `SESSION_SECRET` | a fresh 32-byte hex | Required; no ephemeral fallback in production |
| `APP_ENV` | `production` | Refuses to boot with the fake payment simulator |
| `GOOGLE_REDIRECT_URI` | `https://your-domain/api/auth/google/callback` | |

Two external registrations move with you, and both fail loudly only *after* a user is
already mid-flow:

* **Google OAuth.** Add the new redirect URI in the Cloud Console. Miss it and you get
  `redirect_uri_mismatch` before the consent screen — the trap already documented in
  DEPLOY_VERCEL.md.
* **Stripe webhook.** Point the endpoint at `https://your-domain/api/webhook/stripe` and put
  the **new** signing secret in `STRIPE_WEBHOOK_SECRET`. The old secret will not verify.

Moving existing data, if you want it:

```bash
mongodump --uri="<atlas uri>" --archive --gzip > atlas.gz
mongorestore --uri="$MONGO_URL" --archive=atlas.gz --gzip
```

Schema migrations are idempotent and run at startup, so the app converges on
`SCHEMA_VERSION` by itself.

---

## 10. Verify

```bash
curl -s https://your-domain/api/health
```

Returns the commit serving traffic and the schema version the database has migrated to —
`"ok": true` means both halves agree. Then check the things a health endpoint can't:

* `mongosh --eval 'rs.status().members[0].stateStr'` → `PRIMARY`
* Sign in, and confirm the login doesn't stall — that is section 0 having worked
* Upload an image in the admin and confirm it renders from `/uploads/...`
* `curl -sI https://your-domain/api/health | grep -i cf-cache-status` → should say `DYNAMIC`
  or `BYPASS`, never `HIT`
* Run one purchase end to end and confirm the ticket email arrives

Point a free uptime monitor at `/api/health` and alert on the body, not just the status code
— it returns `200` with `"ok": false` when the schema version is behind, which is exactly the
half-broken state you want to hear about.

---

## 11. Deploying a change

```bash
cd /home/deploy/ticket-platform
git pull
backend/venv/bin/pip install -r backend/requirements.txt
cd frontend && yarn install && yarn build
sudo systemctl restart supersanity
```

`restart` is a one-to-two second blip, which is fine on any ordinary day and not fine during
an on-sale. Take a provider snapshot before each event, and don't deploy into a ticket
release.
