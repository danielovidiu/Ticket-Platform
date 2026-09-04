/**
 * The event's poster collection, and which piece of it is the main artwork.
 *
 * Two fields move together here and the rules about how are the whole component:
 * `images` is the collection, `image_url` is the one that stands for the event on every
 * card and in every notice email. A collection with nothing standing for it means a card
 * with no picture, so the interesting cases are the ones where the main artwork would
 * otherwise be lost — the first poster added, and the removal of the current main.
 *
 * It is all form state on purpose: an editor fills this in while inventing the event, and
 * the album manager could not be used because an album needs a saved event first.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import PosterField from "./PosterField";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const post = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ http: { post } }));

const draw = (props = {}) => {
  const onChange = props.onChange || vi.fn();
  const onMainChange = props.onMainChange || vi.fn();
  render(<PosterField value={props.value ?? []} main={props.main ?? ""}
                      onChange={onChange} onMainChange={onMainChange} />);
  return { onChange, onMainChange };
};

describe("adding posters", () => {
  test("a pasted URL joins the collection", async () => {
    const { onChange } = draw();
    await userEvent.type(screen.getByTestId("event-posters-url"), "/a.jpg");
    await userEvent.click(screen.getByTestId("event-posters-add-url"));
    expect(onChange).toHaveBeenCalledWith(["/a.jpg"]);
  });

  test("the first one becomes the main artwork on its own", async () => {
    // Asking which of one picture should represent the event is a question with a single
    // answer, and leaving it unset means a card with no picture.
    const { onMainChange } = draw();
    await userEvent.type(screen.getByTestId("event-posters-url"), "/a.jpg");
    await userEvent.click(screen.getByTestId("event-posters-add-url"));
    expect(onMainChange).toHaveBeenCalledWith("/a.jpg");
  });

  test("a later one does not displace the chosen main artwork", async () => {
    const { onMainChange } = draw({ value: ["/a.jpg"], main: "/a.jpg" });
    await userEvent.type(screen.getByTestId("event-posters-url"), "/b.jpg");
    await userEvent.click(screen.getByTestId("event-posters-add-url"));
    expect(onMainChange).not.toHaveBeenCalled();
  });

  test("the same URL twice is still one poster", async () => {
    const { onChange } = draw({ value: ["/a.jpg"], main: "/a.jpg" });
    await userEvent.type(screen.getByTestId("event-posters-url"), "/a.jpg");
    await userEvent.click(screen.getByTestId("event-posters-add-url"));
    expect(onChange).toHaveBeenCalledWith(["/a.jpg"]);
  });
});

describe("the main artwork", () => {
  test("is marked on the tile that holds it", () => {
    draw({ value: ["/a.jpg", "/b.jpg"], main: "/b.jpg" });
    expect(screen.getByTestId("event-posters-tile-1")).toHaveAttribute("data-main", "true");
    expect(screen.getByTestId("event-posters-tile-0")).toHaveAttribute("data-main", "false");
  });

  test("is nominated by one click on the piece itself", async () => {
    const { onMainChange } = draw({ value: ["/a.jpg", "/b.jpg"], main: "/a.jpg" });
    await userEvent.click(screen.getByTestId("event-posters-main-1"));
    expect(onMainChange).toHaveBeenCalledWith("/b.jpg");
  });

  test("removing it promotes the next rather than leaving the event with none", async () => {
    const { onChange, onMainChange } = draw({ value: ["/a.jpg", "/b.jpg"], main: "/a.jpg" });
    await userEvent.click(screen.getByTestId("event-posters-remove-0"));
    expect(onChange).toHaveBeenCalledWith(["/b.jpg"]);
    expect(onMainChange).toHaveBeenCalledWith("/b.jpg");
  });

  test("removing a different one leaves it alone", async () => {
    const { onMainChange } = draw({ value: ["/a.jpg", "/b.jpg"], main: "/a.jpg" });
    await userEvent.click(screen.getByTestId("event-posters-remove-1"));
    expect(onMainChange).not.toHaveBeenCalled();
  });

  test("removing the last poster leaves nothing standing for the event", async () => {
    const { onChange, onMainChange } = draw({ value: ["/a.jpg"], main: "/a.jpg" });
    await userEvent.click(screen.getByTestId("event-posters-remove-0"));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(onMainChange).toHaveBeenCalledWith("");
  });
});

describe("order", () => {
  test("a poster can be moved later", async () => {
    const { onChange } = draw({ value: ["/a.jpg", "/b.jpg"], main: "/a.jpg" });
    await userEvent.click(screen.getByTestId("event-posters-right-0"));
    expect(onChange).toHaveBeenCalledWith(["/b.jpg", "/a.jpg"]);
  });

  test("a poster can be moved earlier", async () => {
    const { onChange } = draw({ value: ["/a.jpg", "/b.jpg"], main: "/a.jpg" });
    await userEvent.click(screen.getByTestId("event-posters-left-1"));
    expect(onChange).toHaveBeenCalledWith(["/b.jpg", "/a.jpg"]);
  });

  test("the ends do not offer a move off the end", () => {
    draw({ value: ["/a.jpg", "/b.jpg"], main: "/a.jpg" });
    expect(screen.getByTestId("event-posters-left-0")).toBeDisabled();
    expect(screen.getByTestId("event-posters-right-1")).toBeDisabled();
  });
});

describe("an empty collection", () => {
  test("shows no strip to reorder", () => {
    draw();
    expect(screen.queryByTestId("event-posters-strip")).not.toBeInTheDocument();
  });
});

/**
 * The upload path, which had no test at all — the cases above only ever added posters by
 * URL, so the button, the pipeline and the POST were unexercised. The reported symptom
 * was "the posters upload does nothing", and the gesture that did nothing was a DROP:
 * the album manager takes one, this did not, and a drop onto a page with no handler is
 * swallowed by the browser — indistinguishable, from the outside, from a broken control.
 */
describe("uploading posters", () => {
  const png = (name = "poster.png") =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

  const drawWithMocks = (props = {}) => {
    const onChange = props.onChange || vi.fn();
    const onMainChange = props.onMainChange || vi.fn();
    render(<PosterField value={props.value ?? []} main={props.main ?? ""}
                        onChange={onChange} onMainChange={onMainChange} />);
    return { onChange, onMainChange };
  };

  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { url: "/uploads/p1.png" } });
  });

  test("choosing a file uploads it and adds it to the collection", async () => {
    const { onChange, onMainChange } = drawWithMocks();
    await userEvent.upload(screen.getByTestId("event-posters-file"), png());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(["/uploads/p1.png"]));
    // …and the first one stands for the event without being asked.
    expect(onMainChange).toHaveBeenCalledWith("/uploads/p1.png");
  });

  test("dropping a file uploads it too — the gesture that used to do nothing", async () => {
    const { onChange } = drawWithMocks();
    fireEvent.drop(screen.getByTestId("event-posters-dropzone"), {
      dataTransfer: { files: [png("dropped.png")] },
    });
    await waitFor(() => expect(post).toHaveBeenCalled());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(["/uploads/p1.png"]));
  });

  test("the dropzone says it is a target while a file is over it", async () => {
    drawWithMocks();
    const zone = screen.getByTestId("event-posters-dropzone");
    expect(zone.className).not.toContain("border-brand");
    fireEvent.dragOver(zone);
    expect(zone.className).toContain("border-brand");
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toContain("border-brand");
  });

  test("clicking the zone opens the picker, so the drop is not the only way in", async () => {
    drawWithMocks();
    const input = screen.getByTestId("event-posters-file");
    const click = vi.spyOn(input, "click");
    await userEvent.click(screen.getByTestId("event-posters-dropzone"));
    expect(click).toHaveBeenCalled();
  });

  test("several posters arrive in the order they were given", async () => {
    post.mockReset();
    post.mockResolvedValueOnce({ data: { url: "/uploads/a.png" } })
        .mockResolvedValueOnce({ data: { url: "/uploads/b.png" } });
    const { onChange } = drawWithMocks();
    await userEvent.upload(screen.getByTestId("event-posters-file"), [png("a.png"), png("b.png")]);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(["/uploads/a.png", "/uploads/b.png"]));
  });

  test("a video is refused rather than uploaded as artwork", async () => {
    drawWithMocks();
    const mp4 = new File([new Uint8Array(4)], "clip.mp4", { type: "video/mp4" });
    fireEvent.drop(screen.getByTestId("event-posters-dropzone"), { dataTransfer: { files: [mp4] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
  });

  test("a failure leaves its row on screen with the reason", async () => {
    // The old control showed a count and nothing else, so a slow file, a retry and a
    // failure were the same thing from outside.
    post.mockReset();
    post.mockRejectedValue({ response: { status: 400, data: { detail: "That file is not a readable image" } } });
    drawWithMocks();
    await userEvent.upload(screen.getByTestId("event-posters-file"), png("bad.png"));
    const queue = await screen.findByTestId("event-posters-queue");
    await waitFor(() => expect(queue).toHaveTextContent(/not a readable image/i));
    expect(queue).toHaveTextContent(/bad\.png/i);
  });

  test("a clean run clears its rows — the posters are the confirmation", async () => {
    drawWithMocks();
    await userEvent.upload(screen.getByTestId("event-posters-file"), png());
    await waitFor(() => expect(screen.queryByTestId("event-posters-queue")).toBeNull());
  });
});
