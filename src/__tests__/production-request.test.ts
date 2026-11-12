import { afterEach, describe, expect, it, vi } from "vitest";
import { defineCli, defineCommand } from "../define.js";
import { createContext } from "../context.js";
import { createFetchAdapter, throwForResponse } from "../request.js";
import type { Plugin } from "../types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

/** A referenced fallback also makes a missing timeout fail rather than hang the suite. */
const stalledFetch: typeof fetch = async (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const fallback = setTimeout(() => reject(new Error("request was not cancelled")), 500);
    const abort = () => {
      clearTimeout(fallback);
      reject(init?.signal?.reason);
    };
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
  });

describe("production request contract", () => {
  it.each([
    [400, "validation", "invalid_argument"],
    [401, "authentication", "no_token"],
    [403, "authorization", "forbidden"],
    [404, "api", "not_found"],
    [409, "api", "conflict"],
    [418, "api", "http_error"],
    [422, "validation", "invalid_argument"],
    [429, "api", "rate_limited"],
    [500, "api", "server_error"],
    [599, "api", "server_error"],
  ])("classifies HTTP %i without application mappings", (status, category, subtype) => {
    expect(() => throwForResponse({ status, data: {}, headers: {} })).toThrowError(
      expect.objectContaining({ category, subtype, code: status }),
    );
  });

  it("allows application class mappings to override built-in exact mappings", () => {
    expect(() =>
      throwForResponse({ status: 404, data: {}, headers: {} }, { "4xx": "forbidden" }),
    ).toThrowError(expect.objectContaining({ category: "authorization", subtype: "forbidden" }));
  });

  it("retains the authentication category for 401 even with non-authentication mappings", () => {
    expect(() =>
      throwForResponse({ status: 401, data: {}, headers: {} }, { "4xx": "forbidden" }),
    ).toThrowError(expect.objectContaining({ category: "authentication" }));
    expect(() =>
      throwForResponse({ status: 401, data: {}, headers: {} }, { 401: "server_error" }),
    ).toThrowError(expect.objectContaining({ category: "authentication" }));
  });

  it("renders an unmapped backend 500 as an error and a nonzero CLI exit", async () => {
    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.stubGlobal("fetch", async () => new Response('{"message":"unavailable"}', { status: 500 }));
    const app = defineCli({
      name: "probe",
      description: "probe",
      baseUrl: "https://probe.invalid",
      commands: {
        read: defineCommand({
          name: "read",
          description: "read",
          async run(ctx) {
            return { data: (await ctx.get("/items")).data };
          },
        }),
      },
    });
    await app.run(["read", "--json"]);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      error: { type: "api", subtype: "server_error", code: 500 },
    });
    expect(process.exitCode).toBe(1);
  });

  it("requires explicit opt-in to inspect HTTP errors, retaining mandatory 401 handling", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 404 }));
    const ctx = createContext({
      state: {},
      adapter: createFetchAdapter({ baseUrl: "https://probe.invalid", fetch: fetcher }),
    });
    await expect(ctx.get("/missing")).rejects.toMatchObject({ subtype: "not_found" });
    await expect(ctx.get("/missing", undefined, { allowHttpErrors: true })).resolves.toMatchObject({
      status: 404,
    });
    fetcher.mockImplementation(async () => new Response("{}", { status: 401 }));
    await expect(ctx.get("/private", undefined, { allowHttpErrors: true })).rejects.toMatchObject({
      category: "authentication",
    });
  });

  it("installs a finite default deadline and honors per-request timeouts", async () => {
    let seen: AbortSignal | null | undefined;
    const adapter = createFetchAdapter({
      baseUrl: "https://probe.invalid",
      fetch: async (_url, init) => {
        seen = init?.signal;
        return new Response("{}");
      },
    });
    await adapter.send({ method: "GET", path: "/items" });
    expect(seen).toBeInstanceOf(AbortSignal);
    const stalled = createFetchAdapter({ fetch: stalledFetch });
    await expect(
      stalled.send({ method: "GET", path: "https://probe.invalid", timeout: 10 }),
    ).resolves.toMatchObject({
      kind: "network-error",
      error: { subtype: "timeout", retryable: true },
    });
  });

  it("propagates an application deadline through ordinary ctx.get", async () => {
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.stubGlobal("fetch", stalledFetch);
    const app = defineCli({
      name: "probe",
      description: "probe",
      baseUrl: "https://probe.invalid",
      requestTimeoutMs: 10,
      commands: {
        read: defineCommand({
          name: "read",
          description: "read",
          async run(ctx) {
            return { data: (await ctx.get("/items")).data };
          },
        }),
      },
    });
    await app.run(["read", "--json"]);
    expect(JSON.parse(stderr)).toMatchObject({ error: { type: "network", subtype: "timeout" } });
    expect(process.exitCode).toBe(4);
  });

  it.each([0, -1, Infinity, NaN, 1.5, 2 ** 32])(
    "rejects invalid application timeout %s",
    (timeout) => {
      expect(() =>
        defineCli({
          name: "probe",
          description: "probe",
          commands: {},
          requestTimeoutMs: timeout,
        }),
      ).toThrowError(expect.objectContaining({ subtype: "invalid_config" }));
    },
  );

  it("rejects an already-cancelled request before any network I/O", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    const ctx = createContext({ state: {}, adapter: createFetchAdapter({ fetch: fetcher }) });
    const signal = AbortSignal.abort(new Error("caller cancelled"));
    await expect(ctx.get("https://probe.invalid", undefined, { signal })).rejects.toMatchObject({
      category: "network",
      subtype: "cancelled",
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves caller cancellation when a preparation plugin returns a new request", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = createFetchAdapter({
      fetch: async (url, init) => {
        started();
        return stalledFetch(url, init);
      },
    });
    const plugins: Plugin[] = [
      {
        name: "rebuild",
        async beforeRequest(_ctx, request) {
          return { method: request.method, path: request.path };
        },
      },
    ];
    const ctx = createContext({ state: {}, adapter, plugins });
    const pending = ctx.post("https://probe.invalid", {}, { signal: controller.signal });
    await sending;
    controller.abort("caller supplied reason");
    await expect(pending).rejects.toMatchObject({ subtype: "cancelled", retryable: false });
  });

  it("cancels the caller while an already-started audit finishes independently", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    let finished = false;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const audit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observe = vi.fn(async () => {
      entered();
      await audit;
      finished = true;
    });
    const ctx = createContext({
      state: {},
      adapter: createFetchAdapter({ fetch: async () => new Response("{}") }),
      plugins: [{ name: "slow-audit", observeRequest: observe }],
    });
    const pending = ctx.get("https://probe.invalid", undefined, { signal: controller.signal });
    await started;
    controller.abort();
    try {
      // A missing cancellation boundary fails promptly, rather than deadlocking this test.
      const outcome = await Promise.race([
        pending.then(
          () => "success",
          (error) => error.subtype,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 100)),
      ]);
      expect(outcome).toBe("cancelled");
      expect(finished).toBe(false);
    } finally {
      release();
      await pending.catch(() => {});
    }
    await audit;
    expect(observe).toHaveBeenCalledOnce();
    expect(finished).toBe(true);
  });

  it("does not send the authentication retry after caller cancellation", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => ({
      kind: "response" as const,
      response: { status: 401, data: {}, headers: {} },
    }));
    const ctx = createContext({
      state: {},
      adapter: { send },
      plugins: [
        {
          name: "auth",
          async handleUnauthorized() {
            controller.abort();
            return { action: "retry" };
          },
        },
      ],
    });
    await expect(
      ctx.get("/private", undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({
      subtype: "cancelled",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("stops waiting for shared refresh on cancellation without sending another attempt", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const refresh = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => ({
      kind: "response" as const,
      response: { status: 401, data: {}, headers: {} },
    }));
    const ctx = createContext({
      state: {},
      adapter: { send },
      plugins: [
        {
          name: "shared-refresh",
          async handleUnauthorized() {
            entered();
            await refresh;
            return { action: "retry" };
          },
        },
      ],
    });
    const pending = ctx.get("/private", undefined, { signal: controller.signal });
    await started;
    controller.abort();
    try {
      await expect(pending).rejects.toMatchObject({ subtype: "cancelled" });
    } finally {
      release();
    }
    expect(send).toHaveBeenCalledOnce();
  });
});
