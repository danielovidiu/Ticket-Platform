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
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PosterField from "./PosterField";

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
