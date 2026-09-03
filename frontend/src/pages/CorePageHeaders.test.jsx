/**
 * The eyebrow and name at the top of the four built-in section pages, now CMS content.
 *
 * The interesting half is deletion. These lines used to be literals with the gap hung
 * off the element underneath — `<h1 className="mt-2">` — so an emptied eyebrow would
 * have left its 8px behind and a deleted heading would have left a hole where the type
 * used to be. What is pinned here is that a removed line takes its space with it, and
 * that the page's own controls (the tab bars) survive the wording around them being
 * cleared: a filter is the page's, not the editor's.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Gallery from "./Gallery";
import Artists from "./Artists";
import Shop from "./Shop";
import { resetCorePageHeaders } from "../lib/corePageHeader";

vi.mock("../api", () => ({ http: { get: vi.fn() } }));
import { http } from "../api";

const HEADERS = {
  events: { eyebrow: "Programme", heading: "Events" },
  artists: { eyebrow: "Roster", heading: "Artists" },
  gallery: { eyebrow: "Documentation", heading: "Gallery" },
  shop: { eyebrow: "Merchandise", heading: "Shop" },
};

/** Route the two requests these pages make: their own content, and the headings. */
const serve = (headers, content = []) => {
  http.get.mockImplementation((url) => {
    if (url === "/cms/core-pages") return Promise.resolve({ data: headers });
    if (url === "/gallery/clusters") return Promise.resolve({ data: { albums: content } });
    return Promise.resolve({ data: content });
  });
};

beforeEach(() => {
  // The fetch is cached for the life of the tab, which is right in a browser and would
  // otherwise leak one test's wording into the next.
  resetCorePageHeaders();
  http.get.mockReset();
});

describe("the wording comes from the CMS", () => {
  test("gallery prints what the CMS says, not what the file used to", async () => {
    serve({ ...HEADERS, gallery: { eyebrow: "Evidence", heading: "Archive" } });
    render(<MemoryRouter><Gallery /></MemoryRouter>);
    expect(await screen.findByTestId("gallery-heading")).toHaveTextContent("Archive");
    expect(screen.getByTestId("gallery-eyebrow")).toHaveTextContent("Evidence");
  });

  test("shop too, and its heading keeps the smaller mobile step", async () => {
    serve({ ...HEADERS, shop: { eyebrow: "Goods", heading: "Store" } });
    render(<MemoryRouter><Shop /></MemoryRouter>);
    const h1 = await screen.findByTestId("shop-heading");
    expect(h1).toHaveTextContent("Store");
    // Shop's heading sits beside a filter row on a narrow phone, so it starts a step
    // below the other three rather than at text-5xl.
    expect(h1.className).toMatch(/\btext-4xl\b/);
  });
});

describe("a deleted line takes its space with it", () => {
  test("an emptied eyebrow renders no element at all", async () => {
    serve({ ...HEADERS, gallery: { eyebrow: "", heading: "Gallery" } });
    render(<MemoryRouter><Gallery /></MemoryRouter>);
    await screen.findByTestId("gallery-heading");
    expect(screen.queryByTestId("gallery-eyebrow")).toBeNull();
  });

  test("an emptied name renders no heading", async () => {
    serve({ ...HEADERS, gallery: { eyebrow: "Documentation", heading: "" } });
    render(<MemoryRouter><Gallery /></MemoryRouter>);
    await screen.findByTestId("gallery-eyebrow");
    expect(screen.queryByTestId("gallery-heading")).toBeNull();
    expect(document.querySelector("h1")).toBeNull();
  });

  test("with both gone the header block itself is absent, not an empty box", async () => {
    serve({ ...HEADERS, gallery: { eyebrow: "", heading: "" } });
    render(<MemoryRouter><Gallery /></MemoryRouter>);
    // The grid still renders — deleting the wording does not delete the page.
    await waitFor(() => expect(screen.queryByTestId("page-header")).toBeNull());
    expect(document.querySelectorAll("h1")).toHaveLength(0);
  });

  test("the gaps belong to the container, so nothing carries a stale margin", async () => {
    serve({ ...HEADERS, gallery: { eyebrow: "", heading: "Gallery" } });
    render(<MemoryRouter><Gallery /></MemoryRouter>);
    const h1 = await screen.findByTestId("gallery-heading");
    // This is the regression: the heading used to own the space under the eyebrow.
    expect(h1.className).not.toMatch(/\bmt-\d/);
  });
});

describe("the page's own controls outlive the wording", () => {
  test("the roster keeps its tab bar when the heading is deleted", async () => {
    serve({ ...HEADERS, artists: { eyebrow: "", heading: "" } }, []);
    render(<MemoryRouter><Artists /></MemoryRouter>);
    expect(await screen.findByTestId("artist-tabs")).toBeInTheDocument();
    expect(screen.queryByTestId("artists-heading")).toBeNull();
  });
});

describe("before the answer arrives", () => {
  test("nothing is printed, rather than wording the site may have deleted", () => {
    // A default drawn while the request is in flight would show "Documentation" to a
    // site that removed it and then snatch it back — the same flash the Events tab bar
    // already refuses to risk with its own settings.
    serve(HEADERS);
    render(<MemoryRouter><Gallery /></MemoryRouter>);
    expect(screen.queryByTestId("page-header")).toBeNull();
  });
});
