/**
 * The save policy. Each property here exists because its absence was a bug in the CMS.
 *
 * The block draft got this right inline; page metadata and the theme never did — they
 * wrote on every change, unordered, and could not report a failure. This is the shared
 * version, so those two now behave like the one that worked.
 *
 * WHEN it writes is no longer this hook's decision: autosave is one preference for the
 * whole CMS and it is OFF by default. The suites below that exercise writing therefore
 * turn it on — they are about what the hook does once it has been asked to save. What it
 * does when it has NOT been asked has a suite of its own at the bottom.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { setAutosaveEnabled } from "./autosavePolicy";
import { useAutosave } from "./useAutosave";

const flushTimers = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => setAutosaveEnabled(true));
afterEach(() => setAutosaveEnabled(false));

describe("the interval", () => {
  test("a burst of edits is one request, not one per edit", async () => {
    const save = vi.fn().mockResolvedValue();
    let value = 0;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );

    for (let i = 1; i <= 10; i++) { value = i; act(() => result.current.bump()); }
    await flushTimers(120);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(10);
  });

  test("steady typing still gets written, rather than waiting for a pause that never comes", async () => {
    // A plain debounce resets on every keystroke, so someone typing continuously had
    // nothing persisted at all. The ceiling is what makes this terminate.
    const save = vi.fn().mockResolvedValue();
    let value = 0;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );

    for (let i = 1; i <= 6; i++) {
      value = i;
      act(() => result.current.bump());
      await flushTimers(25);
    }
    await waitFor(() => expect(save).toHaveBeenCalled());
  });

  test("the value written is the newest one, not the one current when the timer armed", async () => {
    const save = vi.fn().mockResolvedValue();
    let value = "first";
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );
    act(() => result.current.bump());
    value = "latest";
    await flushTimers(80);
    expect(save).toHaveBeenCalledWith("latest");
  });
});

describe("ordering", () => {
  test("two saves never overlap, so a slow one cannot land after a newer one", async () => {
    let inFlight = 0;
    let overlapped = false;
    const save = vi.fn(async () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
    });

    let value = 0;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );

    value = 1; act(() => result.current.bump());
    await flushTimers(10);
    value = 2; act(() => result.current.bump());
    await flushTimers(10);
    value = 3; act(() => result.current.bump());

    // waitFor rather than one long sleep. Settling this takes two round trips — the
    // first save goes out mid-run and the second is armed only once it returns — and a
    // single long `act` does not let React process the state change in between, so the
    // second never gets scheduled inside it. Polling gives the effects room to run.
    await waitFor(() => expect(result.current.dirty).toBe(false), { timeout: 2000 });

    expect(overlapped).toBe(false);
    // The last value must be what the server ends up holding.
    expect(save.mock.calls[save.mock.calls.length - 1][0]).toBe(3);
  });

  test("an edit made while a save is in flight is not lost", async () => {
    const save = vi.fn(async () => { await new Promise((r) => setTimeout(r, 50)); });
    let value = "a";
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );

    act(() => result.current.bump());
    await flushTimers(15);          // first save now in flight
    value = "b";
    act(() => result.current.bump()); // lands mid-request
    // waitFor, not a fixed 200ms: the queued re-run is two 20ms intervals and a 50ms
    // request away, which is comfortable on an idle machine and not on a loaded one.
    // This failed roughly one full-suite run in four while the rest of the suite was
    // competing for the same event loop — a flake in the clock, not in the hook.
    await waitFor(() => expect(save).toHaveBeenCalledWith("b"), { timeout: 2000 });
  });
});

describe("honest state", () => {
  test("a failure is reported rather than swallowed", async () => {
    // The worst outcome available is an editor being told "Saved" while their work
    // exists only in this tab.
    const save = vi.fn().mockRejectedValue(new Error("network"));
    let value = 1;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );
    act(() => result.current.bump());
    await waitFor(() => expect(result.current.state).toBe("error"));
    // Still dirty, so the next edit retries it.
    expect(result.current.dirty).toBe(true);
  });

  test("a failure carries the server's reason, not just the fact of it", async () => {
    // "Save failed" alone sent someone to the network tab to learn that they had simply
    // been signed out. The reason belongs where the failure is reported.
    const save = vi.fn().mockRejectedValue({
      isAxiosError: true, config: { url: "/admin/cms/pages/p1" },
      response: { status: 413, data: { detail: "This page is 300 KB; the limit is 256 KB" } },
    });
    let value = 1;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );
    act(() => result.current.bump());
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.error).toBe("This page is 300 KB; the limit is 256 KB");
  });

  test("the reason does not outlive the failure", async () => {
    // Rejecting persistently rather than once: a left-dirty save retries on its own
    // every interval, so a single rejection is cleared again before it can be observed.
    const save = vi.fn().mockRejectedValue(
      { isAxiosError: true, config: {}, response: { status: 403, data: {} } });
    let value = 1;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );
    act(() => result.current.bump());
    await waitFor(() => expect(result.current.error).toBe("You do not have permission to do that"));

    save.mockResolvedValue();
    value = 2;
    act(() => result.current.bump());
    await waitFor(() => expect(result.current.state).toBe("saved"));
    expect(result.current.error).toBe(null);
  });

  test("success clears the pending flag", async () => {
    const save = vi.fn().mockResolvedValue();
    let value = 1;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );
    act(() => result.current.bump());
    await waitFor(() => expect(result.current.state).toBe("saved"));
    expect(result.current.dirty).toBe(false);
  });

  test("nothing is written when nothing changed", async () => {
    const save = vi.fn().mockResolvedValue();
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => "same", save, intervalMs: 20 })
    );
    act(() => result.current.bump());
    await flushTimers(60);
    expect(save).toHaveBeenCalledTimes(1);

    act(() => result.current.bump());   // same value again
    await flushTimers(60);
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("flush writes immediately, for leaving the page", async () => {
    const save = vi.fn().mockResolvedValue();
    let value = "x";
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 20 })
    );
    act(() => result.current.bump());
    await act(async () => { await result.current.flush(); });
    expect(save).toHaveBeenCalledWith("x");
  });
});

describe("with autosave off", () => {
  // The default, and the thing the site settings needed most: an editor typing is not a
  // stream of writes. Nothing is scheduled at all until a person asks.
  beforeEach(() => setAutosaveEnabled(false));

  test("editing writes nothing, however long you wait", async () => {
    const save = vi.fn().mockResolvedValue();
    let value = 0;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 10 })
    );
    for (let i = 1; i <= 5; i++) { value = i; act(() => result.current.bump()); }
    await flushTimers(80);
    expect(save).not.toHaveBeenCalled();
  });

  test("but the work is marked unsaved, so nothing is lost silently", async () => {
    const save = vi.fn().mockResolvedValue();
    let value = 0;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 10 })
    );
    value = 1; act(() => result.current.bump());
    await flushTimers(40);
    expect(result.current.dirty).toBe(true);
  });

  test("an explicit flush still writes — that is what Save now calls", async () => {
    const save = vi.fn().mockResolvedValue();
    let value = 0;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 10 })
    );
    value = 7; act(() => result.current.bump());
    await act(async () => { await result.current.flush(); });
    expect(save).toHaveBeenCalledWith(7);
  });
});

describe("the interval is an interval, not a debounce", () => {
  beforeEach(() => setAutosaveEnabled(true));

  test("steady typing is written on the beat rather than waiting for a pause", async () => {
    // The failure this rules out: re-arming on every edit means someone typing
    // continuously pushes the deadline ahead of themselves and nothing is ever written.
    const save = vi.fn().mockResolvedValue();
    let value = 0;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, intervalMs: 50 })
    );
    // Edit every 10ms for longer than the interval, never pausing.
    for (let i = 1; i <= 10; i++) {
      value = i;
      act(() => result.current.bump());
      await flushTimers(10);
    }
    // Written DURING the run, which is the property under test: a debounce that re-armed
    // on every edit would still have nothing on the server at this point.
    expect(save).toHaveBeenCalled();

    // Then settle before asking what the server ended up holding. Waiting only for the
    // first call raced the rest: the last edits are carried by a later interval, so the
    // assertion below saw whichever value the FIRST save happened to catch — 7 on one
    // machine, 10 on another. Dirty going false is the honest "nothing left to write".
    await waitFor(() => expect(result.current.dirty).toBe(false), { timeout: 2000 });
    expect(save.mock.calls[save.mock.calls.length - 1][0]).toBe(value);
  });
});

describe("nothing pending means nothing is written", () => {
  /* THE BUG THIS SUITE EXISTS FOR.
   *
   * "Save now" calls flushAllSavers(), which flushes EVERY registered surface — there is
   * no dirty filter, and there should not be: a surface that failed its last save is not
   * dirty by its own reckoning and still needs writing.
   *
   * So a surface nobody has touched gets flushed too, and it answers `getPending()` with
   * whatever its ref was initialised to. CMSEditor's page-metadata saver initialises that
   * ref to `null`, and the guard here only tested for `undefined` — so an untouched
   * metadata pane PATCHed the page with a body of `null`. axios sends no body at all for
   * that, and FastAPI answers 422 with `loc: ["body"], msg: "Field required"`, which the
   * editor showed as:
   *
   *     Save failed — body: Field required
   *
   * after editing a BLOCK and pressing Save now, which is not a sentence about anything
   * the person had touched.
   */

  test("a pending value of undefined is not written", async () => {
    const save = vi.fn().mockResolvedValue();
    const { result } = renderHook(() => useAutosave({ getPending: () => undefined, save }));
    await act(async () => { await result.current.flush(); });
    expect(save).not.toHaveBeenCalled();
  });

  test("a pending value of NULL is not written either", async () => {
    // The regression. `null` is what "this surface has nothing yet" looks like when the
    // caller initialised its ref with useRef(null) rather than useRef(undefined).
    const save = vi.fn().mockResolvedValue();
    const { result } = renderHook(() => useAutosave({ getPending: () => null, save }));
    await act(async () => { await result.current.flush(); });
    expect(save).not.toHaveBeenCalled();
  });

  test("an untouched surface stays idle rather than reporting an error", async () => {
    // The visible half: before the fix this went to "error" with the server's 422 in it.
    const save = vi.fn().mockResolvedValue();
    const { result } = renderHook(() => useAutosave({ getPending: () => null, save }));
    await act(async () => { await result.current.flush(); });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  test("but a real value is still written after an untouched flush", async () => {
    // The guard must not latch: skipping an empty flush cannot leave the surface unable
    // to save once it does have something.
    const save = vi.fn().mockResolvedValue();
    let pending = null;
    const { result } = renderHook(() => useAutosave({ getPending: () => pending, save }));
    await act(async () => { await result.current.flush(); });
    expect(save).not.toHaveBeenCalled();

    pending = { title: "Mission" };
    await act(async () => { await result.current.flush(); });
    expect(save).toHaveBeenCalledWith({ title: "Mission" });
  });

  test("falsy values that are NOT empty still write", async () => {
    // `0` and `""` are real settings — the nav size can be 0, a nav label can be cleared.
    // The guard has to mean "nothing pending", not "falsy".
    for (const value of [0, "", false]) {
      const save = vi.fn().mockResolvedValue();
      const { result } = renderHook(() => useAutosave({ getPending: () => value, save }));
      await act(async () => { await result.current.flush(); });
      expect(save, `${JSON.stringify(value)} should still be written`).toHaveBeenCalledWith(value);
    }
  });
});
