/**
 * The save policy. Each property here exists because its absence was a bug in the CMS.
 *
 * The block draft got this right inline; page metadata and the theme never did — they
 * wrote on every change, unordered, and could not report a failure. This is the shared
 * version, so those two now behave like the one that worked.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAutosave } from "./useAutosave";

const flushTimers = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("debounce and ceiling", () => {
  test("a burst of edits is one request, not one per edit", async () => {
    const save = vi.fn().mockResolvedValue();
    let value = 0;
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, delay: 40, maxWait: 1000 })
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
      useAutosave({ getPending: () => value, save, delay: 1000, maxWait: 60 })
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
      useAutosave({ getPending: () => value, save, delay: 30, maxWait: 500 })
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
      useAutosave({ getPending: () => value, save, delay: 5, maxWait: 20 })
    );

    value = 1; act(() => result.current.bump());
    await flushTimers(10);
    value = 2; act(() => result.current.bump());
    await flushTimers(10);
    value = 3; act(() => result.current.bump());
    await flushTimers(200);

    expect(overlapped).toBe(false);
    // The last value must be what the server ends up holding.
    expect(save.mock.calls[save.mock.calls.length - 1][0]).toBe(3);
  });

  test("an edit made while a save is in flight is not lost", async () => {
    const save = vi.fn(async () => { await new Promise((r) => setTimeout(r, 50)); });
    let value = "a";
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => value, save, delay: 5, maxWait: 20 })
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
      useAutosave({ getPending: () => value, save, delay: 10, maxWait: 50 })
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
      useAutosave({ getPending: () => value, save, delay: 10, maxWait: 50 })
    );
    act(() => result.current.bump());
    await waitFor(() => expect(result.current.state).toBe("saved"));
    expect(result.current.dirty).toBe(false);
  });

  test("nothing is written when nothing changed", async () => {
    const save = vi.fn().mockResolvedValue();
    const { result } = renderHook(() =>
      useAutosave({ getPending: () => "same", save, delay: 10, maxWait: 50 })
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
      useAutosave({ getPending: () => value, save, delay: 5000, maxWait: 9000 })
    );
    act(() => result.current.bump());
    await act(async () => { await result.current.flush(); });
    expect(save).toHaveBeenCalledWith("x");
  });
});
