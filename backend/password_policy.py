"""
What may be used as a password, and where that is decided.

One module because there are two places a password is set — registration and reset — and
until now they each carried their own copy of the rule (`len(pw) < 8`, twice). Two copies
of a policy is a policy that will eventually disagree with itself, and the direction it
disagrees in is the one nobody notices: a password refused at reset but accepted at
signup binds only the people who forgot theirs.

The order of the checks is not decorative:

  * everything local runs BEFORE the network call, so the common rejection costs nothing;
  * and `validate` is called BEFORE the reset token is read, so a refused password never
    burns the link. `test_a_short_password_does_not_burn_the_token` pins that, and it is
    the difference between "try again" and "request another email and hope it arrives".

WHY A BYTE CEILING. bcrypt hashes at most 72 bytes and silently ignores the rest, so two
different long passphrases that share a 72-byte prefix are the same password to this
system. The alternatives were to pre-hash with SHA-256 (correct, but it changes the stored
format and every existing hash would need migrating) or to keep truncating in silence.
Refusing at the point of entry is neither, and it is the only one of the three that tells
the truth to the person typing.
"""
import hashlib
import os
import re
from typing import List, Optional

import httpx

MIN_LENGTH = 12
# bcrypt's own ceiling, in BYTES — an accented character or an emoji spends more than one.
MAX_BYTES = 72

# Passwords that pass the composition rules and are still worthless. The classic top-N
# lists are mostly short or all-lowercase and are already refused by length and
# composition, so listing them again buys nothing; these are the ones that survive those
# rules — the shapes people reach for when a form demands a capital, a digit and a symbol.
COMMON_PASSWORDS = {
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
}

# Undone before the blocklist is consulted, so "P@ssw0rd123!" is recognised as "password".
# A blocklist that only matches the literal string is a blocklist people walk around by
# holding down shift.
_LEET = str.maketrans({"@": "a", "4": "a", "8": "b", "(": "c", "3": "e", "6": "g",
                       "1": "i", "!": "i", "|": "i", "0": "o", "5": "s", "$": "s",
                       "7": "t", "+": "t", "2": "z"})
# Digits only. Applied after symbols have been stripped as decoration, where mapping "!"
# to "i" would invent letters rather than recover them.
_DIGIT_LEET = str.maketrans({"4": "a", "8": "b", "3": "e", "6": "g", "1": "i",
                             "0": "o", "5": "s", "7": "t", "2": "z"})

_HIBP_URL = "https://api.pwnedpasswords.com/range/{prefix}"
_HIBP_TIMEOUT = 2.0


def _enabled(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip() not in ("0", "false", "no", "")


def _strip_edges(s: str) -> str:
    return re.sub(r"^[^a-z0-9]+|[^a-z0-9]+$", "", s)


def normalise(pw: str) -> str:
    """The password with its decoration removed, for blocklist comparison only.

    Edge decoration first, then a trailing year or counter, then leet. That order is the
    whole trick: undoing leet first turns the trailing "123!" of "P@ssw0rd123!" into
    letters nothing then strips, and the word a list could have matched comes out
    "passwordizei".

    Never used for hashing, and never compared against a stored value.
    """
    s = re.sub(r"\d+$", "", _strip_edges(pw.lower()))
    return re.sub(r"[^a-z]", "", s.translate(_LEET))


def _candidates(pw: str) -> set:
    """Every reading of the password worth matching against the list.

    A symbol is ambiguous and no single rule is right about all of them. The `@` in
    "P@ssw0rd" is a letter someone substituted; the `!!!!` in "Adm1n!!!!2020" is
    decoration; the `$` in "$unshine" is a letter again, at a position where the first
    reading would have stripped it. So all three readings are generated and each is
    matched EXACTLY — exact rather than prefix, because "winterfell" begins with a listed
    word and is not a listed password.
    """
    low = pw.lower()
    out = {low, re.sub(r"[^a-z]", "", low), normalise(pw)}

    # Symbols as decoration: strip them, then a trailing counter, then digit-leet only.
    # "Adm1n!!!!2020" -> "admin". Mapping "!" to "i" here would invent letters.
    decorated = re.sub(r"\d+$", "", re.sub(r"[^a-z0-9]", "", low))
    out.add(re.sub(r"[^a-z]", "", decorated.translate(_DIGIT_LEET)))

    # Symbols as leet, including one that leads: "$unshine-1234" -> "sunshine".
    out.add(re.sub(r"[^a-z]", "", re.sub(r"\d+$", "", low).translate(_LEET)))
    return {c for c in out if c}


def _blocklisted(pw: str) -> bool:
    return bool(_candidates(pw) & COMMON_PASSWORDS)


def local_problems(pw: str, *, email: str = "", name: str = "") -> List[str]:
    """Everything wrong with `pw` that can be decided without leaving the process.

    Returns every failure rather than the first, because a form that reveals one rule per
    submission is a form people submit five times.
    """
    problems: List[str] = []

    if len(pw) < MIN_LENGTH:
        problems.append(f"be at least {MIN_LENGTH} characters")
    if len(pw.encode("utf-8")) > MAX_BYTES:
        problems.append(f"be at most {MAX_BYTES} characters "
                        "(accented characters and emoji count as more than one)")

    if not re.search(r"[a-z]", pw):
        problems.append("include a lowercase letter")
    if not re.search(r"[A-Z]", pw):
        problems.append("include an uppercase letter")
    if not re.search(r"\d", pw):
        problems.append("include a number")
    # Anything that is not a letter, a digit or whitespace. Defined by exclusion so an
    # unusual but perfectly good symbol counts, rather than only the ones on a US layout.
    if not re.search(r"[^A-Za-z0-9\s]", pw):
        problems.append("include a symbol")

    if _blocklisted(pw):
        problems.append("not be a commonly used password")

    # A password built out of the account it protects is worth very little: whoever is
    # guessing already knows the address they are guessing against.
    for source in (email.split("@")[0] if email else "", name or ""):
        for part in re.split(r"[^A-Za-z0-9]+", source):
            if len(part) >= 4 and part.lower() in pw.lower():
                problems.append("not contain your name or email address")
                return problems
    return problems


async def breached(pw: str) -> bool:
    """Whether this password appears in the Have I Been Pwned corpus.

    k-anonymity: only the first five characters of the SHA-1 leave this process, and the
    range that comes back is searched here. The password itself, and the rest of its
    hash, never go anywhere.

    FAILS OPEN, deliberately. This is a third party on the far side of a network, and the
    alternative to failing open is that an outage of somebody else's service stops people
    resetting their own passwords. The offline rules have already run by this point, so
    failing open falls back to a policy rather than to nothing.
    """
    if not _enabled("PASSWORD_HIBP"):
        return False
    digest = hashlib.sha1(pw.encode("utf-8")).hexdigest().upper()
    prefix, suffix = digest[:5], digest[5:]
    try:
        async with httpx.AsyncClient(timeout=_HIBP_TIMEOUT) as client:
            # Add-Padding makes every response the same size, so the request cannot be
            # distinguished by its response length either.
            r = await client.get(_HIBP_URL.format(prefix=prefix),
                                 headers={"Add-Padding": "true",
                                          "User-Agent": "supersanity-ticket-platform"})
            if r.status_code != 200:
                return False
            for line in r.text.splitlines():
                found, _, count = line.partition(":")
                if found.strip().upper() == suffix and count.strip() not in ("0", ""):
                    return True
    except Exception:
        return False
    return False


def message(problems: List[str]) -> str:
    """One sentence naming everything that is wrong, in the order the rules are listed."""
    if len(problems) == 1:
        return f"Password must {problems[0]}."
    return "Password must " + ", ".join(problems[:-1]) + f", and {problems[-1]}."


async def validate(pw: str, *, email: str = "", name: str = "") -> Optional[str]:
    """None when acceptable, else the sentence to show the person who typed it."""
    problems = local_problems(pw, email=email, name=name)
    if problems:
        return message(problems)
    if await breached(pw):
        return ("This password has appeared in a known data breach. "
                "Choose one you have not used elsewhere.")
    return None
