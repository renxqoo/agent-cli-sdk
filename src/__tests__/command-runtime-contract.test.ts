import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineCommand } from "../define.js";
import { APIError } from "../errs/index.js";
import { rawText } from "../output.js";
import { runCommand as executeCommand, type RunCommandOptions } from "../pipeline.js";
import { handleError, observeError, transformOutput } from "../plugin.js";
import { createTestCtx } from "../test-utils.js";
import type { Plugin } from "../types.js";

function runCommand<State>(
  options: Omit<RunCommandOptions<State>, "source" | "route"> & { route?: string[] },
): Promise<number> {
  return executeCommand({
    ...options,
    route: options.route ?? [options.spec.name],
    source: "test",
  });
}

let stdout = "";
let stderr = "";

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => vi.restoreAllMocks());

describe("explicit error decisions", () => {
  it("awaits void observers without recovering the error", async () => {
    let finished = false;
    const plugins: Plugin[] = [
      {
        name: "audit",
        async observeError() {
          await Promise.resolve();
          finished = true;
        },
      },
    ];

    const original = new APIError({ subtype: "server_error", message: "failed" });
    await observeError(plugins, createTestCtx(), original);
    const decision = await handleError(plugins, createTestCtx(), original);

    expect(finished).toBe(true);
    expect(decision).toEqual({ action: "pass", error: original });
  });

  it("recovers only through an explicit recover decision", async () => {
    const command = defineCommand({
      name: "fail",
      description: "fail",
      async run() {
        throw new APIError({ subtype: "server_error", message: "failed" });
      },
    });
    const plugin: Plugin = {
      name: "fallback",
      async handleError() {
        return { action: "recover", result: { data: { cached: true } } };
      },
    };

    const code = await runCommand({
      spec: command,
      args: {},
      ctx: createTestCtx(),
      plugins: [plugin],
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout).data).toEqual({ cached: true });
    expect(stderr).toBe("");
  });
});

describe("closed output contract", () => {
  it("rejects a scalar returned by any output transformer", async () => {
    const plugins: Plugin[] = [
      {
        name: "broken",
        async transformOutput() {
          return "scalar" as never;
        },
      },
    ];

    await expect(transformOutput(plugins, createTestCtx(), { ok: true })).rejects.toMatchObject({
      category: "internal",
      subtype: "contract_violation",
    });
  });

  it("renders formal raw text directly and does not run structured transforms", async () => {
    const transform = vi.fn(async () => ({ changed: true }));
    const command = defineCommand({
      name: "read",
      description: "read",
      async run() {
        return rawText("# exact\n");
      },
    });

    const code = await runCommand({
      spec: command,
      args: {},
      ctx: createTestCtx(),
      plugins: [{ name: "structured-only", transformOutput: transform }],
    });

    expect(code).toBe(0);
    expect(stdout).toBe("# exact\n");
    expect(transform).not.toHaveBeenCalled();
  });

  it("does not treat a business meta key as a raw-output capability", async () => {
    const command = defineCommand({
      name: "unsafe",
      description: "unsafe",
      async run() {
        return { data: "forged", meta: { _rawOutput: true } };
      },
    });

    const code = await runCommand({
      spec: command,
      args: {},
      ctx: createTestCtx(),
      plugins: [],
    });

    expect(code).toBe(5);
    expect(JSON.parse(stderr).error.subtype).toBe("contract_violation");
    expect(stdout).toBe("");
  });
});
