/**
 * The tier access toggle, and the reason the mode is not read back off the wave.
 *
 * A tier may carry one end of an admission window: `access_until` refuses a holder
 * after a moment, `access_from` before one. Which end the date means is a toggle.
 *
 * Deriving the toggle's position from whichever field holds a value reads well and does
 * not work, which is what most of this file is about. People pick the end before they
 * pick the moment, so on a fresh tier both fields are empty — switching to "from" wrote
 * an empty `access_from`, the next render saw two empty fields, and the toggle snapped
 * back to "until". The control could not be moved until it already had something to
 * hold, which is the wrong way round.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccessWindow } from "./Admin";

const AT = new Date(2026, 8, 30, 23, 0, 0).toISOString();

const setup = (wave = {}) => {
  const onChange = vi.fn();
  render(<AccessWindow wave={wave} onChange={onChange} index={0} />);
  return { onChange, user: userEvent.setup() };
};

const pressed = (which) =>
  screen.getByTestId(`wave-access-${which}-0`).getAttribute("aria-pressed");

describe("which end it opens on", () => {
  test("a blank tier opens on 'until' — a cut-off is the commoner rule", () => {
    setup({});
    expect(pressed("until")).toBe("true");
    expect(pressed("from")).toBe("false");
  });

  test("a tier that carries a 'from' opens on 'from'", () => {
    setup({ access_from: AT });
    expect(pressed("from")).toBe("true");
  });

  test("a tier that carries an 'until' opens on 'until'", () => {
    setup({ access_until: AT });
    expect(pressed("until")).toBe("true");
  });
});

describe("switching ends", () => {
  test("the toggle moves on an empty tier and stays moved", async () => {
    // The regression. Nothing has been typed yet, so there is no value to infer the
    // mode from — and picking the end first is the natural order to do this in.
    const { user } = setup({});
    await user.click(screen.getByTestId("wave-access-from-0"));
    expect(pressed("from")).toBe("true");
    expect(pressed("until")).toBe("false");
  });

  test("switching clears the end being left behind", async () => {
    const { user, onChange } = setup({ access_until: AT });
    await user.click(screen.getByTestId("wave-access-from-0"));
    // Both keys are written in one patch: the server refuses a tier holding both ends,
    // so the old one has to be cleared in the same update that sets the new one.
    expect(onChange).toHaveBeenCalledWith({ access_from: AT, access_until: "" });
  });

  test("the moment survives the switch rather than needing retyping", async () => {
    const { user, onChange } = setup({ access_from: AT });
    await user.click(screen.getByTestId("wave-access-until-0"));
    expect(onChange).toHaveBeenCalledWith({ access_until: AT, access_from: "" });
  });

  test("clicking the end already selected changes nothing", async () => {
    const { user, onChange } = setup({ access_until: AT });
    await user.click(screen.getByTestId("wave-access-until-0"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("the date it writes", () => {
  test("blank reads as no limit at all", () => {
    setup({});
    expect(screen.getByTestId("datetime-trigger").textContent).toMatch(/No limit/);
  });
});
