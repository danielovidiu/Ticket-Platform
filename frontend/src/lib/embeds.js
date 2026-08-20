/**
 * Which third-party pages this site is willing to put in an iframe (audit M11).
 *
 * The video block used to rewrite recognised YouTube/Vimeo links and then **fall through
 * to the author's raw URL** for anything else, rendering it in an iframe with no origin
 * allowlist and no sandbox. React neutralises `javascript:` there, so it was never script
 * execution — it was framing abuse: an editor, deliberately a lower-privileged role than
 * admin, could put any page on the internet inside a real Supersanity URL. A login form
 * served from an attacker's host, under this domain, in the address bar.
 *
 * Two properties matter here, and they are different:
 *
 *   1. The **output** host is always one of `EMBED_HOSTS` — never the author's string.
 *      An unrecognised URL yields `null`, not a passthrough. That is the fix.
 *   2. The **input** may be any of the shapes a person actually pastes (a watch link, a
 *      share link, a channel link), because the alternative is an editor who cannot
 *      embed a video and reaches for the custom-HTML block instead.
 *
 * `EMBED_HOSTS` must stay in step with `frame-src` in the deployed CSP (vercel.json and
 * the nginx block in DEPLOY_VPS.md). A host added here but not there produces an embed
 * that works locally and is blocked in production; a host in the CSP but not here is a
 * wider frame policy than the code needs. `test_embed_allowlist.py` asserts both.
 */

// Every host this module can EMIT. Not the hosts it accepts as input.
export const EMBED_HOSTS = ["www.youtube.com", "player.vimeo.com"];

const YOUTUBE_INPUT_HOSTS = new Set([
  "youtube.com", "m.youtube.com", "youtube-nocookie.com", "youtu.be",
]);
const VIMEO_INPUT_HOSTS = new Set(["vimeo.com", "player.vimeo.com"]);

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;
const VIMEO_ID = /^\d+$/;
const VIMEO_HASH = /^[A-Za-z0-9]{6,20}$/;

function segments(pathname) {
  return pathname.split("/").filter(Boolean);
}

/**
 * Playback options onto a src this module itself produced.
 *
 * Deliberately separate from `resolveEmbed`: the allowlist property is that the host
 * comes from `EMBED_HOSTS` and never from the author. Parsing our own output and only
 * touching its query string keeps that true — nothing an author types can reach the
 * origin, only the boolean flags below.
 *
 * `autoplay` implies muted, because every current browser refuses to start an unmuted
 * video on its own. Sending autoplay=1 without mute=1 produces a player that silently
 * does nothing, which reads as a broken block rather than as a browser policy.
 */
export function withPlayback(embed, { autoplay = false, loop = false } = {}) {
  if (!embed) return embed;
  if (!autoplay && !loop) return embed;

  const url = new URL(embed.src);
  const id = url.pathname.split("/").filter(Boolean).pop();

  if (embed.provider === "youtube") {
    if (autoplay) { url.searchParams.set("autoplay", "1"); url.searchParams.set("mute", "1"); }
    // YouTube ignores loop=1 on a single video unless that video is also named as a
    // one-item playlist. Without this the video plays once and stops.
    if (loop) { url.searchParams.set("loop", "1"); url.searchParams.set("playlist", id); }
    url.searchParams.set("playsinline", "1");
  } else {
    if (autoplay) { url.searchParams.set("autoplay", "1"); url.searchParams.set("muted", "1"); }
    if (loop) url.searchParams.set("loop", "1");
  }

  return { ...embed, src: url.toString() };
}

/**
 * Resolve an author-supplied URL to a canonical embed source.
 * Returns `{ src, provider }`, or `null` when it is not an embed this site will frame.
 */
export function resolveEmbed(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null; // not a URL at all — including bare "youtube.com/watch?v=x"
  }
  // Anything that is not http(s) is refused outright: javascript:, data:, file:.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = segments(url.pathname);

  if (YOUTUBE_INPUT_HOSTS.has(host)) {
    let id = "";
    if (host === "youtu.be") id = parts[0] || "";
    else if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") id = parts[1] || "";
    else id = url.searchParams.get("v") || "";
    if (!YOUTUBE_ID.test(id)) return null;
    return { src: `https://www.youtube.com/embed/${id}`, provider: "youtube" };
  }

  if (VIMEO_INPUT_HOSTS.has(host)) {
    // vimeo.com/123, vimeo.com/channels/staffpicks/123, player.vimeo.com/video/123.
    // The id is the first all-digits segment; an unlisted video carries a hash after it.
    const at = parts.findIndex((p) => VIMEO_ID.test(p));
    if (at === -1) return null;
    const id = parts[at];
    const hash = parts[at + 1];
    const query = hash && VIMEO_HASH.test(hash) ? `?h=${hash}` : "";
    return { src: `https://player.vimeo.com/video/${id}${query}`, provider: "vimeo" };
  }

  return null;
}
