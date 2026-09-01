/**
 * Choosing a password: the retype, the reveal, and the checklist.
 *
 * The retype is the point of this component. A typo in a masked field is not discovered
 * at the keyboard — it is discovered at the next sign-in, and on the reset page the way
 * back is the link that was just consumed. Before this there was one field and no
 * confirmation on either the reset page or the signup form.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PasswordFields from "./PasswordFields";
import { useState } from "react";

/** A host that holds the state, since the component is controlled. */
function Host({ identity }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  return (
    <PasswordFields value={pw} onChange={setPw} confirm={confirm}
                    onConfirmChange={setConfirm} identity={identity} testId="pw" />
  );
}

const field = () => screen.getByTestId("pw");
const confirmField = () => screen.getByTestId("pw-confirm");
const ruleOk = (id) => screen.getByTestId(`pw-rule-${id}`).getAttribute("data-ok");

describe("the retype", () => {
  test("there are two fields, both masked", () => {
    render(<Host />);
    expect(field()).toHaveAttribute("type", "password");
    expect(confirmField()).toHaveAttribute("type", "password");
  });

  test("a mismatch is called out", async () => {
    render(<Host />);
    await userEvent.type(field(), "Correct-Horse-9!");
    await userEvent.type(confirmField(), "Correct-Horse-8!");
    expect(screen.getByTestId("pw-mismatch")).toBeInTheDocument();
    expect(screen.queryByTestId("pw-matched")).not.toBeInTheDocument();
  });

  test("a match is confirmed", async () => {
    render(<Host />);
    await userEvent.type(field(), "Correct-Horse-9!");
    await userEvent.type(confirmField(), "Correct-Horse-9!");
    expect(screen.getByTestId("pw-matched")).toBeInTheDocument();
    expect(screen.queryByTestId("pw-mismatch")).not.toBeInTheDocument();
  });

  test("an empty retype is not a mismatch", async () => {
    // Telling somebody off for not having finished typing.
    render(<Host />);
    await userEvent.type(field(), "Correct-Horse-9!");
    expect(screen.queryByTestId("pw-mismatch")).not.toBeInTheDocument();
  });
});

describe("the reveal", () => {
  test("it unmasks both fields together", async () => {
    render(<Host />);
    await userEvent.click(screen.getByTestId("pw-toggle"));
    expect(field()).toHaveAttribute("type", "text");
    expect(confirmField()).toHaveAttribute("type", "text");
    await userEvent.click(screen.getByTestId("pw-toggle"));
    expect(field()).toHaveAttribute("type", "password");
  });
});

describe("the checklist", () => {
  test("every rule is listed from the start, so the list does not reflow", () => {
    render(<Host />);
    expect(screen.getByTestId("pw-requirements").children.length).toBe(8);
  });

  test("rules tick as they are satisfied", async () => {
    render(<Host />);
    expect(ruleOk("length")).toBe("no");
    await userEvent.type(field(), "Correct-Horse-9!");
    expect(ruleOk("length")).toBe("yes");
    expect(ruleOk("upper")).toBe("yes");
    expect(ruleOk("digit")).toBe("yes");
    expect(ruleOk("symbol")).toBe("yes");
    expect(ruleOk("uncommon")).toBe("yes");
  });

  test("a common password is flagged even though it satisfies composition", async () => {
    render(<Host />);
    await userEvent.type(field(), "P@ssw0rd123!");
    expect(ruleOk("length")).toBe("yes");
    expect(ruleOk("upper")).toBe("yes");
    expect(ruleOk("symbol")).toBe("yes");
    expect(ruleOk("uncommon")).toBe("no");
  });

  test("it reacts to the identity it is given", async () => {
    render(<Host identity={{ email: "danieltest@example.com" }} />);
    await userEvent.type(field(), "Danieltest-99!");
    expect(ruleOk("notyou")).toBe("no");
  });

  test("the checklist describes the field for screen readers", () => {
    render(<Host />);
    expect(field().getAttribute("aria-describedby"))
      .toBe(screen.getByTestId("pw-requirements").id);
  });
});

describe("password managers", () => {
  test("both fields are marked as a new password", () => {
    render(<Host />);
    expect(field()).toHaveAttribute("autocomplete", "new-password");
    expect(confirmField()).toHaveAttribute("autocomplete", "new-password");
  });

  test("paste is not blocked", async () => {
    // Blocking paste only ever pushes people towards passwords short enough to type
    // twice by hand.
    render(<Host />);
    await userEvent.click(field());
    await userEvent.paste("Correct-Horse-9!");
    expect(field()).toHaveValue("Correct-Horse-9!");
  });
});
