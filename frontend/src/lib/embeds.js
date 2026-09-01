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
export const EMBED_HOSTS = [
  "www.youtube.com", "player.vimeo.com", "w.soundcloud.com", "bandcamp.com",
];

/** Providers that play sound, not video. They are a fixed-height strip rather than a
 *  rectangle, so the block sizes them by height instead of by aspect ratio. */
export const AUDIO_PROVIDERS = new Set(["soundcloud", "bandcamp"]);

const YOUTUBE_INPUT_HOSTS = new Set([
  "youtube.com", "m.youtube.com", "youtube-nocookie.com", "youtu.be",
]);
const VIMEO_INPUT_HOSTS = new Set(["vimeo.com", "player.vimeo.com"]);
const SOUNDCLOUD_INPUT_HOSTS = new Set([
  "soundcloud.com", "m.soundcloud.com", "on.soundcloud.com", "w.soundcloud.com",
]);

// A SoundCloud path segment: what appears in soundcloud.com/<artist>/<track>. Anything
// with a slash, a dot or an escape in it is not one, which is the point — these segments
// are what gets rebuilt into the `url` parameter below.
const SOUNDCLOUD_SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;
// Bandcamp's embed URL names its content numerically: EmbeddedPlayer/album=123/...
const BANDCAMP_REF = /^(album|track)=(\d{1,20})$/;

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

  if (SOUNDCLOUD_INPUT_HOSTS.has(host)) {
    // The player takes the public track/playlist page as a query parameter. That is the
    // one place in this module where author input reaches the emitted string, so it is
    // NOT passed through: the path is validated segment by segment and a canonical
    // soundcloud.com URL is rebuilt from the parts that survived. The frame host stays
    // w.soundcloud.com either way, so even a malformed parameter cannot change what is
    // framed — only what SoundCloud shows inside it.
    let path = parts;
    if (host === "w.soundcloud.com") {
      // Already an embed URL: take the url= parameter and re-validate it as input.
      const inner = url.searchParams.get("url");
      if (!inner) return null;
      let innerUrl;
      try { innerUrl = new URL(inner); } catch { return null; }
      if (innerUrl.hostname.toLowerCase().replace(/^www\./, "") !== "soundcloud.com") return null;
      path = segments(innerUrl.pathname);
    }
    // artist/track, or artist/sets/playlist. One segment is a bare profile, which the
    // player renders as an empty box, so it is refused rather than framed.
    if (path.length < 2 || path.length > 3) return null;
    if (!path.every((seg) => SOUNDCLOUD_SEGMENT.test(seg))) return null;

    const target = `https://soundcloud.com/${path.join("/")}`;
    const src = new URL("https://w.soundcloud.com/player/");
    src.searchParams.set("url", target);
    src.searchParams.set("visual", "false");
    src.searchParams.set("show_comments", "false");
    return { src: src.toString(), provider: "soundcloud" };
  }

  if (host === "bandcamp.com" || host.endsWith(".bandcamp.com")) {
    // Bandcamp's public album URL does not carry the numeric id its player needs, and
    // deriving one would mean fetching the page server-side. So the input is the URL from
    // Bandcamp's own Share/Embed dialog, and only its album=/track= reference is kept.
    if (parts[0] !== "EmbeddedPlayer") return null;
    const ref = parts.slice(1).map((seg) => seg.match(BANDCAMP_REF)).find(Boolean);
    if (!ref) return null;
    const [, kind, id] = ref;
    return {
      src: `https://bandcamp.com/EmbeddedPlayer/${kind}=${id}/size=large/bgcol=333333/`
         + "linkcol=ffffff/tracklist=false/transparent=true/",
      provider: "bandcamp",
    };
  }

  return null;
}
