# Setup

This covers everything needed to run the **foundation + public site** slice
locally and deploy it. Ticketing/payments (Stripe, SmartBill/Oblio) and
transactional email are a later slice and are deliberately not covered here —
see the note at the bottom.

## 1. Install dependencies

```bash
npm install
```

## 2. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project.
   Prefer an EU region (e.g. Frankfurt) for latency and data residency.
2. In **Project Settings → API**, copy the **Project URL** and **anon public
   key**.
3. Copy `.env.example` to `.env.local` and fill in:
   ```
   VITE_SUPABASE_URL=<project URL>
   VITE_SUPABASE_ANON_KEY=<anon key>
   ```
   The **service role key** is never used by this frontend — it belongs only
   to server-side Edge Functions in a later slice. Never put it in a `VITE_`
   variable.

## 3. Link the CLI and push the schema

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npm run db:push          # applies supabase/migrations/*.sql
npm run db:seed          # loads supabase/seed.sql (Nocturne Assembly fixtures)
npm run gen:types        # regenerates src/types/database.types.ts from the live schema
```

`src/types/database.types.ts` is currently hand-written to match the
migrations. After linking a real project, regenerate it and don't hand-edit
past that point.

Local development against Docker (`supabase start`) also works if you have
Docker installed — this scaffold was written and typechecked without Docker
available, so the migrations have not yet been executed against a live
Postgres. Run `npm run db:push` (or `supabase start` + `supabase db reset`)
before trusting the schema in production, and read through
`supabase/migrations/*.sql` once against the Supabase SQL editor to confirm.

## 4. OAuth providers (Supabase Auth)

All three share one callback URL:
`https://<project-ref>.supabase.co/auth/v1/callback`

- **Google** — Google Cloud Console → APIs & Services → Credentials → OAuth
  Client ID (Web application) → set the redirect URI above → paste the
  Client ID/Secret into Supabase Dashboard → Authentication → Providers →
  Google.
- **Facebook** — Meta for Developers → new Consumer app → add the "Facebook
  Login" product → set the redirect URI above → paste the App ID/Secret into
  Supabase Providers → Facebook. Public (non-tester) login requires Meta App
  Review — budget lead time for this before launch.
- **Apple** — requires a paid Apple Developer Program membership. Create an
  App ID, a Services ID, and a Sign in with Apple key; generate the JWT
  client secret from the Team ID + Key ID + private key; set the redirect
  URI above; paste into Supabase Providers → Apple. This is the slowest
  provider to set up.

Until Facebook/Apple are configured, leave them out of
`VITE_ENABLED_OAUTH_PROVIDERS` (defaults to `google` only) so their buttons
stay hidden.

## 5. Google Analytics (optional for local dev)

1. Create a GA4 property + a Web data stream, copy the Measurement ID
   (`G-XXXXXXX`).
2. Set `VITE_GA_MEASUREMENT_ID` and `VITE_ENABLE_ANALYTICS=true` in your
   environment. Analytics stays fully inert (`src/lib/analytics.ts`) unless
   both vars are set **and** the visitor accepts the cookie consent banner.

## 6. Hosting

Deploy the Vite build (`npm run build` → `dist/`) to any static host (e.g.
Vercel, Netlify, Cloudflare Pages). Whichever URL you use must be:

- set as `VITE_SITE_URL` for that environment, and
- added to Supabase Auth's redirect-URL allow list, and
- added to each OAuth provider's own redirect configuration.

## Deferred to the ticketing/admin slice (not part of this setup)

Stripe (checkout, webhooks), SmartBill or Oblio (invoicing), and a
transactional email provider are **not** configured here. When that slice is
built, their keys will be set as Supabase Edge Function secrets
(`supabase secrets set STRIPE_SECRET_KEY=...` etc.), never as `VITE_`
browser environment variables.
