/**
 * Issues the short-lived token a browser needs to upload straight to Vercel Blob.
 *
 * WHY THIS EXISTS IN JAVASCRIPT, in a project whose backend is Python.
 *
 * Vercel refuses any request body over about 4.5 MB before the function is reached, so a
 * 100 MB video cannot be posted to the API at all. Measured on this deployment: a 4 MB
 * body reaches the app and is answered 401, a 5 MB body is answered 413 by the edge.
 *
 * Nor can the file be relayed through in pieces: Blob's multipart upload requires 5 MiB
 * parts, which is larger than a request the platform will carry. The two limits exclude
 * each other exactly.
 *
 * What is left is the browser talking to Blob directly, which needs a signed client
 * token. Vercel's PYTHON SDK does not mint one — it exposes server-side operations only —
 * and the signing format is not documented well enough to reimplement against. The
 * JavaScript SDK does, in `handleUpload`, which is what this file is: the one thing the
 * rest of the stack cannot do.
 *
 * The large file goes to Blob. Everything else — the poster frame, images, fonts — still
 * goes through the Python API, which keeps its container sniffing and its re-encoding.
 * That is a real trade and it is stated in the CMS guide: a file that arrives this way is
 * NOT sniffed by us, so the content types below are the whole of the gate.
 *
 *
 * WHY EXPRESS, after four deployments that never ran a line of this file.
 *
 * The service was written twice as a bare entrypoint — once exporting a listening
 * `node:http` server, once exporting a fetch-style `Request -> Response` handler. Both
 * built, both were routed to, and neither ever executed: every request sat for thirty
 * seconds and returned 500 INTERNAL_FUNCTION_INVOCATION_FAILED with `logs: []`.
 *
 * The deployment API says why. Of this project's three services, only this one had no
 * framework detected:
 *
 *     frontend    @vercel/static-build   framework: vite
 *     backend     @vercel/python         framework: fastapi
 *     blobupload  @vercel/backends       framework: null      <- never booted
 *
 * The build artifact reports `launcherType: "Nodejs"` with `shouldAddHelpers: false`,
 * which is the Node FUNCTION launcher: it hands the default export Node's own
 * `(req, res)` pair. A listening server is not callable that way, and neither is a
 * handler expecting a web `Request` — which is why both shapes failed, in the same silent
 * way, for two different reasons.
 *
 * An Express app is exactly a `(req, res)` function, and it can also listen. It satisfies
 * the function launcher and the service runtime at once, and it is the shape every Node
 * example in Vercel's own docs uses. `@vercel/blob` supports it directly: `handleUpload`
 * branches on `"credentials" in request` to tell a web `Request` from a Node one, so the
 * Express request object is passed straight through.
 */
import express from "express";

/* The SDK is loaded lazily, inside a try, rather than imported at the top.
 *
 * A failed top-level import kills the module before a single line runs, and a service
 * that dies at load has nothing to say: the platform answers 500 and the log stream
 * carries `logs: []`. Loading it here means the app always starts and always answers, and
 * a dependency that did not survive the build comes back as its own error message
 * instead of silence.
 */
let cachedHandleUpload = null;

async function getHandleUpload() {
  if (!cachedHandleUpload) {
    const mod = await import("@vercel/blob/client");
    cachedHandleUpload = mod.handleUpload;
  }
  return cachedHandleUpload;
}

/** Only what a <video> can play, and what the block's own CSP `media-src` permits. */
const ALLOWED_CONTENT_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

/** The same ceiling the Python side enforces, so the two cannot drift into disagreeing
 *  about what "too large" means. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Who is allowed to upload, asked of the Python API rather than answered here.
 *
 * The session cookie is validated by the same endpoint the rest of the admin uses, so
 * there is one implementation of "is this an editor" and not two that can disagree. It
 * costs one internal request per token, which is nothing beside the upload it authorises.
 */
async function requireEditor(req) {
  const cookie = req.headers.cookie;
  if (!cookie) throw new Error("Not authenticated");

  // Built from the forwarded host rather than from req.url, which on a service carries
  // only the path. `x-forwarded-proto` is set by Vercel's edge; the fallback is for a
  // local run, where there is no TLS.
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "http";
  if (!host) throw new Error("Not authenticated");

  const res = await fetch(`${proto}://${host}/api/auth/me`, {
    headers: { cookie },
    // Never let a cached answer decide who may write to the store.
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Not authenticated");

  const me = await res.json();
  if (me.role !== "admin" && me.role !== "editor") throw new Error("Not permitted");
  return me;
}

/* Every path, not just "/".
 *
 * The rewrite that exposes this service declares `path: "/"`, and the first deployment
 * that actually BOOTED proved that does not rewrite what the app sees: Express answered
 * its own "Cannot GET /api/blob-upload" 404, which is the original path arriving intact.
 * A useful failure — a 404 from Express is proof the service is running, where the five
 * before it were 500s that proved nothing.
 *
 * A regular expression rather than "*": Express 5 changed its path syntax and a bare
 * asterisk is no longer a valid route. This form works on both 4 and 5.
 *
 * Matching any path is right for this service rather than merely expedient. It does one
 * thing, it is reachable at exactly one public route, and the method already says which
 * of its two behaviours is wanted. Pinning the path here would mean a second place that
 * has to agree with vercel.json about a string.
 */
const ANY_PATH = /.*/;

export const app = express();

app.use(express.json({ limit: "1mb" }));

/* A GET reports whether this service is up and whether its one dependency resolves.
 *
 * It exists because "is the route reaching the function at all" and "did the function
 * load" were, for four deployments, indistinguishable from the outside: both looked like
 * a 500 after thirty seconds. It says nothing a caller could not learn by sending a POST.
 */
app.get(ANY_PATH, async (_req, res) => {
  let sdk = "ok";
  try {
    await getHandleUpload();
  } catch (error) {
    sdk = `unavailable: ${error.message}`;
  }
  res.status(200).json({ service: "blob-upload", listening: true, sdk, runtime: "express" });
});

app.post(ANY_PATH, async (req, res) => {
  try {
    const handleUpload = await getHandleUpload();
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async () => {
        // Before the token, every time. Without this the route is an open door onto the
        // store for anyone who finds the URL.
        const me = await requireEditor(req);
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ user_id: me.user_id || null }),
        };
      },
      onUploadCompleted: async () => {
        // Nothing to do. The editor already holds the URL that `upload()` returned and
        // writes it into the block through the CMS's own save, so there is no record here
        // waiting to be reconciled. Vercel calls this webhook from the outside and it
        // cannot reach a laptop, which is another reason not to make anything depend on
        // it.
      },
    });
    res.status(200).json(jsonResponse);
  } catch (error) {
    // 400 rather than 401 on purpose: Vercel retries this webhook five times looking for
    // a 2xx, and a status it treats as retryable would turn one refused upload into five.
    res.status(400).json({ error: error.message });
  }
});

app.all(ANY_PATH, (_req, res) => res.status(405).json({ error: "Method not allowed" }));

/* Listening is guarded, not conditional on an environment guess.
 *
 * If the platform runs this as a service, the listen is required. If it runs it as a
 * function, the export above is what gets called and the listen is merely unused. The
 * only way it can hurt is by throwing on a port already taken — in a function container
 * that is a crash at import, which is the exact silent failure this file exists to stop
 * repeating. So the error is logged and swallowed.
 */
const server = app.listen(Number(process.env.PORT) || 3000);
server.on("listening", () => console.log("blob-upload listening (express)"));
server.on("error", (error) => console.log(`blob-upload not listening: ${error.message}`));

export default app;
