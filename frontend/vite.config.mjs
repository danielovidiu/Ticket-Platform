import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
// From vitest/config rather than vite: it is the same defineConfig widened to accept the
// `test` block below, so the two tools read one file.
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],

  resolve: {
    // 45 modules import through this. Resolved from the config's own URL so it does not
    // depend on __dirname, which does not exist in an ES module.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },

  server: {
    // Pinned, not preferred: the backend's CORS_ORIGINS default and the dev launch config
    // both name 3000, and Vite would otherwise wander to the next free port and break the
    // session cookie's origin.
    port: 3000,
    strictPort: true,
  },

  build: {
    // `build`, not Vite's default `dist`. vercel.json's outputDirectory, the nginx root in
    // DEPLOY_VPS.md and both deploy runbooks name this path; keeping it means this change
    // swaps the build tool without also becoming a deployment change.
    outDir: "build",

    // No source maps in a production build.
    //
    // They were 3.9 MB against 912 KB of application code — four times the app — and
    // nothing consumed them: there is no error tracker wired up, so they were published
    // for no reader but a curious one. Minified JS is reversible either way, so this is
    // not a secrecy claim (the bundle carries no secrets — see SECURITY.md); it removes
    // the convenience of a readable map of the attack surface, and 3.9 MB of transfer.
    //
    // Set here rather than via an env flag because `.env*` is gitignored, so an env file
    // would not reach Vercel or a fresh VPS clone — and a build flag that depends on
    // remembering to set it is one deploy away from being unset. nginx also refuses
    // `.map` (DEPLOY_VPS.md) as a backstop for a build that predates this or gets
    // configured around it. test_deploy_config.py fails if this line is undone.
    //
    // To debug a production bundle, build once with this enabled and keep the maps
    // locally; do not ship them.
    sourcemap: false,
  },

  test: {
    environment: "jsdom",
    // react-scripts found this by convention. Vite has no such convention, so the path is
    // stated — deleting the file now fails loudly rather than silently dropping the DOM
    // matchers every test reads with.
    setupFiles: "./src/setupTests.js",
    // describe/it/expect without an import in each file, as the jest runner provided.
    globals: true,
  },
});
