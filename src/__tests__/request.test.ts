import { describe, expect, it, vi } from "vitest";
import {
  APIError,
  AuthenticationError,
  ConfigError,
  ConfirmationRequiredError,
  InternalError,
  NetworkError,
  PermissionError,
  PolicyError,
  ValidationError,
} from "../errs/index.js";
import { createFetchAdapter, throwForResponse } from "../request.js";

function response(status: number, data: unknown = {}, headers: Record<string, string> = {}) {
  return { status, data, headers };
}

describe("FetchAdapter single-attempt port", () => {
  it("sends one request with merged headers, query, JSON body, and parsed response", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "x-request-id": "r1" },
        }),
    );
    const adapter = createFetchAdapter({
      baseUrl: "https://api.example.test",
      defaultHeaders: { Authorization: "Bearer default", "x-client": "sdk" },
      fetch: fetch as typeof globalThis.fetch,
    });

    const outcome = await adapter.send({
      method: "POST",
      path: "/items?fixed=1",
      query: { page: 2, tag: ["a", "b"] },
      headers: { authorization: "Bearer request" },
      body: { name: "item" },
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/items?fixed=1&page=2&tag=a&tag=b",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "item" }),
      headers: {
        authorization: "Bearer request",
        "x-client": "sdk",
        "content-type": "application/json",
      },
    });
    expect(outcome).toMatchObject({
      kind: "response",
      response: { status: 200, data: { ok: true }, headers: { "x-request-id": "r1" } },
    });
  });

  it("keeps absolute URLs and returns a discriminated network failure", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const adapter = createFetchAdapter({
      baseUrl: "https://ignored.test",
      fetch: fetch as typeof globalThis.fetch,
    });

    const outcome = await adapter.send({ method: "GET", path: "https://other.test/data" });

    expect(fetch.mock.calls[0]?.[0]).toBe("https://other.test/data");
    expect(outcome.kind).toBe("network-error");
    if (outcome.kind === "network-error") {
      expect(outcome.error).toBeInstanceOf(NetworkError);
      expect(outcome.error).toMatchObject({ subtype: "connection_refused", retryable: true });
    }
  });

  it("rejects a non-serializable request body as a caller contract violation", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const adapter = createFetchAdapter({ fetch: vi.fn() as typeof globalThis.fetch });

    await expect(
      adapter.send({ method: "POST", path: "/items", body: circular }),
    ).rejects.toMatchObject({ category: "internal", subtype: "contract_violation" });
  });
});

describe("final HTTP response classification", () => {
  it.each([
    [400, "invalid_argument", ValidationError],
    [401, "no_token", AuthenticationError],
    [403, "forbidden", PermissionError],
    [550, "missing_config", ConfigError],
    [408, "timeout", NetworkError],
    [404, "not_found", APIError],
    [451, "content_blocked", PolicyError],
    [500, "decode_failure", InternalError],
    [422, "high_risk_write", ConfirmationRequiredError],
  ] as const)("maps HTTP %i / %s to its registered category", (status, subtype, Constructor) => {
    expect(() => throwForResponse(response(status), { [status]: subtype })).toThrow(Constructor);
  });

  it("prefers an exact status over a class wildcard regardless of declaration order", () => {
    expect(() =>
      throwForResponse(response(503), { "5xx": "server_error", 503: "rate_limited" }),
    ).toThrowError(expect.objectContaining({ subtype: "rate_limited" }));
  });

  it("uses the class wildcard when no exact mapping exists", () => {
    expect(() => throwForResponse(response(502), { "5xx": "server_error" })).toThrowError(
      expect.objectContaining({ subtype: "server_error" }),
    );
  });

  it("always classifies an otherwise-unmapped 401 as authentication failure", () => {
    expect(() => throwForResponse(response(401, { message: "expired" }))).toThrowError(
      expect.objectContaining({ category: "authentication", subtype: "no_token", code: 401 }),
    );
  });
});
