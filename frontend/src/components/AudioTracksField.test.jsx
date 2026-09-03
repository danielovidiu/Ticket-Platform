/**
 * The list of clips a Split + Audio block plays.
 *
 * Rows rather than a text box, because an item here is two things — a name and a file —
 * and one of them arrives by upload. That makes ORDER part of the data rather than a
 * display choice: autoplay steps down this list, so the order shown is the order heard,
 * and moving a row has to move the file with its name.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, test, expect, beforeEach } from "vitest";
import AudioTracksField from "./AudioTracksField";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const uploadAudio = vi.hoisted(() => vi.fn());
vi.mock("../lib/uploadAudio", () => ({ uploadAudio }));

const clip = (name = "snippet.mp3") =>
  new File([new Uint8Array(8)], name, { type: "audio/mpeg" });

/** The field is controlled, so a test drives it the way the editor does: render, read the
 *  value handed to onChange, render again with it. */
function field(initial = []) {
  const onChange = vi.fn();
  const view = render(<AudioTracksField value={initial} onChange={onChange} />);
  return {
    onChange,
    latest: () => onChange.mock.calls.at(-1)?.[0],
    rerender: (value) => view.rerender(<AudioTracksField value={value} onChange={onChange} />),
  };
}

beforeEach(() => {
  uploadAudio.mockReset();
  uploadAudio.mockResolvedValue({ url: "/uploads/abc.mp3" });
});

describe("adding and removing", () => {
  test("an empty list still offers a way to start one", async () => {
    const f = field([]);
    await userEvent.click(screen.getByTestId("audio-tracks-add"));
    expect(f.latest()).toEqual([{ title: "", url: "" }]);
  });

  test("a row can be removed without disturbing the others", async () => {
    const f = field([{ title: "One", url: "/a.mp3" }, { title: "Two", url: "/b.mp3" }]);
    await userEvent.click(screen.getByTestId("audio-tracks-0-remove"));
    expect(f.latest()).toEqual([{ title: "Two", url: "/b.mp3" }]);
  });

  test("typing a name keeps the file that row already had", async () => {
    const f = field([{ title: "", url: "/a.mp3" }]);
    await userEvent.type(screen.getByTestId("audio-tracks-0-title"), "B");
    expect(f.latest()).toEqual([{ title: "B", url: "/a.mp3" }]);
  });
});

describe("order is the play order", () => {
  test("moving a row down carries its file with it", async () => {
    const f = field([{ title: "One", url: "/a.mp3" }, { title: "Two", url: "/b.mp3" }]);
    await userEvent.click(screen.getByTestId("audio-tracks-0-down"));
    expect(f.latest()).toEqual([{ title: "Two", url: "/b.mp3" }, { title: "One", url: "/a.mp3" }]);
  });

  test("the ends of the list cannot be walked off", () => {
    field([{ title: "One", url: "/a.mp3" }, { title: "Two", url: "/b.mp3" }]);
    expect(screen.getByTestId("audio-tracks-0-up")).toBeDisabled();
    expect(screen.getByTestId("audio-tracks-1-down")).toBeDisabled();
  });
});

describe("uploading a clip", () => {
  test("the returned URL lands in that row and nowhere else", async () => {
    const f = field([{ title: "One", url: "" }, { title: "Two", url: "" }]);
    await userEvent.upload(screen.getByTestId("audio-tracks-1-file"), clip());
    await waitFor(() => expect(f.latest()).toEqual([
      { title: "One", url: "" },
      { title: "Two", url: "/uploads/abc.mp3" },
    ]));
  });

  test("a file that is not audio is refused before anything is sent", async () => {
    field([{ title: "One", url: "" }]);
    // `fireEvent`, not `userEvent.upload`: user-event honours the input's `accept`
    // attribute and would drop the file before the component ever saw it — which is
    // exactly the thing being tested. The attribute filters a picker dialog; it does not
    // bind a drag-drop or anything else that can reach the input, so the component keeps
    // its own guard and this reaches that guard the way those paths would.
    const notAudio = new File([new Uint8Array(4)], "poster.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("audio-tracks-0-file"), { target: { files: [notAudio] } });
    await screen.findByTestId("audio-tracks-0-error");
    // Checked here rather than after the send: a rejected type used to be uploaded first
    // and abandoned afterwards, leaving bytes in the store with nothing pointing at them.
    expect(uploadAudio).not.toHaveBeenCalled();
  });

  test("a refusal from the server says so and keeps the file for a retry", async () => {
    // A 400 rather than a bare Error: the pipeline retries anything it reads as
    // transient, three times with backoff, and a test that waited that out would be
    // asserting the clock rather than the field.
    uploadAudio.mockRejectedValue({ response: { status: 400, data: { detail: "That file is not audio" } } });
    field([{ title: "One", url: "" }]);
    await userEvent.upload(screen.getByTestId("audio-tracks-0-file"), clip());
    expect(await screen.findByTestId("audio-tracks-0-error")).toHaveTextContent(/not audio/i);
    expect(screen.getByTestId("audio-tracks-0-retry")).toBeInTheDocument();
  });
});

describe("what the panel says about length", () => {
  test("the ninety-second rule is written down where the clips are chosen", () => {
    // Nothing trims audio on the server — there is no transcoder — so the cap is the
    // player's and an editor should read it here rather than discover it by listening.
    field([]);
    expect(screen.getByText(/90 seconds/i)).toBeInTheDocument();
  });
});
