import { describe, expect, it, vi } from "vitest";
import { createContext } from "../context.js";
import type { HttpAdapter, Plugin } from "../types.js";

function brokenObserver(): Plugin {
  return {
    name: "broken-observer",
    async observeRequest() {
      throw new Error("observer crashed");
    },
  };
}

describe("request observer isolation", () => {
  it("awaits and isolates observers while preserving a classified network failure", async () => {
    const original = new Error("request failed");
    const warn = vi.fn();
    const adapter: HttpAdapter = {
      async send() {
        return { kind: "network-error", error: original };
      },
    };
    const ctx = createContext({
      state: {},
      plugins: [brokenObserver()],
      log: { info: vi.fn(), warn, error: vi.fn() },
      adapter,
    });

    await expect(ctx.get("/orders")).rejects.toMatchObject({
      category: "network",
      subtype: "connection_refused",
      cause: original,
    });
    expect(warn).toHaveBeenCalledWith("observeRequest hook failed: observer crashed");
  });

  it("does not turn a successful request into a failure", async () => {
    const ctx = createContext({
      state: {},
      plugins: [brokenObserver()],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      adapter: {
        async send<T>() {
          return {
            kind: "response" as const,
            response: { status: 200, data: { ok: true } as T, headers: {} },
          };
        },
      },
    });

    await expect(ctx.get("/orders")).resolves.toMatchObject({ status: 200 });
  });
});
