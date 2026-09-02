/**
 * Where a page's background block is allowed to reach.
 *
 * It is a screenful tall and pinned, so on a page shorter than the window it hangs past
 * the end of its own content — and the footer has no background of its own, so the
 * photograph simply showed through it. Reported as "the background hides the footer",
 * which is exactly what it did.
 *
 * Stacking alone does not fix that. The footer painting *above* the backdrop still leaves
 * a transparent footer with a photograph behind it. The backdrop has to be clipped to the
 * page's own content.
 */
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DynamicPage from "./DynamicPage";

vi.mock("../api", () => ({ http: { get: vi.fn() } }));
import { http } from "../api";

const page = (blocks) => {
  http.get.mockResolvedValue({ data: { slug: "p", blocks } });
  return render(<MemoryRouter><DynamicPage slugOverride="p" /></MemoryRouter>);
};

const BG = { block_id: "b0", type: "_background", props: { image_url: "/x.jpg", overlay_opacity: 40 } };
const TEXT = { block_id: "b1", type: "rich_text", props: { content: "hello" } };

const wrapper = (c) => c.querySelector("[data-cms-page]");

test("a page with a background clips it to its own content", async () => {
  const { container, findByText } = page([BG, TEXT]);
  await findByText("hello");
  const cls = [...wrapper(container).classList];
  expect(cls).toContain("overflow-clip");
  expect(cls).toContain("relative");
});

test("clip, never hidden — hidden would unpin the backdrop", async () => {
  // `hidden` makes the element a scroll container, and a sticky child pins to its nearest
  // scrollport. The backdrop would stop tracking the window and sit at the top instead.
  const { container, findByText } = page([BG, TEXT]);
  await findByText("hello");
  expect([...wrapper(container).classList]).not.toContain("overflow-hidden");
});

test("a page with no background is left completely alone", async () => {
  // Nothing to clip, and clipping anyway would cut off anything a block deliberately
  // overflows — the marquee runs off both sides by design.
  const { container, findByText } = page([TEXT]);
  await findByText("hello");
  expect(wrapper(container).className).toBeFalsy();
});

test("the backdrop is lifted out of the run of blocks, not left among them", async () => {
  const { container, findByText } = page([TEXT, BG]);
  await findByText("hello");
  const w = wrapper(container);
  // First child IS the backdrop — it is rendered before the blocks rather than in
  // among them, whatever position the editor left it in.
  expect(w.firstElementChild.getAttribute("data-testid")).toBe("page-background");
  expect([...w.lastElementChild.classList]).toContain("z-10");
});
