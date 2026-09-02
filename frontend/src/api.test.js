/**
 * The failure path, which had no coverage because it had no behaviour: before this,
 * nothing in the frontend read an HTTP status at all, and every rejection reached its
 * call site as an opaque axios error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a) => toastError(...a) } }));

/** A fresh module per test: the redirect guard is module-level state, and one expired
 *  session is deliberately one redirect for the life of the page. */
async function freshApi() {
  vi.resetModules();
  return import("./api");
}

/** What axios hands an interceptor when a server answers with a status. */
const failure = (status, data, url = "/admin/cms/pages/p1") => ({
  isAxiosError: true,
  config: { url },
  response: { status, data },
});

describe("errorText", () => {
  let errorText;
  beforeEach(async () => { ({ errorText } = await freshApi()); });

  it("prefers the server's own words", () => {
    expect(errorText(failure(413, { detail: "This page is 300 KB; the limit is 256 KB" })))
      .toBe("This page is 300 KB; the limit is 256 KB");
  });

  it("reads FastAPI's validation shape, which is a list and not a string", () => {
    // The bug this covers: every hand-rolled `typeof detail === "string"` check in the
    // codebase falls through to its generic fallback on exactly this payload.
    const err = failure(422, { detail: [{ loc: ["body", "nav_size"], msg: "Input should be a valid integer" }] });
    expect(errorText(err)).toBe("nav_size: Input should be a valid integer");
  });

  it("names the status when the server sent no detail", () => {
    expect(errorText(failure(401, {}))).toBe("Your session expired");
    expect(errorText(failure(403, {}))).toBe("You do not have permission to do that");
  });

  it("distinguishes a refusal from an unreachable server", () => {
    expect(errorText({ isAxiosError: true, config: {}, request: {} })).toBe("Could not reach the server");
  });

  it("always returns something a caller can display", () => {
    expect(errorText(failure(500, {}), "Could not save")).toBe("Could not save (HTTP 500)");
    expect(errorText(null, "Could not save")).toBe("Could not save");
  });
});

describe("the 401 interceptor", () => {
  beforeEach(() => { toastError.mockClear(); });

  /** Rejects every request with `err`, so the real interceptor chain runs. */
  const rejectWith = (http, err) => { http.defaults.adapter = () => Promise.reject(err); };

  it("attaches the server's reason to every rejection", async () => {
    const { http } = await freshApi();
    rejectWith(http, failure(413, { detail: "This page is 300 KB; the limit is 256 KB" }));
    await expect(http.patch("/admin/cms/pages/p1")).rejects.toMatchObject({
      detail: "This page is 300 KB; the limit is 256 KB",
    });
  });

  it("re-authenticates on a 401 from a real call", async () => {
    const { http } = await freshApi();
    rejectWith(http, failure(401, { detail: "Session expired" }));
    await expect(http.patch("/admin/cms/pages/p1")).rejects.toBeTruthy();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("ignores the 401 every anonymous visitor's boot probe produces", async () => {
    // AuthProvider calls /auth/me on every page load, signed in or not. Treating that
    // one as an expired session would send every first-time visitor to /login.
    const { http } = await freshApi();
    rejectWith(http, failure(401, { detail: "Not authenticated" }, "/auth/me"));
    await expect(http.get("/auth/me")).rejects.toBeTruthy();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not navigate away from work that exists nowhere else", async () => {
    // The CMS draft lives in the tab. An expired session already makes it unsaveable;
    // a redirect would take the last copy of it too. beforeunload does not catch this —
    // Chrome only raises that dialog for a navigation it attributes to the person.
    const { http, setUnsavedWorkGuard } = await freshApi();
    setUnsavedWorkGuard(() => true);
    rejectWith(http, failure(401, {}));
    await expect(http.patch("/admin/cms/pages/p1")).rejects.toBeTruthy();

    expect(toastError).toHaveBeenCalledTimes(1);
    const [, opts] = toastError.mock.calls[0];
    expect(opts.duration).toBe(Infinity);        // it waits for them, not the other way round
    expect(opts.action.label).toBe("Sign in");   // and leaves the decision where it belongs
  });

  it("moves along when nothing is at risk", async () => {
    const { http, setUnsavedWorkGuard } = await freshApi();
    setUnsavedWorkGuard(() => false);
    rejectWith(http, failure(401, {}));
    await expect(http.get("/admin/cms/pages")).rejects.toBeTruthy();
    expect(toastError.mock.calls[0][1]).toBeUndefined();  // no action: it navigates itself
  });

  it("treats a guard that throws as nothing at risk", async () => {
    const { http, setUnsavedWorkGuard } = await freshApi();
    setUnsavedWorkGuard(() => { throw new Error("unmounting"); });
    rejectWith(http, failure(401, {}));
    await expect(http.patch("/admin/cms/pages/p1")).rejects.toBeTruthy();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("redirects once, however many savers fail at the same moment", async () => {
    // The CMS has five independent savers; one expired session is one message.
    const { http } = await freshApi();
    rejectWith(http, failure(401, {}));
    await Promise.allSettled([
      http.patch("/admin/cms/pages/p1"),
      http.patch("/admin/cms/theme"),
      http.put("/admin/cms/site"),
    ]);
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
