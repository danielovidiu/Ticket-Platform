/**
 * Which URLs this site will put in an iframe (audit M11).
 *
 * The rule under test is one-directional and worth stating plainly: an unrecognised URL
 * must produce `null`, never a passthrough. The old code returned the author's raw string
 * for anything it did not recognise, which is how an editor could frame a phishing page
 * under the real domain.
 */
import { resolveEmbed, withPlayback, EMBED_HOSTS, AUDIO_PROVIDERS } from "./embeds";

describe("URLs that must never be framed", () => {
  const hostile = [
    ["a plain third-party page", "https://evil.example/login"],
    ["a lookalike host", "https://youtube.com.evil.example/watch?v=abcdef"],
    ["youtube as a subdomain of something else", "https://www.youtube.com.attacker.net/embed/abcdef"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["file:", "file:///etc/passwd"],
    ["a bare host with no scheme", "youtube.com/watch?v=abcdef"],
    ["an open-redirect style query", "https://evil.example/?v=abcdefghijk"],
    ["empty", ""],
    ["not a string", null],
    ["vimeo-ish path on another host", "https://evil.example/vimeo.com/123456"],
  ];

  test.each(hostile)("%s is refused", (_label, url) => {
    expect(resolveEmbed(url)).toBeNull();
  });

  test("the old passthrough is gone", () => {
    // The precise regression: previously `src = props.url` for anything unrecognised.
    const url = "https://evil.example/login";
    expect(resolveEmbed(url)).toBeNull();
    expect(JSON.stringify(resolveEmbed(url) || {})).not.toContain("evil.example");
  });
});

describe("URLs an editor actually pastes", () => {
  const youtube = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&t=30s",
  ];

  test.each(youtube)("%s resolves to a canonical youtube embed", (url) => {
    expect(resolveEmbed(url)).toEqual({
      src: "https://www.youtube.com/embed/dQw4w9WgXcQ",
      provider: "youtube",
    });
  });

  test("a vimeo link resolves to the player", () => {
    expect(resolveEmbed("https://vimeo.com/123456789")).toEqual({
      src: "https://player.vimeo.com/video/123456789",
      provider: "vimeo",
    });
  });

  test("a vimeo channel link still finds the id", () => {
    expect(resolveEmbed("https://vimeo.com/channels/staffpicks/123456789").src)
      .toBe("https://player.vimeo.com/video/123456789");
  });

  test("an unlisted vimeo link keeps its hash, or it 404s", () => {
    expect(resolveEmbed("https://vimeo.com/123456789/a1b2c3d4e5").src)
      .toBe("https://player.vimeo.com/video/123456789?h=a1b2c3d4e5");
  });

  test("a player.vimeo link is idempotent", () => {
    expect(resolveEmbed("https://player.vimeo.com/video/123456789").src)
      .toBe("https://player.vimeo.com/video/123456789");
  });

  test("a youtube host with no video id is refused, not guessed", () => {
    expect(resolveEmbed("https://www.youtube.com/")).toBeNull();
    expect(resolveEmbed("https://www.youtube.com/watch?v=")).toBeNull();
    expect(resolveEmbed("https://vimeo.com/channels/staffpicks")).toBeNull();
  });
});

describe("the emitted host set", () => {
  test("every resolvable URL emits a host from EMBED_HOSTS", () => {
    const urls = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://vimeo.com/123456789",
      "https://player.vimeo.com/video/123456789",
    ];
    for (const u of urls) {
      const { src } = resolveEmbed(u);
      expect(EMBED_HOSTS).toContain(new URL(src).hostname);
    }
  });

  test("EMBED_HOSTS is the contract the CSP frame-src must match", () => {
    // Pinned so a change here is deliberate; the backend asserts it against the
    // deployed CSP in vercel.json and DEPLOY_VPS.md.
    expect([...EMBED_HOSTS].sort()).toEqual([
      "bandcamp.com", "player.vimeo.com", "w.soundcloud.com", "www.youtube.com",
    ]);
  });
});

describe("playback flags", () => {
  const yt = () => resolveEmbed("https://youtu.be/dQw4w9WgXcQ");
  const vim = () => resolveEmbed("https://vimeo.com/123456789");
  const params = (embed) => new URL(embed.src).searchParams;

  test("no flags leaves the canonical src untouched", () => {
    expect(withPlayback(yt(), {}).src).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(withPlayback(yt()).src).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
  });

  test("autoplay always carries mute — an unmuted autoplay is one a browser refuses", () => {
    expect(params(withPlayback(yt(), { autoplay: true })).get("mute")).toBe("1");
    expect(params(withPlayback(vim(), { autoplay: true })).get("muted")).toBe("1");
  });

  test("youtube loop names the video as its own playlist, or it plays once", () => {
    const p = params(withPlayback(yt(), { loop: true }));
    expect(p.get("loop")).toBe("1");
    expect(p.get("playlist")).toBe("dQw4w9WgXcQ");
  });

  test("vimeo loop needs no playlist", () => {
    const p = params(withPlayback(vim(), { loop: true }));
    expect(p.get("loop")).toBe("1");
    expect(p.get("playlist")).toBeNull();
  });

  test("an unlisted vimeo hash survives the added params", () => {
    const embed = resolveEmbed("https://vimeo.com/123456789/abc123");
    const p = params(withPlayback(embed, { autoplay: true }));
    expect(p.get("h")).toBe("abc123");
    expect(p.get("autoplay")).toBe("1");
  });

  test("the host is still one this site will frame, flags or not", () => {
    for (const embed of [yt(), vim()]) {
      const out = withPlayback(embed, { autoplay: true, loop: true });
      expect(EMBED_HOSTS).toContain(new URL(out.src).hostname);
    }
  });

  test("null in, null out — flags cannot resurrect a refused URL", () => {
    expect(withPlayback(resolveEmbed("https://evil.example/login"), { autoplay: true })).toBeNull();
  });
});

/**
 * SoundCloud and Bandcamp.
 *
 * SoundCloud is the one provider whose embed carries author input in the emitted string —
 * the player takes the track page as a `url` parameter. So the parameter is never a
 * passthrough: the path is validated segment by segment and a canonical soundcloud.com
 * URL is rebuilt from what survives. The frame host is `w.soundcloud.com` regardless,
 * which is what keeps M11 closed even if the parameter were wrong.
 */
describe("soundcloud", () => {
  const src = (u) => resolveEmbed(u)?.src;

  test("a track page becomes a player on the fixed host", () => {
    const e = resolveEmbed("https://soundcloud.com/artist/track-name");
    expect(e.provider).toBe("soundcloud");
    expect(new URL(e.src).hostname).toBe("w.soundcloud.com");
    expect(new URL(e.src).searchParams.get("url")).toBe("https://soundcloud.com/artist/track-name");
  });

  test("a playlist (three segments) works", () => {
    expect(src("https://soundcloud.com/artist/sets/a-playlist")).toContain("artist%2Fsets%2Fa-playlist");
  });

  test("an existing player URL is re-validated, not trusted", () => {
    const e = resolveEmbed(
      "https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack");
    expect(new URL(e.src).searchParams.get("url")).toBe("https://soundcloud.com/artist/track");
  });

  test("a player URL pointing somewhere else is refused", () => {
    // The attack this shape invites: our host in the address, someone else's in the param.
    expect(resolveEmbed(
      "https://w.soundcloud.com/player/?url=https%3A%2F%2Fevil.example%2Flogin")).toBeNull();
  });

  test("a bare profile is refused rather than framed empty", () => {
    expect(resolveEmbed("https://soundcloud.com/artist")).toBeNull();
  });

  test("path traversal and injected characters are refused", () => {
    expect(resolveEmbed("https://soundcloud.com/artist/../../evil")).toBeNull();
    expect(resolveEmbed("https://soundcloud.com/artist/track?x=1#y")).not.toBeNull();
    expect(src("https://soundcloud.com/artist/track?x=1#y")).not.toContain("x=1");
  });

  test("a lookalike host is not soundcloud", () => {
    expect(resolveEmbed("https://soundcloud.com.evil.example/a/b")).toBeNull();
  });
});

describe("bandcamp", () => {
  test("an embed URL keeps only its album reference", () => {
    const e = resolveEmbed("https://bandcamp.com/EmbeddedPlayer/album=123456/size=small/");
    expect(e.provider).toBe("bandcamp");
    expect(e.src).toBe(
      "https://bandcamp.com/EmbeddedPlayer/album=123456/size=large/bgcol=333333/"
      + "linkcol=ffffff/tracklist=false/transparent=true/");
  });

  test("a track reference works too", () => {
    expect(resolveEmbed("https://bandcamp.com/EmbeddedPlayer/track=99/").src).toContain("track=99");
  });

  test("an artist album page is refused — it carries no id to embed", () => {
    expect(resolveEmbed("https://artist.bandcamp.com/album/the-record")).toBeNull();
  });

  test("a non-numeric reference is refused", () => {
    expect(resolveEmbed("https://bandcamp.com/EmbeddedPlayer/album=abc/")).toBeNull();
  });

  test("a lookalike host is not bandcamp", () => {
    expect(resolveEmbed("https://bandcamp.com.evil.example/EmbeddedPlayer/album=1/")).toBeNull();
  });
});

describe("audio providers", () => {
  test("are exactly the two that play sound", () => {
    expect([...AUDIO_PROVIDERS].sort()).toEqual(["bandcamp", "soundcloud"]);
  });

  test("every audio provider emits a host the allowlist names", () => {
    for (const u of ["https://soundcloud.com/a/b", "https://bandcamp.com/EmbeddedPlayer/album=1/"]) {
      expect(EMBED_HOSTS).toContain(new URL(resolveEmbed(u).src).hostname);
    }
  });
});

/**
 * SoundCloud's own embed code.
 *
 * The Share/Embed dialog points its player at `api.soundcloud.com`, not at the page you
 * were looking at, and it writes the id as a URN — `soundcloud:playlists:123`, itself
 * percent-encoded inside an already-encoded query parameter. The first version of this
 * parser only accepted `soundcloud.com` in that parameter, so the exact string SoundCloud
 * hands an editor was refused while the undocumented page URL worked.
 *
 * The property being defended has not moved: the parameter is still never passed through.
 * Only the resource type and a numeric id survive, and the URN is rebuilt from them.
 */
describe("soundcloud embed-code URLs", () => {
  const REAL = "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/playlists/"
    + "soundcloud%253Aplaylists%253A1084330825&color=%23ff5500&auto_play=false"
    + "&hide_related=false&show_comments=true&show_user=true&show_reposts=false"
    + "&show_teaser=true&visual=true";

  const param = (u) => decodeURIComponent(new URL(resolveEmbed(u).src).searchParams.get("url"));

  test("the string SoundCloud actually gives you resolves", () => {
    const e = resolveEmbed(REAL);
    expect(e).not.toBeNull();
    expect(new URL(e.src).hostname).toBe("w.soundcloud.com");
    expect(param(REAL)).toBe("https://api.soundcloud.com/playlists/soundcloud:playlists:1084330825");
  });

  test("their player options do not survive — only ours are emitted", () => {
    // color, auto_play, show_comments etc. are the author's string; we set our own.
    const q = new URL(resolveEmbed(REAL).src).searchParams;
    expect(q.get("color")).toBeNull();
    expect(q.get("auto_play")).toBeNull();
    expect([...q.keys()].sort()).toEqual(["show_comments", "url", "visual"]);
  });

  test("a bare api URL works in both id forms", () => {
    expect(param("https://api.soundcloud.com/playlists/1084330825"))
      .toBe("https://api.soundcloud.com/playlists/1084330825");
    expect(param("https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A55"))
      .toBe("https://api.soundcloud.com/tracks/soundcloud:tracks:55");
  });

  test("a URN naming a different resource than its path is refused", () => {
    expect(resolveEmbed("https://api.soundcloud.com/playlists/soundcloud%3Atracks%3A5")).toBeNull();
  });

  test("anything that is not a playlist or a track is refused", () => {
    expect(resolveEmbed("https://api.soundcloud.com/users/123")).toBeNull();
    expect(resolveEmbed("https://api.soundcloud.com/playlists")).toBeNull();
    expect(resolveEmbed("https://api.soundcloud.com/playlists/../../evil")).toBeNull();
    expect(resolveEmbed("https://api.soundcloud.com/playlists/abc")).toBeNull();
  });

  test("a lookalike api host is still not soundcloud", () => {
    expect(resolveEmbed("https://api.soundcloud.com.evil.example/playlists/1")).toBeNull();
  });
});

describe("track vs playlist", () => {
  const kind = (u) => resolveEmbed(u)?.kind;

  test("a set is a playlist, a track is a track", () => {
    expect(kind("https://soundcloud.com/artist/sets/a-playlist")).toBe("playlist");
    expect(kind("https://soundcloud.com/artist/a-track")).toBe("track");
  });

  test("the api form is classified from its resource type", () => {
    expect(kind("https://api.soundcloud.com/playlists/1")).toBe("playlist");
    expect(kind("https://api.soundcloud.com/tracks/1")).toBe("track");
  });

  test("bandcamp says which it is too", () => {
    expect(kind("https://bandcamp.com/EmbeddedPlayer/album=1/")).toBe("playlist");
    expect(kind("https://bandcamp.com/EmbeddedPlayer/track=1/")).toBe("track");
  });

  test("a three-segment path that is not a set is refused", () => {
    // soundcloud.com/artist/sets/x is a playlist; anything else three deep is not a page
    // the player can render.
    expect(resolveEmbed("https://soundcloud.com/artist/notsets/x")).toBeNull();
  });
});
