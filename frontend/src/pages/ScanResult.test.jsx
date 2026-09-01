/**
 * The verdict overlay at the door.
 *
 * This is the first frontend test in the project — until now every one of the 400-odd
 * tests was a backend HTTP test, and the UI had none. Started here because this is the
 * screen where a wrong render has a person standing in front of it: DENY ENTRY is
 * irreversible from the door's side, so which verdicts offer it, and what happens between
 * pressing it and the denial landing, are worth pinning.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ScanResult } from "./Scan";

const VALID = { valid: true, event: { title: "OBSIDIAN" } };
const INVALID = { valid: false, reason: "TICKET ALREADY USED" };
const DENIED = { valid: false, denied: true, ticket: { deny_reason: "NO ID" } };

const setup = (result, onDeny = vi.fn().mockResolvedValue({})) => {
  const onNext = vi.fn();
  render(<ScanResult result={result} onNext={onNext} onDeny={onDeny} />);
  return { onNext, onDeny, user: userEvent.setup() };
};

describe("which verdicts offer a denial", () => {
  test("a valid scan offers DENY ENTRY", () => {
    setup(VALID);
    expect(screen.getByText("VALID")).toBeVisible();
    expect(screen.getByTestId("deny-entry")).toBeVisible();
  });

  test("an invalid scan does not — there is no admission to reverse", () => {
    setup(INVALID);
    expect(screen.getByText("INVALID")).toBeVisible();
    expect(screen.queryByTestId("deny-entry")).not.toBeInTheDocument();
  });

  test("an already-denied ticket does not offer it again", () => {
    setup(DENIED);
    expect(screen.getByText("DENIED")).toBeVisible();
    expect(screen.queryByTestId("deny-entry")).not.toBeInTheDocument();
  });

  test("an offline scan does not, because the denial could not be recorded", () => {
    // The scan itself queues and syncs later; a denial cannot, so offering the button
    // would let staff believe they had refused someone when nothing was written.
    setup({ ...VALID, offline: true });
    expect(screen.getByText(/QUEUED/)).toBeVisible();
    expect(screen.queryByTestId("deny-entry")).not.toBeInTheDocument();
  });
});

describe("the denial takes a deliberate second step", () => {
  test("pressing DENY ENTRY asks rather than denying", async () => {
    const { onDeny, user } = setup(VALID);
    await user.click(screen.getByTestId("deny-entry"));

    expect(screen.getByTestId("deny-panel")).toBeVisible();
    expect(onDeny).not.toHaveBeenCalled();
  });

  test("NEXT TICKET is hidden while confirming, so it cannot be hit by accident", async () => {
    const { user } = setup(VALID);
    await user.click(screen.getByTestId("deny-entry"));
    expect(screen.queryByTestId("next-ticket")).not.toBeInTheDocument();
  });

  test("KEEP ADMITTED backs out without denying", async () => {
    const { onDeny, user } = setup(VALID);
    await user.click(screen.getByTestId("deny-entry"));
    await user.click(screen.getByTestId("deny-cancel"));

    expect(screen.queryByTestId("deny-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("next-ticket")).toBeVisible();
    expect(onDeny).not.toHaveBeenCalled();
  });

  test("confirming sends the typed reason, trimmed", async () => {
    const { onDeny, user } = setup(VALID);
    await user.click(screen.getByTestId("deny-entry"));
    await user.type(screen.getByTestId("deny-reason"), "  no id  ");
    await user.click(screen.getByTestId("deny-confirm"));

    expect(onDeny).toHaveBeenCalledWith("no id");
  });

  test("a reason is optional", async () => {
    const { onDeny, user } = setup(VALID);
    await user.click(screen.getByTestId("deny-entry"));
    await user.click(screen.getByTestId("deny-confirm"));

    expect(onDeny).toHaveBeenCalledWith("");
  });
});

describe("when the denial does not land", () => {
  test("the error is shown and the panel stays open", async () => {
    const onDeny = vi.fn().mockResolvedValue({ error: "NO CONNECTION — DENIAL NOT RECORDED" });
    const { user } = setup(VALID, onDeny);

    await user.click(screen.getByTestId("deny-entry"));
    await user.click(screen.getByTestId("deny-confirm"));

    expect(await screen.findByTestId("deny-error")).toHaveTextContent("NOT RECORDED");
    // Staying open is the point: closing on failure would read as success.
    expect(screen.getByTestId("deny-panel")).toBeVisible();
  });

  test("the buttons are disabled while it is in flight", async () => {
    let release;
    const onDeny = vi.fn(() => new Promise((res) => { release = res; }));
    const { user } = setup(VALID, onDeny);

    await user.click(screen.getByTestId("deny-entry"));
    await user.click(screen.getByTestId("deny-confirm"));

    // Double-submitting a denial at the door is exactly the mistake to design out.
    expect(screen.getByTestId("deny-confirm")).toBeDisabled();
    expect(screen.getByTestId("deny-cancel")).toBeDisabled();
    expect(screen.getByTestId("deny-confirm")).toHaveTextContent("DENYING…");

    release({});
    expect(await screen.findByTestId("next-ticket")).toBeVisible();
  });
});

describe("the ordinary path is untouched", () => {
  // One case per test so each gets its own render and RTL's own cleanup — looping
  // inside a single test stacks three overlays in the same document and every
  // getByTestId then finds three of everything.
  test.each([["valid", VALID], ["invalid", INVALID], ["denied", DENIED]])(
    "NEXT TICKET is the primary action on a %s verdict",
    async (_label, result) => {
      const { onNext, user } = setup(result);
      await user.click(screen.getByTestId("next-ticket"));
      expect(onNext).toHaveBeenCalled();
    });

  test("a denied verdict shows the reason it was denied for", () => {
    setup(DENIED);
    expect(screen.getByText("NO ID")).toBeVisible();
  });

  test("the overlay announces itself to a screen reader", () => {
    setup(VALID);
    const overlay = screen.getByTestId("scan-result");
    expect(overlay).toHaveAttribute("role", "alertdialog");
    expect(overlay).toHaveAttribute("aria-live", "assertive");
  });
});

/* The access window, and why the screen says which end of it was crossed.
 *
 * A tier can carry one boundary: `access_until` refuses a holder after a moment,
 * `access_from` before one. Neither is a refusal on its own — the guest is standing
 * there holding a ticket they paid for, so the screen states the situation and a person
 * decides. Early and late send that person to different places, one to wait and one to
 * plead, which is why the two are not collapsed into "outside the window".
 */
const at = (h, m) => new Date(2026, 8, 14, h, m, 0).toISOString();
const LATE = {
  valid: false, needs_override: true, edge: "late",
  reason: "ACCESS EXPIRED", access_until: at(23, 30), wave_name: "EARLY BIRD",
};
const EARLY = {
  valid: false, needs_override: true, edge: "early",
  reason: "ACCESS NOT YET OPEN", access_from: at(22, 0), wave_name: "VIP",
};

describe("a ticket outside its tier's access window", () => {
  test("a late arrival says so, and when the tier closed", () => {
    setup(LATE);
    expect(screen.getByText("TOO LATE")).toBeVisible();
    expect(screen.getByText(/EARLY BIRD closed at 23:30/)).toBeVisible();
  });

  test("an early arrival says so, and when the tier opens", () => {
    setup(EARLY);
    expect(screen.getByText("TOO EARLY")).toBeVisible();
    expect(screen.getByText(/VIP opens at 22:00/)).toBeVisible();
  });

  test("both offer the same two-way choice, with neither preselected", () => {
    // The software will not decide this one. Walking away is not an option either —
    // there is no NEXT TICKET here, or the guest would end up neither in nor recorded.
    for (const verdict of [LATE, EARLY]) {
      const { unmount } = render(<ScanResult result={verdict} onNext={vi.fn()} onDeny={vi.fn()} />);
      expect(screen.getByTestId("override-admit")).toBeVisible();
      expect(screen.getByTestId("override-reject")).toBeVisible();
      expect(screen.queryByTestId("next-ticket")).toBeNull();
      unmount();
    }
  });

  test("it is red, the colour that means stop and look at this one", () => {
    // Shares INVALID's red deliberately: at a door, in the dark, the colour has one
    // job. The headline and the two buttons are what tell the two verdicts apart.
    setup(LATE);
    expect(screen.getByTestId("scan-result").className).toMatch(/bg-brand/);
  });

  test("a missing boundary does not render 'Invalid Date' at someone", () => {
    setup({ valid: false, needs_override: true, edge: "late", reason: "ACCESS EXPIRED" });
    expect(screen.getByText("TOO LATE")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Invalid Date/);
  });
});
