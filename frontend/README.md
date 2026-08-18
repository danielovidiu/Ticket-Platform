# Frontend

React 19 on Vite, Tailwind and shadcn/ui. The public site, the checkout, the ticket
scanner and the CMS editor all live here.

Deployment, environment variables and the security posture are documented at the repo
root — see [DEPLOY_VERCEL.md](../DEPLOY_VERCEL.md), [DEPLOY_VPS.md](../DEPLOY_VPS.md)
and [SECURITY.md](../SECURITY.md). This file covers only what you run locally.

## Scripts

```bash
yarn start     # dev server on http://localhost:3000
yarn build     # production bundle into build/
yarn preview   # serve that bundle, to check it before deploying
yarn test      # Vitest, once, no watch
```

The backend has to be running for anything that talks to the API; see the repo README.

## Configuration

One variable, in `frontend/.env`, which is gitignored:

```
VITE_BACKEND_URL=http://localhost:8000
```

Neither deployment sets it. Both serve the API on the same origin — Vercel rewrites
`/api/*`, nginx proxies it — so `src/api.js` falls back to `""` and every request is
relative. That is also what `connect-src 'self'` in the CSP rests on.

**The `VITE_` prefix is load-bearing.** Vite exposes only variables carrying it, so
reverting to the old `REACT_APP_` name would not error — the value would silently
become `""`.

## Layout

- `src/pages/` — one file per route
- `src/components/ui/` — vendored shadcn/ui primitives; generated, so edit with care
- `src/components/blocks/` — the CMS block renderers
- `src/lib/` — the CMS theme loader, fonts, media URLs, rich text
- `src/assets/fonts/` — Clash Display, vendored because Fontshare does not publish it
  to npm

`@/` resolves to `src/`, configured in `vite.config.mjs`.

## Build output

`build/`, not Vite's default `dist/` — `vercel.json` and the nginx root in
`DEPLOY_VPS.md` both name that path. Source maps are off, and
`backend/tests/test_deploy_config.py` fails if that changes.

## Dependency pins (`resolutions`)

The `resolutions` block in `package.json` forces transitive dependencies to patched
versions. Most entries are CVE mitigations, so nothing there is decorative.

**Audited 2026-08-18.** The block was inherited from the react-scripts/craco era and
had accumulated pins for packages the Vite toolchain no longer installs — a resolution
that matches nothing is silently inert, which makes the list look like more coverage
than it gives. Twenty-nine dead entries were removed and twelve live ones kept.

The check, against a clean `yarn install --frozen-lockfile`:

- a bare key (`flatted`) is live only if that package is in `node_modules`
- a scoped key (`**/axios/form-data`) is live only if the **parent** is installed *and*
  actually declares that dependency — `**/eslint/js-yaml` failed on the second half,
  since `eslint` has no direct `js-yaml` dep

Two removals looked risky and were not: the `js-yaml` and `form-data` copies that exist
come in via `@eslint/eslintrc` and `axios`, which keep their own pins, so the patched
versions still win. Removing the dead keys left the resolved tree byte-identical.

Do not delete a pin because its name looks obsolete — `rollup` reads like Vite-era dead
weight but is pulled in by `react-qr-reader`, and dropping it would un-patch it. Re-run
the check above instead, and update the date here.
