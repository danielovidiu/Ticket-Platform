/**
 * The password rules, mirrored from `backend/password_policy.py`.
 *
 * This copy exists so the form can say what is wrong WHILE someone types, rather than
 * after they submit. It is not the policy — the server is, and it always re-checks. A
 * mirror that drifts is worse than no mirror, so anything changed here changes there.
 *
 * One rule is deliberately absent: the breach lookup. It needs a network round trip, so
 * the client cannot answer it and the checklist must not pretend to. A password can
 * satisfy everything below and still be refused on submit, which is why the form keeps
 * showing server errors rather than trusting a green tick.
 */
export const MIN_LENGTH = 12;
export const MAX_BYTES = 72;

// The same shapes the server refuses — the ones that survive length and composition
// rules, which is what people reach for when a form demands a capital and a symbol.
const COMMON = new Set([
  "password", "passwort", "parola", "letmein", "welcome", "monkey", "dragon",
  "football", "baseball", "superman", "batman", "trustno", "iloveyou", "sunshine",
  "princess", "starwars", "whatever", "qwerty", "qwertyui", "azerty", "asdfgh",
  "zxcvbn", "qazwsx", "abc", "abcd", "abcdef", "abcdefg", "admin", "administrator",
  "root", "toor", "user", "guest", "test", "testing", "changeme", "secret",
  "master", "shadow", "jordan", "harley", "ranger", "hunter", "buster", "soccer",
  "hockey", "killer", "george", "andrew", "charlie", "thomas", "robert", "michael",
  "jennifer", "jessica", "michelle", "daniel", "matthew", "computer", "internet",
  "samsung", "google", "facebook", "spiderman", "pokemon", "minecraft", "chocolate",
  "freedom", "flower", "hello", "summer", "winter", "spring", "autumn", "january",
  "february", "december", "supersanity", "bucharest", "romania", "ticket", "tickets",
]);

const LEET = { "@": "a", "4": "a", "8": "b", "(": "c", "3": "e", "6": "g", "1": "i",
               "!": "i", "|": "i", "0": "o", "5": "s", $: "s", "7": "t", "+": "t", "2": "z" };
const DIGIT_LEET = { "4": "a", "8": "b", "3": "e", "6": "g", "1": "i",
                     "0": "o", "5": "s", "7": "t", "2": "z" };

const unleet = (s, map) => s.replace(/./g, (c) => map[c] ?? c);
const lettersOnly = (s) => s.replace(/[^a-z]/g, "");

/** Byte length, because bcrypt's ceiling is bytes and an emoji is four of them. */
export const byteLength = (s) => new TextEncoder().encode(s).length;

/**
 * Every reading of the password worth matching against the list.
 *
 * A symbol is ambiguous and no single rule is right about all of them: the `@` in
 * "P@ssw0rd" is a substituted letter, the `!!!!` in "Adm1n!!!!2020" is decoration, and
 * the `$` in "$unshine" is a letter at a position the first reading would strip. All
 * three readings are generated and matched EXACTLY — exact rather than prefix, because
 * "winterfell" begins with a listed word and is not a listed password.
 */
function candidates(pw) {
  const low = pw.toLowerCase();
  const out = new Set([low, lettersOnly(low)]);
  // Edge decoration, then a trailing counter, then leet. Leet last: undoing it first
  // turns the "123!" of "P@ssw0rd123!" into letters nothing then strips.
  const edged = low.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").replace(/\d+$/, "");
  out.add(lettersOnly(unleet(edged, LEET)));
  // Symbols as decoration rather than as letters.
  const bare = low.replace(/[^a-z0-9]/g, "").replace(/\d+$/, "");
  out.add(lettersOnly(unleet(bare, DIGIT_LEET)));
  // Symbols as leet, including a leading one.
  out.add(lettersOnly(unleet(low.replace(/\d+$/, ""), LEET)));
  return [...out].filter(Boolean);
}

export const isCommon = (pw) => candidates(pw).some((c) => COMMON.has(c));

/** Whether the password is built out of the account it protects. */
export function usesIdentity(pw, { email = "", name = "" } = {}) {
  if (!pw) return false;
  const low = pw.toLowerCase();
  const sources = [(email || "").split("@")[0], name || ""].join(" ");
  return sources.split(/[^A-Za-z0-9]+/)
    .some((part) => part.length >= 4 && low.includes(part.toLowerCase()));
}

/**
 * The checklist the form draws, in the order the server reports them.
 * Each entry is `{ id, label, ok }` — every rule always present, so the list does not
 * reflow as it fills in and the person can see what is still ahead of them.
 */
export function requirements(pw, identity = {}) {
  const p = pw || "";
  return [
    { id: "length", label: `At least ${MIN_LENGTH} characters`, ok: p.length >= MIN_LENGTH },
    { id: "lower", label: "A lowercase letter", ok: /[a-z]/.test(p) },
    { id: "upper", label: "An uppercase letter", ok: /[A-Z]/.test(p) },
    { id: "digit", label: "A number", ok: /\d/.test(p) },
    { id: "symbol", label: "A symbol", ok: /[^A-Za-z0-9\s]/.test(p) },
    { id: "uncommon", label: "Not a common password", ok: p.length > 0 && !isCommon(p) },
    { id: "notyou", label: "Not your name or email", ok: p.length > 0 && !usesIdentity(p, identity) },
    { id: "fits", label: `At most ${MAX_BYTES} characters`, ok: p.length > 0 && byteLength(p) <= MAX_BYTES },
  ];
}

/** True when every mirrored rule passes. The server still decides. */
export const isAcceptable = (pw, identity = {}) =>
  requirements(pw, identity).every((r) => r.ok);
