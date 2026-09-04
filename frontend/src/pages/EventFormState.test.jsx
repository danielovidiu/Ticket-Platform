/**
 * What the event form does to its own state.
 *
 * Every setter here now reads the form it is handed rather than one captured when the
 * handler was built. That is not a style preference: the captured version silently lost
 * updates, and it lost them without erroring, so the symptom was always some edit that
 * simply did not happen.
 *
 * Adding a poster is where it surfaced. The collection is `images` and the main artwork is
 * `image_url`, so the first poster sets both at once — and the second write, computed from
 * a copy taken before the first, put back an `images` without the picture just uploaded.
 * To the person who had chosen a file, uploading did nothing.
 *
 * These drive the REAL form with real state, because the wiring is where such bugs live:
 * PosterField and TierCard both report their changes correctly on their own.
 */
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
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

const TIER = {
  wave_id: "w1", tier_id: 1, name: "EARLY BIRD", price_ron: 100, capacity: 50,
  pack_size: 1, status: "active", starts_at: "", ends_at: "",
  access_until: "", access_from: "", sold: 0, held: 0,
  max_tickets_per_user: null, sold_out_message: "",
};

describe("editing the tier list", () => {
  test("adding a tier appends it rather than replacing the lineup", async () => {
    const seen = mount({ ...BLANK, waves: [TIER] });
    await userEvent.click(screen.getByTestId("add-tier"));

    expect(seen.form.waves).toHaveLength(2);
    expect(seen.form.waves[0].name).toBe("EARLY BIRD");
    // Numbered one past the highest already there, so it lands at the bottom of the
    // running order instead of tying with an existing tier.
    expect(seen.form.waves[1].tier_id).toBe(2);
  });

  test("editing one tier leaves the others alone", async () => {
    const seen = mount({ ...BLANK, waves: [TIER, { ...TIER, wave_id: "w2", tier_id: 2, name: "LATE" }] });
    await userEvent.clear(screen.getByTestId("wave-capacity-1"));
    await userEvent.type(screen.getByTestId("wave-capacity-1"), "7");

    expect(seen.form.waves[1].capacity).toBe(7);
    expect(seen.form.waves[0].capacity).toBe(50);
    expect(seen.form.waves[0].name).toBe("EARLY BIRD");
  });

  test("a tier name is typed a keystroke at a time and keeps all of them", async () => {
    /* Deliberately NOT a test of the lost-update bug, though it looks like one. Each
       keystroke is its own event, so the form re-renders in between and even the
       captured-form setter saw fresh state — this passes against both versions, and was
       checked against both rather than assumed.

       The bug needs TWO setter calls inside ONE handler, which no tier control does; that
       is exactly why setWaveFields exists for the access toggle, and why the poster
       collection was where it finally surfaced. What this pins is the ordinary case: the
       edit reaches the right tier and nothing eats the earlier letters. */
    const seen = mount({ ...BLANK, waves: [TIER] });
    await userEvent.clear(screen.getByTestId("wave-name-0"));
    await userEvent.type(screen.getByTestId("wave-name-0"), "VIP");

    expect(seen.form.waves[0].name).toBe("VIP");
  });

  test("deleting an unsold tier removes only that one", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const seen = mount({ ...BLANK, waves: [TIER, { ...TIER, wave_id: "w2", tier_id: 2, name: "LATE" }] });
    await userEvent.click(screen.getByTestId("wave-delete-0"));

    expect(seen.form.waves).toHaveLength(1);
    expect(seen.form.waves[0].name).toBe("LATE");
    window.confirm.mockRestore();
  });

  test("the access toggle sets one end and clears the other in one edit", async () => {
    // Two keys, one decision — the pair must never be left disagreeing about what the
    // editor meant, which is what setWaveFields exists to guarantee.
    const seen = mount({ ...BLANK, waves: [{ ...TIER, access_until: "2026-01-01T00:00:00.000Z" }] });
    const toggle = screen.getByTestId("wave-access-mode-0");
    await userEvent.click(within(toggle).getByText(/^From$/i));

    expect(seen.form.waves[0].access_until).toBe("");
  });
});
