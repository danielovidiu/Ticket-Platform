import { handleUpload } from "@vercel/blob/client";

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

export default async function handler(request) {
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
