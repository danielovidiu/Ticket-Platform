import axios from "axios";
import { toast } from "sonner";

// Empty means "same origin", which is the deployed shape: Vercel routes /api/* to the
// backend service and everything else here, so the browser never leaves the domain and
// the session cookie stays same-site. Local dev sets VITE_BACKEND_URL in .env
// because the two run on different ports. Note the `|| ""`: without it an unset variable
// interpolates as the literal string "undefined" and every call goes to /undefined/api.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";
export const API = `${BACKEND_URL}/api`;

export const http = axios.create({
  baseURL: API,
  withCredentials: true,
});

// What a status means to a person, for the failures that carry no `detail` of their own.
// Deliberately short: these land in a status line and in toasts, not in a log.
const STATUS_TEXT = {
  401: "Your session expired",
  403: "You do not have permission to do that",
  404: "That no longer exists",
  409: "Someone else changed this first",
  413: "That is too large to save",
  429: "Too many requests — wait a moment",
};

/**
 * The server's own words for a failure, derived in one place.
 *
 * Sixteen call sites were each unpacking `e.response.data.detail` by hand, every one of
 * them assuming it is a string. FastAPI sends a *list* of `{loc, msg}` for a 422, so
 * every one of those fell through to its generic fallback exactly when the specific
 * reason existed and was the thing worth reading.
 *
 * Never returns empty: a caller that shows this string always has something to show.
 */
export function errorText(err, fallback = "Something went wrong") {
  if (!err) return fallback;
  const res = err.response;
  // No response at all. Worth distinguishing: "the server said no" and "nothing
  // answered" are different problems and want different reactions from the reader.
  if (!res) {
    if (err.code === "ERR_CANCELED") return fallback;
    return "Could not reach the server";
  }
  const d = res.data?.detail;
  if (typeof d === "string" && d.trim()) return d;
  // FastAPI's validation shape. The field name is the half that locates the problem.
  if (Array.isArray(d) && d.length) {
    const first = d[0];
    const loc = Array.isArray(first?.loc) ? first.loc[first.loc.length - 1] : null;
    if (first?.msg) return loc ? `${loc}: ${first.msg}` : first.msg;
  }
  return STATUS_TEXT[res.status] || `${fallback} (HTTP ${res.status})`;
}

// The one endpoint that answers 401 in the ordinary course of business: the probe
// AuthProvider makes on every page load, for signed-in and anonymous visitors alike.
// Redirecting on that would send every first-time visitor straight to the login page.
const AUTH_PROBE = /^\/auth\/me\b/;

// A 401 usually arrives several times at once — the CMS alone has five independent
// savers — and one expired session is one redirect and one message, not five.
let signingIn = false;

// Whether navigating away right now would destroy something the person cannot get back.
// Default no: most screens hold nothing but what they fetched.
let unsavedWork = () => false;

/**
 * Tell the 401 handler that this screen is holding work that exists nowhere else.
 *
 * An expired session makes a write impossible, not urgent — the editor's draft is
 * already unsaveable, and the only thing still in the person's control is the text on
 * their screen. Navigating them to a login form takes even that. So a screen that stands
 * to lose something gets told, and chooses; a screen that does not is simply moved along.
 *
 * Returns its own undo, for the effect that installed it.
 */
export function setUnsavedWorkGuard(fn) {
  unsavedWork = typeof fn === "function" ? fn : () => false;
  return () => { if (unsavedWork === fn) unsavedWork = () => false; };
}

const atRisk = () => {
  try { return Boolean(unsavedWork()); } catch { return false; }
};

/**
 * One place that knows what an HTTP failure means.
 *
 * Before this, nothing in the frontend read a status code at all: `grep -rn 401 src`
 * returned nothing. Sessions expire after seven days with no sliding renewal, and when
 * one did, the app kept rendering the data it had already loaded while every write
 * failed — which the CMS reported as "Save failed — retrying", forever, with no way for
 * the person reading it to learn that they were simply signed out.
 *
 * Two jobs, deliberately no more:
 *
 *   `err.detail`  — the server's reason, attached to every rejection so a call site can
 *                   show it without re-deriving it. Attached rather than thrown as a new
 *                   Error, so `err.response` and the rest of the axios shape survive.
 *   401           — handled here, because no call site handles it.
 *
 * It does NOT toast every 4xx. Fifty-three call sites already toast their own failures
 * with wording that suits what they were doing; a blanket toast here would double every
 * one of them. The reason travels on the error instead, and the caller decides.
 */
http.interceptors.response.use(
  (res) => res,
  (err) => {
    err.detail = errorText(err);

    const status = err.response?.status;
    const url = err.config?.url || "";
    if (
      status === 401 &&
      !AUTH_PROBE.test(url) &&
      !signingIn &&
      typeof window !== "undefined" &&
      !window.location.pathname.startsWith("/login")
    ) {
      signingIn = true;
      const back = window.location.pathname + window.location.search;
      const signIn = () => window.location.assign(`/login?return=${encodeURIComponent(back)}`);

      if (atRisk()) {
        // Deliberately no automatic navigation. `beforeunload` is not the safety net it
        // looks like here — Chrome shows that dialog only for a navigation the browser
        // attributes to the person, and a redirect fired from a background request is
        // not one. Verified: the CMS with an unsaved title went straight to /login with
        // no prompt at all. So the choice is theirs, and the message does not time out.
        toast.error("Your session expired — this cannot be saved until you sign in again", {
          duration: Infinity,
          action: { label: "Sign in", onClick: signIn },
        });
      } else {
        toast.error("Your session expired — taking you to sign in");
        // A beat, so the message is read rather than glimpsed.
        window.setTimeout(signIn, 1200);
      }
    }
    return Promise.reject(err);
  },
);
