/**
 * The theme dropdown in CMS -> Theme.
 *
 * This asserts against the rendered <select>, not against the data behind it, because
 * the thing that matters to an editor is what the one control they use actually
 * offers. A previous pass had all three themes defined and reachable in the data while
 * the dropdown they were looking at still listed two — which every data-level test
 * passed straight through.
 */
import { render, fireEvent, within } from "@testing-library/react";
import { ThemeEditor } from "./CMSEditor";
import { presetPatch } from "../lib/themePresets";

// FontPicker and FontManager fetch on mount and are not what this is about.
vi.mock("../components/FontPicker", () => ({ default: () => null }));
vi.mock("../components/FontManager", () => ({ default: () => null }));

/* Queries are scoped to this render's own container rather than to document.body,
   so a test that draws twice to compare two themes doesn't match both at once. */
const draw = (theme, onChange = vi.fn()) => {
  const { container } = render(
    <ThemeEditor theme={theme} onChange={onChange} onPublish={vi.fn()}
                 customFonts={[]} onFontsChanged={vi.fn().mockResolvedValue([])} />
  );
  const q = within(container);
  return { ...q, container, onChange, select: q.getByTestId("theme-mode-select") };
};

describe("what the dropdown offers", () => {
  test("lists Dark, Light and Supersanity, in that order", () => {
    const { select } = draw(presetPatch("dark"));
    expect([...select.options].map((o) => o.textContent)).toEqual(["Dark", "Light", "Supersanity"]);
  });

  test("there is exactly one theme control, not a second picker beside it", () => {
    // The whole point of putting Supersanity in this select is that it is the only
    // place the question gets asked.
    const { queryByTestId, getAllByTestId } = draw(presetPatch("dark"));
    expect(getAllByTestId("theme-mode-select")).toHaveLength(1);
    expect(queryByTestId("theme-presets")).toBeNull();
  });

  test("shows the theme the document is actually on", () => {
    expect(draw(presetPatch("supersanity")).select.value).toBe("supersanity");
    expect(draw(presetPatch("light")).select.value).toBe("light");
  });

  test("falls back to Dark for a theme with no mode stored", () => {
    expect(draw({ colors: {} }).select.value).toBe("dark");
  });
});

describe("choosing a theme", () => {
  test("Supersanity applies its palette, fonts and spacing in one change", () => {
    const { select, onChange } = draw(presetPatch("dark"));
    fireEvent.change(select, { target: { value: "supersanity" } });

    expect(onChange).toHaveBeenCalledTimes(1); // one autosave, one undo step
    const patch = onChange.mock.calls[0][0];
    expect(patch.mode).toBe("supersanity");
    expect(patch.colors.accent).toBe("#FF1F6C");
    expect(patch.fonts.display).toBe("Archivo");
  });

  test("Light keeps a customer's own accent rather than repainting it", () => {
    const mine = { ...presetPatch("dark"), colors: { ...presetPatch("dark").colors, accent: "#00E5FF" } };
    const { select, onChange } = draw(mine);
    fireEvent.change(select, { target: { value: "light" } });

    const patch = onChange.mock.calls[0][0];
    expect(patch.colors.accent).toBe("#00E5FF");
    expect(patch.colors.bg).toBe("#FFFFFF");
  });
});

describe("the contrast warning", () => {
  test("stays quiet on a palette that passes", () => {
    expect(draw(presetPatch("supersanity")).queryByTestId("contrast-warnings")).toBeNull();
  });

  test("names the failing pairing when one is below AA", () => {
    // The old light theme: the house red, tuned for dark, printed on a white page.
    const bad = presetPatch("light");
    bad.colors.accent = "#FF3333";
    const { getByTestId } = draw(bad);
    expect(getByTestId("contrast-warnings").textContent).toMatch(/Accent as text/i);
    expect(getByTestId("contrast-warnings").textContent).toContain("3.64");
  });
});

/**
 * The menu text size.
 *
 * A theme value rather than a fixed class, because how big the nav should be depends on
 * how many items it holds and how long their labels are — both an editor's decision. The
 * control has to show the shipped 11px for a theme saved before it existed, or an editor
 * sees a slider at some arbitrary position and cannot tell what the site is doing.
 */
describe("menu text size", () => {
  const slider = (theme) => draw(theme).getByTestId("theme-nav-size");

  test("a theme without the field reads as the 11px it shipped with", () => {
    expect(slider({ colors: {}, fonts: {} })).toHaveValue("11");
  });

  test("a stored value is what the control shows", () => {
    expect(slider({ colors: {}, fonts: {}, nav_size: 20 })).toHaveValue("20");
  });

  test("0 is a real value, not an absent one", () => {
    // `||` would read 0 as "unset" and snap the control back to 11.
    expect(slider({ colors: {}, fonts: {}, nav_size: 0 })).toHaveValue("8"); // clamped by min
  });

  test("moving it reports a number, not the input's string", () => {
    const { getByTestId, onChange } = draw({ colors: {}, fonts: {} });
    fireEvent.change(getByTestId("theme-nav-size"), { target: { value: "16" } });
    expect(onChange).toHaveBeenCalledWith({ nav_size: 16 });
  });

  test("the range is bounded where the stylesheet clamps", () => {
    const el = slider({ colors: {}, fonts: {} });
    expect(el).toHaveAttribute("min", "8");
    expect(el).toHaveAttribute("max", "32");
  });
});
