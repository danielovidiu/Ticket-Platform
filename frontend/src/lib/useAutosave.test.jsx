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
    await flushTimers(200);

    expect(save).toHaveBeenCalledWith("b");
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
    await waitFor(() => expect(save).toHaveBeenCalled());
    // And what landed is the newest value, not the one current when the timer armed.
    expect(save.mock.calls[save.mock.calls.length - 1][0]).toBe(value);
  });
});
