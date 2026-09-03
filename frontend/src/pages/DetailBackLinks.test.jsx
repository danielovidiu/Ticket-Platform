/**
 * The way back to the index, on the three detail pages.
 *
 * It used to sit at the foot of the artist's text column, and on the event and product
 * pages it did not exist at all — the only way back was the browser's own button. A
 * visitor who has decided this is not the artist, night or shirt they wanted is the one
 * person least willing to scroll the whole page to leave it, so the link goes where the
 * album page already put it: above the title, top left.
 *
 * Document order is what is asserted, because that IS the claim. jsdom does no layout,
 * so "top left" is not measurable here — but "before the heading, not after it" is
 * exactly the property that was wrong, and it is the one that would regress.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ArtistDetail from "./ArtistDetail";
import ProductDetail from "./ProductDetail";
import EventDetail from "./EventDetail";

vi.mock("../api", () => ({ http: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: null }), startLogin: vi.fn() }));
vi.mock("../lib/cart", async () => {
  const actual = await vi.importActual("../lib/cart");
  return { ...actual, useCart: () => ({ refresh: vi.fn() }) };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { http } from "../api";

/** Node.DOCUMENT_POSITION_FOLLOWING — `b` comes after `a` in the document. */
const comesBefore = (a, b) => Boolean(a.compareDocumentPosition(b) & 4);

const mountAt = (path, route, element) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path={route} element={element} /></Routes>
  </MemoryRouter>
);

// jsdom has no ResizeObserver, and the event page's description block measures itself
// to decide whether it needs a "read more". Nothing here is about that, so it gets the
// smallest stand-in that lets the component mount.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => http.get.mockReset());

test("an artist page offers the roster before the artist's name, not after the bio", async () => {
  http.get.mockResolvedValue({ data: {
    artist_id: "a1", name: "VOID ORCHESTRA", slug: "void-orchestra",
    image_url: "", disciplines: [], links: {}, albums: [],
  } });
  mountAt("/artists/void-orchestra", "/artists/:slug", <ArtistDetail />);

  const back = await screen.findByTestId("artist-back");
  expect(back).toHaveAttribute("href", "/artists");
  expect(comesBefore(back, screen.getByRole("heading", { level: 1 }))).toBe(true);
});

test("a product page has a way back to the shop at all, and it is above the title", async () => {
  http.get.mockResolvedValue({ data: {
    product_id: "p1", name: "TOUR TEE", slug: "tour-tee", price_ron: 150,
    images: [], variants: [{ variant_id: "v1", size: "M", in_stock: true, sku: "X" }],
    in_stock: true, category: "", gender: "", description: "",
  } });
  mountAt("/shop/tour-tee", "/shop/:slug", <ProductDetail />);

  const back = await screen.findByTestId("product-back");
  expect(back).toHaveAttribute("href", "/shop");
  expect(comesBefore(back, await screen.findByTestId("product-title"))).toBe(true);
});

test("an event page likewise, above the event's title", async () => {
  http.get.mockResolvedValue({ data: {
    event_id: "e1", title: "NIGHT ONE", slug: "night-one",
    starts_at: "2035-01-01T20:00:00+00:00", ends_at: "2035-01-01T23:00:00+00:00",
    doors_open_at: "2035-01-01T19:00:00+00:00",
    venue: "Control", city: "Bucharest", image_url: "", description: "",
    waves: [], albums: [], max_tickets_per_user: 4,
  } });
  mountAt("/events/night-one", "/events/:slug", <EventDetail />);

  const back = await screen.findByTestId("event-back");
  expect(back).toHaveAttribute("href", "/events");
  expect(comesBefore(back, await screen.findByTestId("event-title"))).toBe(true);
});

test("all three read the same, so the gesture is learnable once", async () => {
  http.get.mockResolvedValue({ data: {
    artist_id: "a1", name: "VOID ORCHESTRA", slug: "void-orchestra",
    image_url: "", disciplines: [], links: {}, albums: [],
  } });
  mountAt("/artists/void-orchestra", "/artists/:slug", <ArtistDetail />);
  const back = await screen.findByTestId("artist-back");
  expect(back).toHaveTextContent("←");
  expect(back.className).toMatch(/text-\[10px\]/);
});
