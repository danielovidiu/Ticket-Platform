/**
 * The reset page's gate.
 *
 * The page used to accept a single field with a `length < 8` check and post it. The
 * submit is now held until the mirrored rules pass AND the retype matches, because on
 * this page a typo is unusually expensive: the link is single-use, so a mistyped password
 * costs the account both the password and the way back to it.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ResetPassword from "./ResetPassword";

vi.mock("../api", () => ({ http: { post: vi.fn(() => Promise.resolve({ data: {} })) } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { http } from "../api";
import { toast } from "sonner";

const draw = (token = "a-token") =>
  render(
    <MemoryRouter initialEntries={[`/reset-password?token=${token}`]}>
      <Routes><Route path="/reset-password" element={<ResetPassword />} /></Routes>
    </MemoryRouter>
  );

const submit = () => screen.getByTestId("reset-submit");
const pw = () => screen.getByTestId("reset-password");
const confirm = () => screen.getByTestId("reset-password-confirm");

describe("without a token", () => {
  test("it says the link is invalid and offers no form", () => {
    render(
      <MemoryRouter initialEntries={["/reset-password"]}>
        <Routes><Route path="/reset-password" element={<ResetPassword />} /></Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/Link invalid/i)).toBeInTheDocument();
    expect(screen.queryByTestId("reset-password")).not.toBeInTheDocument();
  });
});

describe("the submit gate", () => {
  test("it starts disabled", () => {
    draw();
    expect(submit()).toBeDisabled();
  });

  test("a valid password alone is not enough — the retype has to match", async () => {
    draw();
    await userEvent.type(pw(), "Correct-Horse-9!");
    expect(submit()).toBeDisabled();

    await userEvent.type(confirm(), "Correct-Horse-8!");
    expect(submit()).toBeDisabled();
  });

  test("a matching retype of a valid password opens it", async () => {
    draw();
    await userEvent.type(pw(), "Correct-Horse-9!");
    await userEvent.type(confirm(), "Correct-Horse-9!");
    expect(submit()).toBeEnabled();
  });

  test("a matching retype of a WEAK password does not", async () => {
    // Two identical copies of a bad password is still a bad password.
    draw();
    await userEvent.type(pw(), "password");
    await userEvent.type(confirm(), "password");
    expect(submit()).toBeDisabled();
  });

  test("a common password is held back even when it satisfies composition", async () => {
    draw();
    await userEvent.type(pw(), "P@ssw0rd123!");
    await userEvent.type(confirm(), "P@ssw0rd123!");
    expect(submit()).toBeDisabled();
  });
});

describe("submitting", () => {
  test("it posts the token and the new password", async () => {
    draw("tok-123");
    await userEvent.type(pw(), "Correct-Horse-9!");
    await userEvent.type(confirm(), "Correct-Horse-9!");
    await userEvent.click(submit());
    await waitFor(() => expect(http.post).toHaveBeenCalledWith(
      "/auth/reset-password", { token: "tok-123", new_password: "Correct-Horse-9!" }));
  });

  test("a server refusal is shown, because the client is not the authority", async () => {
    // The breach lookup needs a network call the client cannot make, so a password can
    // tick every box here and still come back refused.
    http.post.mockRejectedValueOnce({
      response: { data: { detail: "This password has appeared in a known data breach." } } });
    draw();
    await userEvent.type(pw(), "Correct-Horse-9!");
    await userEvent.type(confirm(), "Correct-Horse-9!");
    await userEvent.click(submit());
    await waitFor(() => expect(toast.error)
      .toHaveBeenCalledWith("This password has appeared in a known data breach."));
  });
});
