import { describe, expect, it } from "vitest";
import { createContext } from "../context.js";
import { createFetchAdapter } from "../request.js";
import type {
  AttemptOutcome,
  HttpAdapter,
  Plugin,
  RequestAttemptEvent,
  RequestOptions,
} from "../types.js";

function scriptedAdapter(outcomes: AttemptOutcome[]): HttpAdapter {
  let index = 0;
  return {
    async send<T>(): Promise<AttemptOutcome<T>> {
      const outcome = outcomes[index++];
      if (!outcome) throw new Error("unexpected HTTP attempt");
      return outcome as AttemptOutcome<T>;
    },
  };
}

function response(status: number, data: unknown = {}): AttemptOutcome {
  return { kind: "response", response: { status, data, headers: {} } };
}

describe("RequestExecutor boundary", () => {
  it("preserves class and own toJSON wire results across retries", async () => {
    const bodies: unknown[] = [];
    class Payload {
      value = "original";
      toJSON() {
        return { value: "serialized" };
      }
    }
    const fetcher = async (_url: unknown, init?: RequestInit) => {
      bodies.push(init?.body);
      return new Response("{}", { status: bodies.length % 2 === 1 ? 401 : 200 });
    };
    const ctx = createContext({
      state: {},
      adapter: createFetchAdapter({ baseUrl: "https://api.test", fetch: fetcher as typeof fetch }),
      plugins: [
        {
          name: "retry",
          async handleUnauthorized() {
            return { action: "retry" };
          },
        },
      ],
    });
    await ctx.post("/records", new Payload());
    await ctx.post("/records", { toJSON: () => ({ value: "own" }) });
    await ctx.post("/records", new Date("2026-01-01T00:00:00.000Z"));
    expect(bodies).toEqual([
      '{"value":"serialized"}',
      '{"value":"serialized"}',
      '{"value":"own"}',
      '{"value":"own"}',
      '"2026-01-01T00:00:00.000Z"',
      '"2026-01-01T00:00:00.000Z"',
    ]);
  });

  it("isolates response mutations between observers and from retry decisions", async () => {
    const data = { count: 1 };
    const seen: number[] = [];
    const ctx = createContext({
      state: {},
      adapter: scriptedAdapter([response(200, data)]),
      plugins: [
        {
          name: "mutating-audit",
          async observeRequest(_ctx, event) {
            if (event.outcome.kind === "response") {
              event.outcome.response.status = 401;
              (event.outcome.response.data as { count: number }).count = 999;
            }
          },
        },
        {
          name: "next-audit",
          async observeRequest(_ctx, event) {
            if (event.outcome.kind === "response") seen.push(event.outcome.response.status);
          },
        },
      ],
    });
    await expect(ctx.get("/records")).resolves.toMatchObject({ status: 200, data: { count: 1 } });
    expect(seen).toEqual([200]);
    expect(data).toEqual({ count: 1 });
  });

  it("replays the original body after a preparation hook mutates its private copy", async () => {
    const body = { items: ["original"] };
    const received: unknown[] = [];
    const ctx = createContext({
      state: {},
      adapter: {
        async send<T>(request) {
          received.push(request.body);
          return response(received.length === 1 ? 401 : 200) as AttemptOutcome<T>;
        },
      },
      plugins: [
        {
          name: "prepare",
          async beforeRequest(_ctx, request) {
            (request.body as { items: string[] }).items.push("prepared");
            return request;
          },
          async handleUnauthorized() {
            return { action: "retry" };
          },
        },
      ],
    });
    await ctx.post("/records", body);
    expect(received).toEqual([
      { items: ["original", "prepared"] },
      { items: ["original", "prepared"] },
    ]);
    expect(body).toEqual({ items: ["original"] });
  });

  it("awaits asynchronous observers before resolving the request", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observed = false;
    const plugin: Plugin = {
      name: "audit",
      async observeRequest() {
        await pending;
        observed = true;
      },
    };
    const ctx = createContext({
      state: {},
      adapter: scriptedAdapter([response(200)]),
      plugins: [plugin],
    });

    let settled = false;
    const request = ctx.get("/orders").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(observed).toBe(false);

    release();
    await request;
    expect(observed).toBe(true);
  });

  it("observes a classified HTTP error exactly once as a response", async () => {
    const events: RequestAttemptEvent[] = [];
    const ctx = createContext({
      state: {},
      adapter: scriptedAdapter([response(500, { message: "boom" })]),
      errorOnStatus: { "5xx": "server_error" },
      plugins: [
        {
          name: "audit",
          async observeRequest(_ctx, event) {
            events.push(event);
          },
        },
      ],
    });

    await expect(ctx.get("/orders")).rejects.toMatchObject({
      category: "api",
      subtype: "server_error",
      code: 500,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      attempt: 1,
      outcome: { kind: "response", response: { status: 500 } },
    });
  });

  it("represents a network failure without a synthetic status-zero response", async () => {
    const original = new TypeError("socket closed");
    const events: RequestAttemptEvent[] = [];
    const adapter: HttpAdapter = {
      async send() {
        return { kind: "network-error", error: original };
      },
    };
    const ctx = createContext({
      state: {},
      adapter,
      plugins: [
        {
          name: "audit",
          async observeRequest(_ctx, event) {
            events.push(event);
          },
        },
      ],
    });

    await expect(ctx.get("/orders")).rejects.toMatchObject({ category: "network" });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toEqual({ kind: "network-error", error: original });
  });

  it("re-prepares the original request for one unauthorized retry", async () => {
    const sent: RequestOptions[] = [];
    const events: RequestAttemptEvent[] = [];
    let token = "old";
    const adapter: HttpAdapter = {
      async send<T>(request: Readonly<RequestOptions>): Promise<AttemptOutcome<T>> {
        sent.push(request as RequestOptions);
        return (
          sent.length === 1 ? response(401) : response(200, { ok: true })
        ) as AttemptOutcome<T>;
      },
    };
    const ctx = createContext({
      state: {},
      adapter,
      plugins: [
        {
          name: "auth",
          async beforeRequest(_ctx, request) {
            return {
              ...request,
              headers: { ...request.headers, authorization: `Bearer ${token}` },
            };
          },
          async handleUnauthorized() {
            token = "new";
            return { action: "retry" };
          },
        },
        {
          name: "audit",
          async observeRequest(_ctx, event) {
            events.push(event);
          },
        },
      ],
    });

    await expect(ctx.get("/orders")).resolves.toMatchObject({ status: 200 });
    expect(sent.map((request) => request.headers?.authorization)).toEqual([
      "Bearer old",
      "Bearer new",
    ]);
    expect(
      events.map((event) => event.outcome.kind === "response" && event.outcome.response.status),
    ).toEqual([401, 200]);
  });
});
