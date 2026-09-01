/**
 * The client's copy of the password rules.
 *
 * It exists so the form can answer while somebody types rather than after they submit,
 * and its only real obligation is to agree with `backend/password_policy.py`. A mirror
 * that drifts is worse than no mirror: it tells people they are fine and the server then
 * refuses them, which is the one failure mode the mirror was added to prevent.
 *
 * The cases below are the same ones the backend suite asserts, deliberately.
 */
import { requirements, isAcceptable, isCommon, usesIdentity, byteLength, MIN_LENGTH } from "./passwordPolicy";

const rule = (pw, id, identity) => requirements(pw, identity).find((r) => r.id === id).ok;

describe("length", () => {
  test("eleven is short and twelve is not", () => {
    expect(rule("Aa1!aaaaaaa", "length")).toBe(false);
    expect(rule("Aa1!aaaaaaaa", "length")).toBe(true);
  });

  test("the ceiling is bcrypt's, counted in bytes", () => {
    expect(rule("Aa1!" + "x".repeat(68), "fits")).toBe(true);
    expect(rule("Aa1!" + "x".repeat(69), "fits")).toBe(false);
    // 68 emoji are 272 bytes; bcrypt would keep about eighteen of them.
    expect(rule("Aa1!" + "😀".repeat(68), "fits")).toBe(false);
    expect(byteLength("😀")).toBe(4);
  });
});

describe("composition", () => {
  test.each([
    ["AA1!AAAAAAAA", "lower"],
    ["aa1!aaaaaaaa", "upper"],
    ["Aaa!aaaaaaaa", "digit"],
    ["Aa1aaaaaaaaa", "symbol"],
  ])("%s fails the %s rule", (pw, id) => {
    expect(rule(pw, id)).toBe(false);
  });

  test("a symbol is anything that is not a letter or a digit", () => {
    for (const sym of ["!", "£", "§", "—", "字", "😀"]) {
      expect(rule(`Aa1${sym}aaaaaaaa`, "symbol")).toBe(true);
    }
  });

  test("every rule is present from the first keystroke, so the list does not reflow", () => {
    expect(requirements("").length).toBe(requirements("Correct-Horse-9!").length);
  });
});

describe("the blocklist agrees with the server's", () => {
  test.each(["Password!123", "P@ssw0rd123!", "!!Letmein2024", "Adm1n!!!!2020",
             "$unshine-1234", "Qwerty!!!!!99"])("%s is common", (pw) => {
    expect(isCommon(pw)).toBe(true);
  });

  test.each(["Correct-Horse-9!", "Tr0ubad0ur-Ripe!", "Winterfell-Str0ng!",
             "Fixture-Str0ng-Pass!", "Summerhouse-9x!"])("%s is not", (pw) => {
    expect(isCommon(pw)).toBe(false);
  });

  test("exact matching, not prefix — winterfell begins with a listed word", () => {
    expect(isCommon("winter")).toBe(true);
    expect(isCommon("Winterfell-Str0ng!")).toBe(false);
  });
});

describe("it may not be built from the account", () => {
  test("the email local part and the name are both refused", () => {
    expect(usesIdentity("Danieltest-99!", { email: "danieltest@example.com" })).toBe(true);
    expect(usesIdentity("Teodorescu-9!", { name: "Daniel Teodorescu" })).toBe(true);
  });

  test("case does not hide it", () => {
    expect(usesIdentity("DANIELTEST-99!", { email: "danieltest@example.com" })).toBe(true);
  });

  test("a short fragment does not trip it", () => {
    // Two- and three-letter names would refuse half the dictionary.
    expect(usesIdentity("Correct-Horse-9!", { name: "Al Bo" })).toBe(false);
  });

  test("with no identity known there is nothing to match", () => {
    expect(usesIdentity("Correct-Horse-9!")).toBe(false);
  });
});

describe("isAcceptable", () => {
  test("a real passphrase passes", () => {
    expect(isAcceptable("Correct-Horse-9!")).toBe(true);
  });

  test("an empty password fails everything without throwing", () => {
    expect(isAcceptable("")).toBe(false);
    expect(() => requirements(undefined)).not.toThrow();
  });

  test(`the minimum is ${MIN_LENGTH}, matching the server`, () => {
    expect(MIN_LENGTH).toBe(12);
  });
});
