import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { evaluateCallbackRequest, waitForCallback } from "../infra/callback-server.js";
import { authCodeFlow } from "../flows/authCode.js";

describe("OAuth callback request boundary", () => {
  it("reports a busy listening port without an orphaned result rejection", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        waitForCallback({ port, timeoutMs: 1000, expectedState: "state" }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("releases the real listener when opening the browser fails", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      authCodeFlow.login({
        type: "authorization_code",
        cfg: { baseUrl: "https://auth.test", clientId: "app", clientSecret: "" },
        callbackPort: port,
        browser: { open: vi.fn().mockRejectedValue(new Error("browser failed")) },
      }),
    ).rejects.toThrow("browser failed");
    await new Promise((resolve) => setImmediate(resolve));
    server.listen(port, "127.0.0.1");
    try {
      await once(server, "listening");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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
