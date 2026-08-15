import { describe, expect, it, vi } from "vitest";
import {
  handleError,
  observeError,
  beforeRequest,
  runBeforeCommand,
  sortPlugins,
  transformOutput,
} from "../plugin.js";
import type { Plugin, RequestOptions } from "../types.js";
import { createTestCtx } from "../test-utils.js";
import { APIError, NetworkError } from "../errs/index.js";

describe("plugin ordering", () => {
  it("runs pre, normal, post while preserving registration order within a tier", async () => {
    const calls: string[] = [];
    const plugin = (name: string, enforce?: Plugin["enforce"]): Plugin => ({
      name,
      enforce,
      async beforeCommand() {
        calls.push(name);
      },
    });
    const plugins = [
      plugin("post", "post"),
      plugin("normal-1"),
      plugin("pre-1", "pre"),
      plugin("normal-2", "normal"),
      plugin("pre-2", "pre"),
    ];

    expect(sortPlugins(plugins).map(({ name }) => name)).toEqual([
      "pre-1",
      "pre-2",
      "normal-1",
      "normal-2",
      "post",
    ]);
    await runBeforeCommand(plugins, createTestCtx(), ["test"]);
    expect(calls).toEqual(["pre-1", "pre-2", "normal-1", "normal-2", "post"]);
  });
});

describe("plugin data boundaries", () => {
  it("rebuilds a request without mutating the logical input", async () => {
    const logical: RequestOptions = { method: "GET", path: "/orders", headers: {} };
    const addHeader: Plugin = {
      name: "add-header",
      async beforeRequest(_ctx, request) {
        return { ...request, headers: { ...request.headers, "x-client": "rxcli" } };
      },
    };

    const prepared = await beforeRequest([addHeader], createTestCtx(), logical);

    expect(prepared.headers).toEqual({ "x-client": "rxcli" });
    expect(logical.headers).toEqual({});
  });

  it("chains structured output transforms", async () => {
    const plugins: Plugin[] = [
      {
        name: "first",
        async transformOutput(_ctx, data) {
          return { ...(data as object), first: true };
        },
      },
      {
        name: "second",
        async transformOutput(_ctx, data) {
          return { ...(data as object), second: true };
        },
      },
    ];

    await expect(transformOutput(plugins, createTestCtx(), { base: true })).resolves.toEqual({
      base: true,
      first: true,
      second: true,
    });
  });
});

describe("plugin error boundaries", () => {
  it("warns when an observer fails and preserves the business error", async () => {
    const ctx = createTestCtx();
    const warn = vi.spyOn(ctx.log, "warn");
    const original = new APIError({ subtype: "server_error", message: "failed" });

    await observeError(
      [
        {
          name: "broken",
          async observeError() {
            throw new Error("observer crashed");
          },
        },
      ],
      ctx,
      original,
    );

    expect(warn).toHaveBeenCalledWith("observeError hook failed: observer crashed");
    await expect(handleError([], ctx, original)).resolves.toEqual({
      action: "pass",
      error: original,
    });
  });

  it("passes replaced errors through the remaining handler chain", async () => {
    const seen: unknown[] = [];
    const original = new NetworkError({ subtype: "timeout", message: "timeout" });
    const plugins: Plugin[] = [
      {
        name: "replace",
        async handleError() {
          return {
            action: "replace",
            error: new APIError({ subtype: "server_error", message: "fallback" }),
          };
        },
      },
      {
        name: "inspect",
        async handleError(_ctx, error) {
          seen.push(error);
          return { action: "pass" };
        },
      },
    ];

    const decision = await handleError(plugins, createTestCtx(), original);

    expect(seen[0]).toBeInstanceOf(APIError);
    expect(decision).toMatchObject({ action: "pass", error: { subtype: "server_error" } });
  });
});
