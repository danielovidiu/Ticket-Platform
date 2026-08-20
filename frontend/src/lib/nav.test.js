/**
 * The nav cache.
 *
 * It exists to put the real menu in the first paint for a returning visitor, instead of
 * showing the built-in sections and letting the authored pages appear a request later.
 *
 * What it reads came out of localStorage, which anything running on this origin can
 * write, and it is rendered straight into the header as links — so the shape check is
 * not defensive tidiness, it is the reason a corrupt or hostile entry cannot become a
 * navigation bar.
 */
import { readCachedNav } from "./nav";

const KEY = "cms:nav:v1";
const put = (value) => localStorage.setItem(KEY, typeof value === "string" ? value : JSON.stringify(value));

beforeEach(() => localStorage.clear());

describe("what is accepted", () => {
  test("a well-formed nav is returned as-is", () => {
    const nav = [
      { slug: "home", label: "Events", route: "/", kind: "page" },
      { slug: "mission", label: "Mission", route: "/p/mission", kind: "page" },
    ];
    put(nav);
    expect(readCachedNav()).toEqual(nav);
  });

  test("nothing cached yet means no cached nav", () => {
    expect(readCachedNav()).toEqual([]);
  });
});

describe("what is refused", () => {
  test.each([
    ["corrupt json", "{not json"],
    ["not an array", { label: "Events", route: "/" }],
    ["an item with no route", [{ label: "Events" }]],
    ["an item with no label", [{ route: "/events" }]],
    ["a null item", [null]],
    ["a route that is not a path", [{ label: "Events", route: "https://evil.example/x" }]],
    ["a javascript: route", [{ label: "Click", route: "javascript:alert(1)" }]],
    ["a protocol-relative route", [{ label: "Click", route: "//evil.example/x" }]],
  ])("%s falls back to empty rather than rendering", (_label, value) => {
    put(value);
    // Empty means the header shows its built-in fallback — the pre-existing behaviour,
    // which is the right floor to fail to.
    expect(readCachedNav()).toEqual([]);
  });

  test("one bad entry discards the whole list", () => {
    // Not filtered down to the good ones: a menu missing an item it should have is a
    // worse answer than the fallback, because it looks correct.
    put([{ label: "Events", route: "/events" }, { label: "Bad", route: "javascript:alert(1)" }]);
    expect(readCachedNav()).toEqual([]);
  });
});
