/**
 * The Events page's tab bar, and the status column the All tab broke.
 *
 * The status used to be read off the active tab — sound while the only two tabs were
 * Upcoming and Past, because a list could then only hold one kind. All mixes them, so
 * every row on it would have claimed the status of whichever tab was selected. The
 * question is asked of each event now.
 *
 * The tab set comes from the CMS, so the page must not guess one before it arrives:
 * rendering a default and swapping it a moment later shows the visitor one slice of the
 * programme and then silently replaces it.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Events from "./Events";

vi.mock("../api", () => ({ http: { get: vi.fn() } }));
import { http } from "../api";

const FUTURE = {
  event_id: "e1", slug: "future-one", title: "FUTURE ONE",
  starts_at: "2035-01-01T20:00:00Z", ends_at: "2035-01-01T23:00:00Z",
  venue: "Hala", city: "Bucharest", total_available: 50,
};
const PAST = {
  event_id: "e2", slug: "past-one", title: "PAST ONE",
  starts_at: "2020-01-01T20:00:00Z", ends_at: "2020-01-01T23:00:00Z",
  venue: "Hala", city: "Bucharest", total_available: 0,
};

const mount = (settings, events) => {
  http.get.mockImplementation((url) =>
    url === "/cms/events-settings"
      ? Promise.resolve({ data: settings })
      : Promise.resolve({ data: events }));
  return render(<MemoryRouter><Events /></MemoryRouter>);
};

const ALL_THREE = { tabs: ["all", "upcoming", "past"], default_tab: "all" };

describe("the tab bar comes from the CMS", () => {
  test("it renders the configured tabs and opens on the configured default", async () => {
    mount(ALL_THREE, [FUTURE, PAST]);
    const bar = await screen.findByTestId("event-tabs");
    expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Upcoming", "Past"]);
    expect(screen.getByTestId("tab-all")).toHaveAttribute("aria-pressed", "true");
  });

  test("a different default opens on that tab", async () => {
    mount({ tabs: ["all", "upcoming", "past"], default_tab: "past" }, [PAST]);
    await waitFor(() => expect(screen.getByTestId("tab-past")).toHaveAttribute("aria-pressed", "true"));
  });

  test("tabs the CMS turned off are not offered", async () => {
    mount({ tabs: ["upcoming", "past"], default_tab: "upcoming" }, [FUTURE]);
    await screen.findByTestId("event-tabs");
    expect(screen.queryByTestId("tab-all")).not.toBeInTheDocument();
  });

  test("a single tab hides the bar — there is nothing to choose", async () => {
    mount({ tabs: ["upcoming"], default_tab: "upcoming" }, [FUTURE]);
    await screen.findByText("FUTURE ONE");
    expect(screen.queryByTestId("event-tabs")).not.toBeInTheDocument();
  });

  test("nothing is fetched or drawn before the settings land", () => {
    // A tab bar rendered from a guess is a tab bar that changes under the visitor.
    http.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><Events /></MemoryRouter>);
    expect(screen.queryByTestId("event-tabs")).not.toBeInTheDocument();
  });

  test("if the settings call fails the page still works", async () => {
    http.get.mockImplementation((url) =>
      url === "/cms/events-settings" ? Promise.reject(new Error("down"))
        : Promise.resolve({ data: [FUTURE] }));
    render(<MemoryRouter><Events /></MemoryRouter>);
    expect(await screen.findByTestId("event-tabs")).toBeInTheDocument();
  });
});

describe("the query each tab sends", () => {
  test.each([
    ["all", "/events"],
    ["upcoming", "/events?upcoming=true"],
    ["past", "/events?upcoming=false"],
  ])("%s asks for %s", async (tab, expected) => {
    mount({ tabs: ["all", "upcoming", "past"], default_tab: tab }, []);
    await waitFor(() => expect(http.get).toHaveBeenCalledWith(expected));
  });

  test("switching tab re-queries", async () => {
    mount(ALL_THREE, [FUTURE]);
    await screen.findByTestId("event-tabs");
    await userEvent.click(screen.getByTestId("tab-past"));
    await waitFor(() => expect(http.get).toHaveBeenCalledWith("/events?upcoming=false"));
  });
});

describe("status is per event, not per tab", () => {
  test("on All, a past and a future event get different statuses", async () => {
    mount(ALL_THREE, [FUTURE, PAST]);
    const future = await screen.findByTestId("event-row-future-one");
    const past = screen.getByTestId("event-row-past-one");
    expect(future).toHaveTextContent("ON SALE");
    expect(past).toHaveTextContent("ARCHIVED");
  });

  test("a sold-out future event says so rather than ARCHIVED", async () => {
    mount(ALL_THREE, [{ ...FUTURE, total_available: 0 }]);
    expect(await screen.findByTestId("event-row-future-one")).toHaveTextContent("SOLD OUT");
  });

  test("nearly gone is still worth saying", async () => {
    mount(ALL_THREE, [{ ...FUTURE, total_available: 3 }]);
    expect(await screen.findByTestId("event-row-future-one")).toHaveTextContent("ONLY A FEW LEFT");
  });

  test("an event with no end time is judged by its start", async () => {
    mount(ALL_THREE, [{ ...PAST, ends_at: null }]);
    expect(await screen.findByTestId("event-row-past-one")).toHaveTextContent("ARCHIVED");
  });
});
