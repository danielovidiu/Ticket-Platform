/**
 * The CMS-wide save policy.
 *
 * The thing this exists to prevent: five editable surfaces, five different opinions
 * about when to write. The site settings pane held the worst of them — it issued a PUT
 * per character typed — not by decision but by being the one surface that never got the
 * debounce the others had. So the answer is one preference and one register, and the
 * tests below are about the two properties that make that hold.
 */
import { renderHook, act } from "@testing-library/react";
import {
  AUTOSAVE_INTERVAL_MS, anySaverDirty, flushAllSavers, isAutosaveEnabled,
  setAutosaveEnabled, useAutosaveEnabled, useRegisteredSaver,
} from "./autosavePolicy";

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* ignore */ }
  setAutosaveEnabled(false);
});

describe("the preference", () => {
  test("is off until somebody turns it on", () => {
    // The default matters more than it looks: on means every editor everywhere is
    // writing to the database while they think.
    expect(isAutosaveEnabled()).toBe(false);
  });

  test("survives a reload", () => {
    setAutosaveEnabled(true);
    expect(window.localStorage.getItem("supersanity.cms.autosave")).toBe("on");
  });

  test("subscribers are told when it changes", () => {
    const { result } = renderHook(() => useAutosaveEnabled());
    expect(result.current).toBe(false);
    act(() => setAutosaveEnabled(true));
    expect(result.current).toBe(true);
    act(() => setAutosaveEnabled(false));
    expect(result.current).toBe(false);
  });

  test("the interval is long enough to be an interval", () => {
    // A "limit database usage" setting that fires every second would not.
    expect(AUTOSAVE_INTERVAL_MS).toBeGreaterThanOrEqual(5000);
  });
});

describe("the register", () => {
  test("a mounted surface is asked; an unmounted one is not", async () => {
    const flush = vi.fn();
    const { unmount } = renderHook(() =>
      useRegisteredSaver({ flush, isDirty: () => true }, "dirty"));

    expect(anySaverDirty()).toBe(true);
    await act(async () => { await flushAllSavers(); });
    expect(flush).toHaveBeenCalledTimes(1);

    unmount();
    expect(anySaverDirty()).toBe(false);
    await act(async () => { await flushAllSavers(); });
    expect(flush).toHaveBeenCalledTimes(1); // not asked again
  });

  test("one Save reaches every surface at once", async () => {
    const a = vi.fn(), b = vi.fn();
    renderHook(() => useRegisteredSaver({ flush: a, isDirty: () => true }, "x"));
    renderHook(() => useRegisteredSaver({ flush: b, isDirty: () => false }, "y"));

    await act(async () => { await flushAllSavers(); });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  test("a clean editor has nothing outstanding", () => {
    renderHook(() => useRegisteredSaver({ flush: vi.fn(), isDirty: () => false }, "clean"));
    expect(anySaverDirty()).toBe(false);
  });

  test("one surface throwing does not stop the others being saved", async () => {
    // Save now must not become a coin toss because one pane is unhappy.
    const good = vi.fn();
    renderHook(() => useRegisteredSaver({ flush: () => { throw new Error("nope"); }, isDirty: () => true }, "bad"));
    renderHook(() => useRegisteredSaver({ flush: good, isDirty: () => true }, "good"));

    await act(async () => { await flushAllSavers(); });
    expect(good).toHaveBeenCalled();
  });

  test("a surface reporting dirtiness badly is treated as clean, not as a crash", () => {
    renderHook(() => useRegisteredSaver({ flush: vi.fn(), isDirty: () => { throw new Error("nope"); } }, "bad"));
    expect(() => anySaverDirty()).not.toThrow();
    expect(anySaverDirty()).toBe(false);
  });
});
