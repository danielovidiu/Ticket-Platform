/**
 * Which artwork an event page shows, and in what order.
 *
 * Two rules carry weight here. The main artwork leads, because a visitor arrived from a
 * card showing it and a different first picture reads as the wrong event. And an event
 * written before the collection existed is a one-poster event, not a blank one — that is
 * what keeps this from needing a migration.
 */
import { eventPosters } from "./eventPosters";

describe("eventPosters", () => {
  test("the main artwork leads", () => {
    expect(eventPosters({
      image_url: "/uploads/main.jpg",
      images: ["/uploads/b.jpg", "/uploads/main.jpg", "/uploads/c.jpg"],
    })).toEqual(["/uploads/main.jpg", "/uploads/b.jpg", "/uploads/c.jpg"]);
  });

  test("it is not shown twice for being in the collection as well", () => {
    const out = eventPosters({ image_url: "/a.jpg", images: ["/a.jpg"] });
    expect(out).toEqual(["/a.jpg"]);
  });

  test("an event written before the collection existed has one poster", () => {
    expect(eventPosters({ image_url: "/old.jpg" })).toEqual(["/old.jpg"]);
    expect(eventPosters({ image_url: "/old.jpg", images: [] })).toEqual(["/old.jpg"]);
  });

  test("a main artwork not in the collection still leads it", () => {
    // The pair can disagree — a PATCH may carry either field alone — so the page renders
    // sensibly rather than relying on the two being kept in step.
    expect(eventPosters({ image_url: "/main.jpg", images: ["/other.jpg"] }))
      .toEqual(["/main.jpg", "/other.jpg"]);
  });

  test("an event with no artwork at all yields nothing to show", () => {
    expect(eventPosters({})).toEqual([]);
    expect(eventPosters(null)).toEqual([]);
    expect(eventPosters({ image_url: "", images: [] })).toEqual([]);
  });

  test("blank entries are not slides", () => {
    expect(eventPosters({ image_url: "/a.jpg", images: ["", "   ", "/b.jpg"] }))
      .toEqual(["/a.jpg", "/b.jpg"]);
  });
});
