/**
 * The uploading status on the video field.
 *
 * A video is the one upload in the CMS that can run long enough for "is this doing
 * anything?" to be a real question. Now that a large file goes straight to blob storage
 * there is a true byte count to answer it with, and this pins that the count is shown
 * when it exists and NOT invented when it does not.
 *
 * The distinction matters more than it looks. Progress is available on the direct route
 * and unavailable on the API route, so the field has to be correct in both states — a bar
 * that animates without a number behind it is a claim the code cannot support.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, test, expect, beforeEach } from "vitest";
import VideoField from "./VideoField";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const uploadVideo = vi.hoisted(() => vi.fn());
vi.mock("../lib/uploadVideo", () => ({ uploadVideo }));

const file = (name = "clip.mp4") =>
  new File([new Uint8Array(8)], name, { type: "video/mp4" });

/** Hands back a promise plus the reporter the component passed in, so a test can drive
 *  the upload one step at a time instead of racing it. */
function deferredUpload() {
  let resolve;
  let report = null;
  uploadVideo.mockImplementation((_f, opts) => {
    report = opts?.onProgress ?? null;
    return new Promise((r) => { resolve = r; });
  });
  return {
    finish: (data = { url: "/u/clip.mp4", poster_url: "" }) => resolve(data),
    report: (n) => report?.(n),
    passedAReporter: () => typeof report === "function",
  };
}

async function pick() {
  const input = screen.getByTestId("video-field-file");
  await userEvent.upload(input, file());
}

beforeEach(() => { uploadVideo.mockReset(); });

const draw = () => render(<VideoField value="" posterValue="" onPatch={() => {}} />);

describe("uploading status", () => {
  test("nothing is shown before an upload starts", () => {
    draw();
    expect(screen.queryByTestId("video-field-status")).toBeNull();
  });

  test("the status appears while uploading and names the stage", async () => {
    const up = deferredUpload();
    draw();
    await pick();

    const status = await screen.findByTestId("video-field-status");
    expect(status.textContent).toMatch(/uploading/i);
    up.finish();
  });

  test("a percentage and a bar appear once the route reports progress", async () => {
    const up = deferredUpload();
    draw();
    await pick();
    await screen.findByTestId("video-field-status");

    // Before any report there is a stage but no number: 0% would claim the upload has
    // started moving bytes when nothing has been measured yet.
    expect(screen.queryByTestId("video-field-percent")).toBeNull();
    expect(screen.queryByTestId("video-field-bar")).toBeNull();

    up.report(42);

    await waitFor(() => {
      expect(screen.getByTestId("video-field-percent").textContent).toBe("42%");
    });
    expect(screen.getByTestId("video-field-bar").firstChild.style.width).toBe("42%");
    up.finish();
  });

  test("a route that reports nothing still shows the stage, and never a bar", async () => {
    // This is the API path: one request handed to the browser whole, with nothing to
    // measure. The word carries the status on its own.
    const up = deferredUpload();
    draw();
    await pick();

    const status = await screen.findByTestId("video-field-status");
    expect(status.textContent).toMatch(/uploading/i);
    expect(screen.queryByTestId("video-field-bar")).toBeNull();
    up.finish();
  });

  test("the reporter is actually handed to the upload", async () => {
    // Guards the wiring itself. The progress plumbing existed in lib/uploadVideo long
    // before anything passed a reporter in, so the UI could show nothing however well
    // the lower layers behaved.
    const up = deferredUpload();
    draw();
    await pick();
    await screen.findByTestId("video-field-status");

    expect(up.passedAReporter()).toBe(true);
    up.finish();
  });

  test("the status disappears when the upload finishes", async () => {
    const up = deferredUpload();
    draw();
    await pick();
    await screen.findByTestId("video-field-status");

    up.report(100);
    up.finish();

    // A status left on screen after the upload is done reads as a stall.
    await waitFor(() => expect(screen.queryByTestId("video-field-status")).toBeNull());
  });

  test("a failure replaces the status with the error, not both at once", async () => {
    // `refusedLocally` is what the real uploadVideo sets on a size refusal. Without it
    // the pipeline reads a plain Error as a dropped connection, retries three times and
    // reports "Connection lost" — so the flag is part of what is being tested here.
    const tooBig = new Error("That video is 120MB — the limit is 100MB.");
    tooBig.refusedLocally = true;
    uploadVideo.mockRejectedValue(tooBig);
    draw();
    await pick();

    const error = await screen.findByTestId("video-field-error", {}, { timeout: 5000 });
    expect(error.textContent).toMatch(/100MB/);
    expect(screen.queryByTestId("video-field-status")).toBeNull();
  }, 10000);
});
