import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { parseStrictJson } from "../strict-json.js";
import { defineCli, defineCommand } from "../index.js";
import { fileStore } from "../credentials/config-store.js";

const limits = {
  maxBytes: 1024,
  maxDepth: 10,
  maxProperties: 100,
  maxArrayItems: 100,
  maxIssues: 10,
};
const unsafe = [
  "9007199254740993",
  "9007199254740993.0",
  "9007199254740993e0",
  "9007199254740993E0",
  "-9007199254740993.0",
  "-9007199254740993e0",
  "90071992547409930e-1",
  "9.007199254740993e15",
];
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("JSON number precision boundary", () => {
  it.each(unsafe)("rejects unsafe integer %s in the shared parser", (literal) => {
    expect(() => parseStrictJson(`{"id":${literal}}`, limits)).toThrow(/safe integer/);
  });
  it.each(unsafe)("rejects unsafe integer %s before business execution", async (literal) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const run = vi.fn(async () => ({ data: null }));
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        read: defineCommand({
          name: "read",
          description: "read",
          args: { type: "json", schema: z.object({ id: z.number() }) },
          run,
        }),
      },
    });
    await app.run(["read", "--input", `{"id":${literal}}`]);
    expect(process.exitCode).toBe(2);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["9007199254740991.0", Number.MAX_SAFE_INTEGER],
    ["-9007199254740991e0", Number.MIN_SAFE_INTEGER],
    ["123e0", 123],
    ["1.25", 1.25],
    ["1.25e-3", 0.00125],
    ["0e1000", 0],
  ])("accepts supported number %s", (literal, expected) => {
    expect(parseStrictJson(literal as string, limits)).toBe(expected);
  });

  it.each(unsafe)("rejects %s in both file ConfigStore document types", async (literal) => {
    const root = mkdtempSync(join(tmpdir(), "unsafe-json-store-"));
    try {
      for (const directory of ["credentials", "config"]) {
        mkdirSync(join(root, directory));
        writeFileSync(join(root, directory, "app.json"), `{"id":${literal}}`);
      }
      const store = fileStore({ dir: root });
      await expect(store.loadConfig("app")).rejects.toMatchObject({ category: "config" });
      await expect(store.loadCredentials("app")).rejects.toMatchObject({ category: "config" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
