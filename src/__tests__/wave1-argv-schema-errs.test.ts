/**
 * Wave 1 regression tests:
 *   L1 — boolean fields whose flag name starts with `no-` are usable
 *   C1 — a command schema is compiled exactly once
 *   C9 — every thrown subtype literal is registered in SUBTYPE_REGISTRY
 *   L12 — denied/expired auth flows map to `token_expired`, not `token_revoked`
 */
import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { compileCommandSchema, compiledSchemaKey } from "../command-schema.js";
import { defineCommand, defineCli, errs } from "../index.js";
import { SUBTYPE_REGISTRY } from "../errs/index.js";

// ---------------------------------------------------------------------------
// L1: --no-<flag> collision with a boolean field literally named no-cache
// ---------------------------------------------------------------------------

describe("L1: boolean field whose flag name starts with no-", () => {
  const schema = compileCommandSchema("cfg", {
    schema: z.object({ noCache: z.boolean().default(false) }),
  });

  it("sets the field to true via its own --no-cache flag", async () => {
    await expect(schema.resolve(["--no-cache"], Readable.from([]))).resolves.toEqual({
      noCache: true,
    });
  });

  it("still supports standard --no-<x> negation for an unrelated boolean", async () => {
    const withVerbose = compileCommandSchema("cfg2", {
      schema: z.object({ verbose: z.boolean().default(false) }),
    });
    await expect(withVerbose.resolve(["--no-verbose"], Readable.from([]))).resolves.toEqual({
      verbose: false,
    });
  });

  it("rejects an unknown --no-foo when no positive boolean exists", async () => {
    await expect(schema.resolve(["--no-foo"], Readable.from([]))).rejects.toThrow(
      errs.ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// C1: single compile — defineCommand caches; registry reuses the same object
// ---------------------------------------------------------------------------

describe("C1: command schema compiled exactly once", () => {
  it("defineCommand stashes a compiled schema and the registry reuses it", async () => {
    const { getOrCompileSchema } = await import("../command-registry.js");
    const spec = defineCommand({
      name: "once",
      description: "d",
      args: { schema: z.object({ q: z.string() }) },
      async run() {
        return { data: null };
      },
    });
    const compiledAtDefine = (spec as { [compiledSchemaKey]?: unknown })[compiledSchemaKey];
    expect(compiledAtDefine).toBeDefined();
    // The registry's compile path returns the exact same object — no recompute.
    expect(getOrCompileSchema(spec)).toBe(compiledAtDefine);
  });

  it("a raw spec (not from defineCommand) compiles once and is then cached", async () => {
    const { getOrCompileSchema } = await import("../command-registry.js");
    const spec = { name: "raw", description: "d", async run() {} } as never;
    const first = getOrCompileSchema(spec);
    expect(getOrCompileSchema(spec)).toBe(first);
    expect((spec as { [compiledSchemaKey]?: unknown })[compiledSchemaKey]).toBe(first);
  });

  it("defineCli does not recompile a schema already compiled by defineCommand", () => {
    const cmd = defineCommand({
      name: "cached",
      description: "d",
      args: { schema: z.object({ q: z.string() }) },
      async run() {
        return { data: null };
      },
    });
    const before = (cmd as { [compiledSchemaKey]?: unknown })[compiledSchemaKey];
    defineCli({ name: "demo", description: "d", commands: { cached: cmd } });
    const after = (cmd as { [compiledSchemaKey]?: unknown })[compiledSchemaKey];
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// C9: every subtype literal thrown in src/ is registered
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("C9: every thrown subtype literal is registered", () => {
  const literalRe = /subtype:\s*["']([a-z_]+)["']/g;
  const subtypes = new Set<string>();
  for (const file of collectTsFiles(join(process.cwd(), "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(literalRe)) subtypes.add(match[1]!);
  }

  it.each([...subtypes].sort())("subtype %s is registered", (subtype) => {
    expect(SUBTYPE_REGISTRY[subtype]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// L12: denied/expired auth → token_expired (not token_revoked)
// ---------------------------------------------------------------------------

describe("L12: device poll denial maps to token_expired", () => {
  it("device poll failure throws token_expired (not token_revoked)", async () => {
    const { deviceFlow } = await import("../flows/device.js");
    const poller = vi.fn().mockResolvedValue({ status: "error", message: "access_denied" });
    await expect(
      deviceFlow.login({
        type: "device",
        cfg: { baseUrl: "http://t", clientId: "c", clientSecret: "s" },
        scope: "x",
        log: { info: vi.fn() },
        poller,
        resumeDeviceCode: "dc",
      }),
    ).rejects.toMatchObject({ subtype: "token_expired" });
  });
});
