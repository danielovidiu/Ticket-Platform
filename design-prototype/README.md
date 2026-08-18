# Nocturne Assembly

Public website for a music & performance collective. This is the
**foundation + public site** slice: design system, Supabase schema/RLS/auth,
and all public-facing pages reading from seeded data. Ticketing/payments, the
admin dashboard, and transactional email are a later slice — see
[SETUP.md](./SETUP.md) for what's deferred and why.

## Stack

- React + TypeScript + Vite, Tailwind CSS v4 (CSS-first `@theme` config in
  `src/index.css`)
- React Router (`createBrowserRouter`, per-route code splitting)
- Supabase (Postgres + Auth + Storage), `@tanstack/react-query` for data
  fetching
- `react-hook-form` + `zod` for forms

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in Supabase keys — see SETUP.md
npm run dev
```

See [SETUP.md](./SETUP.md) for creating the Supabase project, pushing the
schema, seeding fixture data, and configuring OAuth providers.

## Scripts

| Script              | Purpose                                             |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`        | Start the Vite dev server                            |
| `npm run build`      | Typecheck + production build                         |
| `npm run preview`    | Preview the production build locally                 |
| `npm run typecheck`  | `tsc` in no-emit mode                                 |
| `npm run lint`       | Oxlint                                                |
| `npm run format`     | Prettier (writes)                                     |
| `npm run db:push`    | Push `supabase/migrations/*.sql` to the linked project |
| `npm run db:seed`    | Run `supabase/seed.sql` against the linked project     |
| `npm run gen:types`  | Regenerate `src/types/database.types.ts` from the live schema |

## Project structure

```
src/
  components/
    layout/   Header, MobileNav, Footer, SiteLayout
    ui/       Shared design-system primitives
  features/   One folder per page area (home, mission, projects, gallery,
              contact, artists, faq, legal, auth) — each with api.ts +
              page component(s)
  lib/        Supabase client, env, time (Europe/Bucharest), analytics, seo
  routes/     Router, route guards (scaffolded for a future "My Tickets")
  types/      Database types + derived domain types
supabase/
  migrations/ One migration per table, schema + RLS
  seed.sql    Fictional "Nocturne Assembly" fixture data
```

## Notes

- `src/types/database.types.ts` is hand-written to match the migrations.
  Once a real Supabase project is linked, regenerate it with
  `npm run gen:types` and don't hand-edit past that point.
- The migrations have been reviewed for structural correctness but not yet
  executed against a live Postgres in this environment (no Docker available
  here) — run `npm run db:push` against your own project and skim
  `supabase/migrations/*.sql` once in the Supabase SQL editor before trusting
  it in production.
