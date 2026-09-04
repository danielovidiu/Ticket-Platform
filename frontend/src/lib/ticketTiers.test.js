/**
 * The three buyer-facing tier rules, each of which has a wrong answer that costs money.
 *
 * A pack counted as one person breaks the per-user cap. A pack price read as a ticket
 * price misprices a refund. A paused tier read as a sell-out tells someone who would have
 * bought to stop coming back.
 */
import {
  packSizeOf, perTicketPrice, packOptions, saleState, tierTicketCap, soldOutMessage,
} from "./ticketTiers";

describe("tierTicketCap", () => {
  test("a tier's own cap wins over the event's", () => {
    expect(tierTicketCap({ max_tickets_per_user: 6 }, { max_tickets_per_user: 1 })).toBe(1);
  });

  test("a tier with no cap of its own inherits the event's", () => {
    expect(tierTicketCap({ max_tickets_per_user: 6 }, { max_tickets_per_user: null })).toBe(6);
  });

  test("so does a tier written before the field existed", () => {
    expect(tierTicketCap({ max_tickets_per_user: 6 }, {})).toBe(6);
    expect(tierTicketCap({ max_tickets_per_user: 6 }, null)).toBe(6);
  });

  test("the quantity dropdown follows the tier, not the event", () => {
    // The bug this exists to prevent: six offered on a tier the server caps at one, which
    // the buyer discovers only when the checkout refuses them.
    const event = { max_tickets_per_user: 6 };
    expect(packOptions(tierTicketCap(event, { max_tickets_per_user: 1 }), 1)).toEqual([1]);
    expect(packOptions(tierTicketCap(event, { max_tickets_per_user: null }), 1)).toEqual([1, 2, 3, 4]);
  });
});

describe("soldOutMessage", () => {
  test("the event's own words win where they were ever set", () => {
    // Every event written before the message moved onto the tier carries one here, and
    // taking it away would silently unpublish what a promoter wrote.
    expect(soldOutMessage({
      sold_out_message: "Gone",
      waves: [{ sold_out_message: "Tier words" }],
    })).toBe("Gone");
  });

  test("otherwise the last tier in running order to have words speaks", () => {
    // It is the tier that was still selling when the last ticket went.
    expect(soldOutMessage({
      sold_out_message: "",
      waves: [{ sold_out_message: "Early birds gone" }, { sold_out_message: "At the door" }],
    })).toBe("At the door");
  });

  test("a later tier with nothing to say does not silence an earlier one", () => {
    expect(soldOutMessage({
      waves: [{ sold_out_message: "Members only" }, { sold_out_message: "" }],
    })).toBe("Members only");
  });

  test("an event nobody worded falls back to Sold Out", () => {
    expect(soldOutMessage({ waves: [{ sold_out_message: "" }] })).toBe("Sold Out");
    expect(soldOutMessage({ waves: [] })).toBe("Sold Out");
    expect(soldOutMessage(null)).toBe("Sold Out");
  });
});

describe("packSizeOf", () => {
  test("an ordinary tier is one ticket a purchase", () => {
    expect(packSizeOf({ price_ron: 100 })).toBe(1);
  });

  test("a tier written before packs existed is too", () => {
    // No field at all, and it has always behaved as a single.
    expect(packSizeOf({})).toBe(1);
    expect(packSizeOf(null)).toBe(1);
  });

  test("a group tier is its pack size", () => {
    expect(packSizeOf({ pack_size: 4 })).toBe(4);
  });

  test("nonsense floors at one rather than issuing nothing", () => {
    // A tier that issued zero tickets would take money for them anyway.
    expect(packSizeOf({ pack_size: 0 })).toBe(1);
    expect(packSizeOf({ pack_size: -3 })).toBe(1);
    expect(packSizeOf({ pack_size: "x" })).toBe(1);
  });
});

describe("perTicketPrice", () => {
  test("four for the price of three is 75 a ticket", () => {
    expect(perTicketPrice({ pack_size: 4, price_ron: 300 })).toBe(75);
  });

  test("a single is just the price", () => {
    expect(perTicketPrice({ price_ron: 100 })).toBe(100);
  });
});

describe("packOptions", () => {
  test("singles run up to the per-user cap", () => {
    expect(packOptions(4, 1)).toEqual([1, 2, 3, 4]);
    expect(packOptions(2, 1)).toEqual([1, 2]);
  });

  test("a pack spends its whole size against the cap", () => {
    // Four seats, four to a pack: one pack. Offering a second would be refused at
    // checkout, which is a worse way to learn it.
    expect(packOptions(4, 4)).toEqual([1]);
  });

  test("a roomier cap allows more packs", () => {
    expect(packOptions(12, 4)).toEqual([1, 2, 3]);
  });

  test("a pack larger than the cap still offers one", () => {
    // A misconfigured event. An empty dropdown gives the buyer nothing to act on; the
    // server's refusal is the honest place for it.
    expect(packOptions(2, 4)).toEqual([1]);
  });

  test("a cap that does not divide evenly rounds down", () => {
    expect(packOptions(5, 2)).toEqual([1, 2]);
  });

  test("a missing cap falls back to the event default of four", () => {
    expect(packOptions(undefined, 1)).toEqual([1, 2, 3, 4]);
  });
});

describe("saleState", () => {
  const open = { is_active: true, available: 50 };
  const gone = { is_active: true, available: 0 };
  const closed = { is_active: false, available: 50 };

  test("a tier with stock in its window is open", () => {
    expect(saleState([open])).toBe("open");
  });

  test("no stock anywhere is sold out", () => {
    expect(saleState([gone, gone])).toBe("sold_out");
  });

  test("out of window with stock left is still sold out to the page", () => {
    // Unchanged behaviour: nothing is buyable, and the promoter's own wording covers it.
    expect(saleState([closed])).toBe("sold_out");
  });

  test("every tier paused is paused, not sold out", () => {
    // The stock is still there. Saying "sold out" would be untrue and would stop someone
    // checking back for a tier that is coming back.
    expect(saleState([{ ...open, status: "paused" }])).toBe("paused");
  });

  test("a paused tier does not drag an otherwise selling event into sold out", () => {
    expect(saleState([{ ...open, status: "paused" }, open])).toBe("open");
  });

  test("nor does it rescue a genuinely sold-out one", () => {
    // The paused tier is excluded from the test, the sold-out one decides it.
    expect(saleState([{ ...open, status: "paused" }, gone])).toBe("sold_out");
  });

  test("an event with no tiers at all is neither", () => {
    expect(saleState([])).toBe("none");
    expect(saleState(undefined)).toBe("none");
  });
});
