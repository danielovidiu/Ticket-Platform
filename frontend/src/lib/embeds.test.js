/**
 * Which URLs this site will put in an iframe (audit M11).
 *
 * The rule under test is one-directional and worth stating plainly: an unrecognised URL
 * must produce `null`, never a passthrough. The old code returned the author's raw string
 * for anything it did not recognise, which is how an editor could frame a phishing page
 * under the real domain.
 */
import { resolveEmbed, withPlayback, EMBED_HOSTS } from "./embeds";

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
    expect([...EMBED_HOSTS].sort()).toEqual(["player.vimeo.com", "www.youtube.com"]);
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
