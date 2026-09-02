import { createServer } from "node:http";
import { handleUpload } from "@vercel/blob/client";

/** Node's request object rendered as the web `Request` that `handleUpload` expects. */
async function toWebRequest(req) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body;
  if (hasBody) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

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
 * JavaScript SDK does, in `handleUpload`, which is what this file is: about forty lines
 * of the one thing the rest of the stack cannot do.
 *
 * The large file goes to Blob. Everything else — the poster frame, images, fonts — still
 * goes through the Python API, which keeps its container sniffing and its re-encoding.
 * That is a real trade and it is stated in the CMS guide: a file that arrives this way is
 * NOT sniffed by us, so the content types below are the whole of the gate.
 */

/** Only what a <video> can play, and what the block's own CSP `media-src` permits. */
const ALLOWED_CONTENT_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

/**
 * Who is allowed to upload, asked of the Python API rather than answered here.
 *
 * The session cookie is validated by the same endpoint the rest of the admin uses, so
 * there is one implementation of "is this an editor" and not two that can disagree. It
 * costs one internal request per token, which is nothing beside the upload it authorises.
 */
async function requireEditor(request) {
  const cookie = request.headers.get("cookie");
  if (!cookie) throw new Error("Not authenticated");

  const origin = new URL(request.url).origin;
  const res = await fetch(`${origin}/api/auth/me`, {
    headers: { cookie },
    // Never let a cached answer decide who may write to the store.
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Not authenticated");

  const me = await res.json();
  if (me.role !== "admin" && me.role !== "editor") throw new Error("Not permitted");
  return me;
}

/** The route's behaviour, as a plain Request -> Response function.
 *
 * Kept separate from the server below so it can be exercised directly, which is how the
 * auth refusals were checked without a deployment. */
export async function handleRequest(request) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json();

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        // Before the token, every time. Without this the route is an open door onto the
        // store for anyone who finds the URL.
        const me = await requireEditor(request);
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          // The same ceiling the Python side enforces, so the two cannot drift into
          // disagreeing about what "too large" means.
          maximumSizeInBytes: 100 * 1024 * 1024,
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
    return Response.json(jsonResponse);
  } catch (error) {
    // 400 rather than 401 on purpose: Vercel retries this webhook five times looking for
    // a 2xx, and a status it treats as retryable would turn one refused upload into five.
    return Response.json({ error: error.message }, { status: 400 });
  }
}

/* A SERVICE, not a function, and the difference is the whole of this block.
 *
 * A Vercel service must call `server.listen()` while the module is loading — that call is
 * how the platform detects the HTTP server and decides where to route requests. The port
 * is only meaningful when running the file locally; it is not exposed publicly.
 *
 * The first version of this file exported a fetch-style handler and nothing else, which
 * is the shape a serverless FUNCTION takes. It deployed, it was routed to, and it never
 * answered: a POST came back 500 FUNCTION_INVOCATION_FAILED and a GET sat until
 * 504 FUNCTION_INVOCATION_TIMEOUT — the platform waiting for a server that was never
 * going to listen.
 */
const server = createServer(async (req, res) => {
  try {
    const response = await handleRequest(await toWebRequest(req));
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    // Never leave the socket open: an unanswered request becomes a platform timeout,
    // which says nothing about what went wrong.
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error?.message || "Upload route failed" }));
  }
});

server.listen(Number(process.env.PORT) || 3000);

export default server;
