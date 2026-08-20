/**
 * What the renderer must preserve.
 *
 * Every case here is something the previous renderer destroyed: it trimmed each line,
 * joined the lines of a paragraph with a space, dropped blank lines, had no lists, and
 * promoted any ALL-CAPS line to a styled eyebrow. Authored text came out as something
 * the author had not written.
 */
import { render, screen } from "@testing-library/react";
import { renderRich } from "./richText";

const html = (md) => {
  const { container } = render(<div>{renderRich(md)}</div>);
  return container;
};

describe("line breaks", () => {
  test("a single newline is a break, not a space", () => {
    const c = html("Hala 3, Bucharest\n21 September\nDoors 22:00");
    // The old renderer produced "Hala 3, Bucharest 21 September Doors 22:00".
    expect(c.querySelectorAll("br").length).toBe(2);
    expect(c.textContent).toContain("Hala 3, Bucharest");
    expect(c.textContent).toContain("Doors 22:00");
  });

  test("a blank line still separates paragraphs", () => {
    const c = html("First para.\n\nSecond para.");
    expect(c.querySelectorAll("p").length).toBeGreaterThanOrEqual(2);
  });

  test("an extra blank line is kept as spacing rather than collapsed", () => {
    const one = html("A\n\nB").querySelectorAll("p").length;
    const two = html("A\n\n\nB").querySelectorAll("p").length;
    expect(two).toBeGreaterThan(one);
  });
});

describe("whitespace the author typed", () => {
  test("indentation survives", () => {
    const c = html("    indented four spaces");
    expect(c.textContent).toContain("    indented four spaces");
  });

  test("paragraphs are rendered with pre-wrap so runs of spaces are not collapsed", () => {
    const c = html("a    b");
    expect(c.querySelector("p").className).toContain("whitespace-pre-wrap");
  });
});

describe("lists", () => {
  test("dashes make an unordered list", () => {
    const c = html("- one\n- two\n- three");
    expect(c.querySelectorAll("ul li").length).toBe(3);
  });

  test("numbers make an ordered list", () => {
    const c = html("1. first\n2. second");
    expect(c.querySelectorAll("ol li").length).toBe(2);
  });

  test("a list ends where the prose starts again", () => {
    const c = html("- one\n- two\n\nBack to prose.");
    expect(c.querySelectorAll("ul li").length).toBe(2);
    expect(c.textContent).toContain("Back to prose.");
  });
});

describe("nothing is reinterpreted", () => {
  test("an ALL-CAPS line stays a paragraph", () => {
    // It used to become a styled eyebrow <div> purely because of its casing, so an
    // author who shouted one line got a different element than the one they wrote.
    const c = html("THIS IS SHOUTED PROSE");
    expect(c.querySelector("p")).toBeTruthy();
    expect(c.textContent).toBe("THIS IS SHOUTED PROSE");
  });

  test("casing is never changed on the way through", () => {
    const c = html("iPhone and eBay and McDonald's");
    expect(c.textContent).toBe("iPhone and eBay and McDonald's");
  });

  test("headings are not forced to upper case", () => {
    const c = html("# Quiet heading");
    expect(c.querySelector("h1").className).not.toContain("uppercase");
    expect(c.querySelector("h1").textContent).toBe("Quiet heading");
  });

  test("punctuation is left exactly as typed", () => {
    const typed = "He said “no” — then… nothing‽ (really!)";
    expect(html(typed).textContent).toBe(typed);
  });
});

describe("inline formatting still works", () => {
  test("bold, italic, underline, strike", () => {
    const c = html("**b** *i* __u__ ~~s~~");
    expect(c.querySelector("strong").textContent).toBe("b");
    expect(c.querySelector("em").textContent).toBe("i");
    expect(c.querySelector("u").textContent).toBe("u");
    expect(c.querySelector("s").textContent).toBe("s");
  });

  test("links", () => {
    const c = html("[the site](https://example.com)");
    const a = c.querySelector("a");
    expect(a.getAttribute("href")).toBe("https://example.com");
    expect(a.textContent).toBe("the site");
  });

  test("formatting works inside a list item", () => {
    const c = html("- **bold** item");
    expect(c.querySelector("li strong").textContent).toBe("bold");
  });
});
