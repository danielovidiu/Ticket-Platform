/**
 * `mediaUrlProblem` — the explanation the Content-Security-Policy does not give.
 *
 * It is NOT a control. The browser's `img-src` refuses these URLs whatever this function
 * says, and nothing here can loosen that. What it exists for is telling an editor before
 * they save, rather than letting them paste a URL, see an empty box on the live page, and
 * have nothing to go on.
 *
 * The host list is kept in step with the deployed CSP by
 * backend/tests/test_media_allowlist.py, so these cases assert the SHAPE of the check
 * rather than restating the list.
 */
import { mediaUrl, mediaUrlProblem, MEDIA_HOSTS } from "./media";

describe("URLs that are fine", () => {
  test("nothing at all is not a problem to report", () => {
    expect(mediaUrlProblem("")).toBeNull();
    expect(mediaUrlProblem(null)).toBeNull();
    expect(mediaUrlProblem(undefined)).toBeNull();
    expect(mediaUrlProblem("   ")).toBeNull();
  });

  test("an uploaded path is served from this origin", () => {
    // `img-src 'self'` covers every relative path, which is what every upload becomes.
    expect(mediaUrlProblem("/uploads/abc123.webp")).toBeNull();
    expect(mediaUrlProblem("uploads/abc123.webp")).toBeNull();
  });

  test("an allowed host passes", () => {
    expect(mediaUrlProblem("https://images.unsplash.com/photo-123?w=800")).toBeNull();
    expect(mediaUrlProblem("https://vuqywng0h3jewybf.public.blob.vercel-storage.com/uploads/x.jpg"))
      .toBeNull();
  });

  test("a bare wildcard host matches without a subdomain too", () => {
    // ".blob.vercel-storage.com" has to accept the apex, not only "sub.blob…".
    expect(mediaUrlProblem("https://blob.vercel-storage.com/x.jpg")).toBeNull();
  });
});

describe("URLs that will not display", () => {
  test("http is called out on its own, because the fix is one character", () => {
    const problem = mediaUrlProblem("http://images.unsplash.com/photo-123");
    expect(problem).toMatch(/https/i);
  });

  test("a host nobody allows is named in the message", () => {
    const problem = mediaUrlProblem("https://example.com/cat.jpg");
    expect(problem).toContain("example.com");
    expect(problem).toMatch(/upload/i);
  });

  test("a lookalike host does not slip through on a suffix match", () => {
    // "notunsplash.com" ends with nothing in the list, but a careless `endsWith`
    // on a non-dotted entry would have matched "evilimages.unsplash.com.attacker.tld".
    expect(mediaUrlProblem("https://images.unsplash.com.attacker.example/x.jpg")).not.toBeNull();
    expect(mediaUrlProblem("https://notimages.unsplash.com/x.jpg")).not.toBeNull();
    expect(mediaUrlProblem("https://blob.vercel-storage.com.attacker.example/x.jpg")).not.toBeNull();
  });

  test("the host check ignores case", () => {
    expect(mediaUrlProblem("https://IMAGES.UNSPLASH.COM/photo-1")).toBeNull();
  });

  test("a non-http scheme is refused", () => {
    for (const url of ["data:image/png;base64,AAAA", "ftp://host/x.png", "file:///etc/passwd"]) {
      expect(mediaUrlProblem(url)).not.toBeNull();
    }
  });

  test("something that is not a URL at all says so", () => {
    expect(mediaUrlProblem("https://")).toMatch(/not a URL/i);
  });

  test("a protocol-relative URL is not treated as a local path", () => {
    // "//evil.example/x.jpg" starts with a slash and is NOT same-origin.
    expect(mediaUrlProblem("//evil.example/x.jpg")).not.toBeNull();
  });
});

describe("MEDIA_HOSTS", () => {
  test("is a non-empty list of strings", () => {
    expect(Array.isArray(MEDIA_HOSTS)).toBe(true);
    expect(MEDIA_HOSTS.length).toBeGreaterThan(0);
    for (const h of MEDIA_HOSTS) expect(typeof h).toBe("string");
  });
});

describe("mediaUrl is unchanged by any of this", () => {
  test("an absolute URL is passed through untouched", () => {
    expect(mediaUrl("https://example.com/x.jpg")).toBe("https://example.com/x.jpg");
    expect(mediaUrl("http://example.com/x.jpg")).toBe("http://example.com/x.jpg");
  });

  test("a relative path is resolved against the backend origin", () => {
    // Empty in the deployed shape, where /api is same-origin; the dev server sets
    // VITE_BACKEND_URL because the two run on different ports. Asserted against the
    // configured value rather than a literal, so this passes either way.
    const base = import.meta.env.VITE_BACKEND_URL || "";
    expect(mediaUrl("/uploads/x.jpg")).toBe(`${base}/uploads/x.jpg`);
  });

  test("nothing in, nothing out", () => {
    expect(mediaUrl("")).toBe("");
    expect(mediaUrl(null)).toBeNull();
  });
});
