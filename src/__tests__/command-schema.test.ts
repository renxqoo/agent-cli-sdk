import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { compileCommandSchema } from "../command-schema.js";

describe("CompiledCommandSchema boundary", () => {
  const schema = compileCommandSchema("search", {
    schema: z.object({
      query: z.string().describe("search query"),
      limit: z.coerce.number().default(20),
      tag: z.array(z.string()).default([]),
      verbose: z.boolean().default(false),
    }),
    pos: ["query"],
  });

  it("uses one model for argv parsing and Zod validation", async () => {
    await expect(
      schema.resolve(
        ["books", "--limit", "5", "--tag=a", "--tag", "b", "--verbose"],
        Readable.from([]),
      ),
    ).resolves.toEqual({ query: "books", limit: 5, tag: ["a", "b"], verbose: true });
  });

  it("uses the same model for help and documentation descriptors", () => {
    expect(schema.signature).toEqual({
      positionals: ["<query>"],
      options: ["[--limit <number>]", "[--tag <value>...]", "[--verbose]"],
    });
    expect(
      schema.descriptors.map(({ name, displayName, type }) => ({ name, displayName, type })),
    ).toEqual([
      { name: "query", displayName: "query", type: "string" },
      { name: "limit", displayName: "--limit", type: "number" },
      { name: "tag", displayName: "--tag", type: "array" },
      { name: "verbose", displayName: "--verbose", type: "boolean" },
    ]);
  });

  it("rejects nested argv fields and directs them to JSON mode", () => {
    expect(() =>
      compileCommandSchema("bad", { schema: z.object({ value: z.object({ id: z.string() }) }) }),
    ).toThrow('use args.type "json"');
  });
});
