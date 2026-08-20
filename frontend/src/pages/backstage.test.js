import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prefetchBackstage } from "./backstage";

/* The three staff pages are mocked so this file does not pull 150 KB of admin UI into
 * jsdom to answer a question about routing. The factories push their own name, which
 * makes "was this chunk fetched?" observable — that IS the behaviour under test, since
 * prefetchBackstage's only effect is which dynamic imports it starts. */
const imported = vi.hoisted(() => []);
vi.mock("./Admin", () => { imported.push("Admin"); return { default: () => null }; });
vi.mock("./CMSEditor", () => { imported.push("CMSEditor"); return { default: () => null }; });
vi.mock("./Scan", () => { imported.push("Scan"); return { default: () => null }; });

/** prefetchBackstage defers to idle time. Run the callback immediately instead, so the
 * test does not depend on when jsdom feels idle. */
beforeEach(() => { globalThis.requestIdleCallback = (cb) => { cb(); }; });
afterEach(() => { delete globalThis.requestIdleCallback; });

/** An import resolves from the module registry the second time, so a factory runs at
 * most once per file however many times its module is requested. Each test below
 * therefore asserts on what its own call ADDED, and the order of the tests is load
 * bearing: the visitor cases have to run while nothing has been imported yet. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("prefetchBackstage", () => {
  it("fetches nothing for a visitor who is not signed in", async () => {
    prefetchBackstage(undefined);
    await settle();
    expect(imported).toEqual([]);
  });

  it("fetches nothing for a signed-in customer", async () => {
    // The role every ticket buyer has. This is the case the whole split exists for:
    // shipping Admin and the CMS editor to these people was the original problem.
    prefetchBackstage("user");
    await settle();
    expect(imported).toEqual([]);
  });

  it("fetches only Scan for door staff", async () => {
    prefetchBackstage("door");
    await settle();
    // Not Admin and not CMSEditor: a door user cannot open either, and the phone at the
    // gate is the worst connection this app runs on.
    expect(imported).toEqual(["Scan"]);
  });

  it("fetches the editor's page for an editor", async () => {
    prefetchBackstage("editor");
    await settle();
    expect(imported).toContain("CMSEditor");
    expect(imported).not.toContain("Admin");
  });

  it("fetches all three for an admin", async () => {
    prefetchBackstage("admin");
    await settle();
    expect(imported).toEqual(expect.arrayContaining(["Admin", "CMSEditor", "Scan"]));
  });

  it("falls back to a timer where requestIdleCallback is missing", async () => {
    // Safari only shipped requestIdleCallback in 16.4, and this app is opened on phones.
    delete globalThis.requestIdleCallback;
    vi.useFakeTimers();
    let ok = true;
    try { prefetchBackstage("admin"); vi.advanceTimersByTime(1000); }
    catch { ok = false; }
    finally { vi.useRealTimers(); }
    expect(ok).toBe(true);
  });
});
