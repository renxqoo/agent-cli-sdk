import { describe, expect, it } from "vitest";
import { createContext } from "../context.js";
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
