import { describe, expect, it } from "vitest";
import { evaluateCallbackRequest } from "../infra/callback-server.js";

describe("OAuth callback request boundary", () => {
  it("ignores unrelated requests without completing the login", () => {
    const outcome = evaluateCallbackRequest("GET", "/favicon.ico", "expected");

    expect(outcome.status).toBe(404);
    expect(outcome.result).toBeUndefined();
    expect(outcome.html).not.toContain("Login successful");
  });

  it("renders failure and rejects a state mismatch at the listener boundary", () => {
    const outcome = evaluateCallbackRequest(
      "GET",
      "/callback?code=secret&state=attacker",
      "expected",
    );

    expect(outcome.status).toBe(400);
    expect(outcome.result).toEqual({ kind: "error", error: "state_mismatch" });
    expect(outcome.html).toContain("Login failed");
    expect(outcome.html).not.toContain("secret");
  });

  it("renders the provider error as failure", () => {
    const outcome = evaluateCallbackRequest(
      "GET",
      "/callback?error=access_denied&state=expected",
      "expected",
    );

    expect(outcome.status).toBe(400);
    expect(outcome.result).toEqual({ kind: "error", error: "access_denied" });
    expect(outcome.html).toContain("Login failed");
  });

  it("returns a closed success variant only for a valid callback", () => {
    const outcome = evaluateCallbackRequest(
      "GET",
      "/callback?code=code-1&state=expected",
      "expected",
    );

    expect(outcome.status).toBe(200);
    expect(outcome.result).toEqual({ kind: "success", code: "code-1" });
    expect(outcome.html).toContain("Login successful");
  });
});
