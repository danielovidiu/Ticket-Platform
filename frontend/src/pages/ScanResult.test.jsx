/**
 * The verdict overlay at the door.
 *
 * This is the first frontend test in the project — until now every one of the 400-odd
 * tests was a backend HTTP test, and the UI had none. Started here because this is the
 * screen where a wrong render has a person standing in front of it: DENY ENTRY is
 * irreversible from the door's side, so which verdicts offer it, and what happens between
 * pressing it and the denial landing, are worth pinning.
 */
import React from "react";
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
