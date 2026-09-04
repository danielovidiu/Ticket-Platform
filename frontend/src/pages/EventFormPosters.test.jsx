/**
 * Adding a poster writes TWO fields, and both have to survive.
 *
 * The collection is `images` and the main artwork is `image_url`, so the first poster
 * added sets both at once. Off a captured `form` object the second write is computed from
 * a copy taken before the first, so `images` came back rebuilt without the picture that
 * had just been uploaded — and the upload looked, to the person who did it, as though it
 * had simply not worked. Nothing errored; the state write was thrown away.
 *
 * These drive the real form with real state, because that wiring is where the bug lived —
 * PosterField on its own reported both changes correctly.
 */
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventForm } from "./Admin";

vi.mock("../api", () => ({ http: { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn(), patch: vi.fn() } }));

const BLANK = {
  title: "", slug: "", description: "", venue: "", city: "",
  starts_at: "", ends_at: "", doors_open_at: "",
  image_url: "", images: [], image_aspect: "4:3", artist_ids: [],
  max_tickets_per_user: 4, is_published: true, sold_out_message: "", waves: [],
};

/** The form as the admin page really mounts it: state above, setForm passed down. */
function Harness({ onState, initial = BLANK }) {
  const [form, setForm] = useState(initial);
  onState(form);
  return <EventForm form={form} setForm={setForm} onSave={() => {}} onClose={() => {}} />;
}

const mount = (initial) => {
  const seen = { form: null };
  render(<Harness initial={initial} onState={(f) => { seen.form = f; }} />);
  return seen;
};

describe("adding a poster to an event", () => {
  test("keeps the collection AND names the main artwork", async () => {
    const seen = mount();
    await userEvent.type(screen.getByTestId("event-posters-url"), "/uploads/a.jpg");
    await userEvent.click(screen.getByTestId("event-posters-add-url"));

    // Both, from one action. Either one alone is the bug.
    expect(seen.form.images).toEqual(["/uploads/a.jpg"]);
    expect(seen.form.image_url).toBe("/uploads/a.jpg");
  });

  test("a second poster joins the first rather than replacing it", async () => {
    const seen = mount();
    const url = screen.getByTestId("event-posters-url");
    await userEvent.type(url, "/uploads/a.jpg");
    await userEvent.click(screen.getByTestId("event-posters-add-url"));
    await userEvent.type(url, "/uploads/b.jpg");
    await userEvent.click(screen.getByTestId("event-posters-add-url"));

    expect(seen.form.images).toEqual(["/uploads/a.jpg", "/uploads/b.jpg"]);
    // The first stays the main artwork; a later addition is not a promotion.
    expect(seen.form.image_url).toBe("/uploads/a.jpg");
  });

  test("removing the main artwork promotes the next and keeps the rest", async () => {
    const seen = mount({ ...BLANK, images: ["/a.jpg", "/b.jpg"], image_url: "/a.jpg" });
    await userEvent.click(screen.getByTestId("event-posters-remove-0"));

    expect(seen.form.images).toEqual(["/b.jpg"]);
    expect(seen.form.image_url).toBe("/b.jpg");
  });

  test("nominating a different poster does not disturb the collection", async () => {
    const seen = mount({ ...BLANK, images: ["/a.jpg", "/b.jpg"], image_url: "/a.jpg" });
    await userEvent.click(screen.getByTestId("event-posters-main-1"));

    expect(seen.form.image_url).toBe("/b.jpg");
    expect(seen.form.images).toEqual(["/a.jpg", "/b.jpg"]);
  });
});
