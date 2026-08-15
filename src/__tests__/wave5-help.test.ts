/**
 * Wave 5 regression tests — help rendering:
 *   C7 — top-level help groups built-in commands and lists framework flags
 *   C8 — per-command help renders a flag/description table
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as z from "zod";
import { defineCli, defineCommand } from "../index.js";

let stdoutBuf = "";
let stderrBuf = "";
beforeEach(() => {
  stdoutBuf = "";
  stderrBuf = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("C7: top-level help structure", () => {
  it("groups app commands separately from built-in commands and lists framework flags", async () => {
    const app = defineCli({
      name: "demo",
      description: "demo app",
      commands: {
        list: defineCommand({
          name: "list",
          description: "list things",
          async run() {
            return { data: [] };
          },
        }),
      },
    });
    await app.run([]);
    // app command under "Commands:"
    expect(stdoutBuf).toContain("Commands:");
    expect(stdoutBuf).toContain("list things");
    // framework default (qrcode) under a separate "Built-in commands:" group
    expect(stdoutBuf).toContain("Built-in commands:");
    // framework flags are now discoverable
    expect(stdoutBuf).toContain("--json");
    expect(stdoutBuf).toContain("--api-key");
  });
});

describe("C8: per-command help renders flag descriptions", () => {
  it("shows the description for each declared flag", async () => {
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        search: defineCommand({
          name: "search",
          description: "search things",
          args: {
            schema: z.object({
              limit: z.coerce.number().describe("Maximum number of results"),
            }),
          },
          async run() {
            return { data: [] };
          },
        }),
      },
    });
    await app.run(["search", "--help"]);
    expect(process.exitCode).toBe(0);
    expect(stdoutBuf).toContain("Maximum number of results");
  });
});
