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

### Code splitting

Every route is imported statically in `App.jsx` except three: `Admin`, `CMSEditor` and
`Scan`, which are `React.lazy` over the loaders in `src/pages/backstage.js`. They are
staff-only and they are large — Admin's chunk alone is 216 KB — so bundling them meant a
visitor who came to buy a ticket downloaded the CMS editor first. Splitting them took the
public first load from 782 KB to 496 KB raw, 231 KB to 150 KB gzipped, and took the build
under Vite's 500 KB chunk warning.

The cost of a split route is one round trip the first time it opens, which staff would
pay repeatedly — door staff reload `Scan` on venue wifi. `prefetchBackstage(role)` pays
it up front instead: the header calls it when auth resolves, and it warms only the chunks
that role's links can reach, while the browser is idle. The role table there mirrors the
`roles` on `ACCOUNT_LINKS` in `Layout.jsx`; if you add a staff route, add it to both.

`src/pages/backstage.test.js` asserts the part that matters — that a signed-out visitor
and an ordinary customer fetch none of it.

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

**Audited again 2026-08-20, on the other half of the question.** A pin being *live* says
nothing about it being *current*. A pin is written when some version is the fix; upstream
then publishes a newer fix, the parent package raises its range to ask for it, and the pin
— unchanged, still matching, still "live" — is now the thing holding the vulnerable copy
in place. Two had gone that way:

| pin | was | now | advisory the old value was exposed to |
|---|---|---|---|
| `**/axios/form-data` | 4.0.4 | 4.0.6 | GHSA-hmw2-7cc7-3qxx, CRLF injection, high |
| `**/@eslint/eslintrc/js-yaml` | 4.1.1 | 4.3.1 | GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, DoS, high |

Neither reaches a browser — `form-data` is Node-only inside axios (the built bundle
contains the string `multipart/form-data` and no more), and `js-yaml` is build-time only.
So this was audit hygiene rather than a live hole. It is still the failure mode to watch,
because the pins were doing the opposite of their stated job.

**yarn tells you, on every install.** Each stale pin prints one line:

```
warning Resolution field "form-data@4.0.4" is incompatible with requested version "form-data@^4.0.6"
```

That means a dependent asked for a floor above the pin — read it as "re-check this one",
not as noise. The inverse is legitimate and also warns: `@eslint/plugin-kit` is pinned to
0.3.4 while eslint asks for `^0.2.7`, because the pin deliberately upgrades past
GHSA-xffm-g5w8-qvg7. Tell them apart by which side is higher.

To check a version rather than a name, ask the advisory API directly — it takes package
names to version lists and returns only what those exact versions are exposed to:

```bash
curl -s -X POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk \
  -H 'Content-Type: application/json' \
  -d '{"form-data":["4.0.6"],"js-yaml":["4.3.1"]}'
```

An empty `{}` is the clean answer. Every other pin in the block returned `{}` on
2026-08-20.

Do not delete a pin because its name looks obsolete — `rollup` reads like Vite-era dead
weight but is pulled in by `react-qr-reader`, and dropping it would un-patch it. Re-run
the check above instead, and update the date here.
