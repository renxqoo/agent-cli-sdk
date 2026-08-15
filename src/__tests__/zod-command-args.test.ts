import { Readable } from "node:stream";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as z from "zod";
import { defineCommand } from "../define.js";
import { compileCommandSchema } from "../command-schema.js";

describe("Zod command arguments", () => {
  it("treats an omitted args definition as an argument-free argv command", async () => {
    const schema = compileCommandSchema("health", undefined);

    expect(schema.mode).toBe("argv");
    expect(schema.signature).toEqual({ positionals: [], options: [] });
    await expect(schema.resolve([], Readable.from([]))).resolves.toEqual({});
    await expect(schema.resolve(["unexpected"], Readable.from([]))).rejects.toMatchObject({
      subtype: "invalid_argument",
    });
  });

  it("uses argv by default and validates positional, option, default, enum, and arrays with Zod", async () => {
    const Args = z.object({
      id: z.string().min(1),
      format: z.enum(["summary", "detail"]).default("summary"),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      includeItems: z.boolean().default(false),
      tag: z.array(z.string()).default([]),
    });
    const schema = compileCommandSchema("get", { schema: Args, pos: ["id", "format"] });

    await expect(
      schema.resolve(
        ["order-1", "--limit", "50", "--include-items", "--tag", "vip", "--tag=urgent"],
        Readable.from([]),
      ),
    ).resolves.toEqual({
      id: "order-1",
      format: "summary",
      limit: 50,
      includeItems: true,
      tag: ["vip", "urgent"],
    });

    await expect(schema.resolve(["order-1", "broken"], Readable.from([]))).rejects.toMatchObject({
      subtype: "invalid_argument",
    });
  });

  it("uses -- as the native end-of-options marker", async () => {
    const schema = compileCommandSchema("get", {
      schema: z.object({ id: z.string() }),
      pos: ["id"],
    });

    await expect(schema.resolve(["--", "-special-id"], Readable.from([]))).resolves.toEqual({
      id: "-special-id",
    });
  });

  it("accepts exactly one complete JSON document from inline, file flag, or native stdin", async () => {
    const Args = z.object({
      customerId: z.string(),
      items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })),
    });
    const schema = compileCommandSchema("create", { type: "json", schema: Args });
    const payload = { customerId: "customer-1", items: [{ sku: "sku-1", quantity: 2 }] };

    expect(schema.mode).toBe("json");
    await expect(
      schema.resolve(["--input", JSON.stringify(payload)], Readable.from([])),
    ).resolves.toEqual(payload);
    await expect(schema.resolve([], Readable.from([JSON.stringify(payload)]))).resolves.toEqual(
      payload,
    );
  });

  it("never merges JSON with business flags or multiple JSON sources", async () => {
    const schema = compileCommandSchema("create", {
      type: "json",
      schema: z.object({ customerId: z.string() }),
    });

    await expect(
      schema.resolve(
        ["--customer-id", "customer-1", "--input", '{"customerId":"customer-1"}'],
        Readable.from([]),
      ),
    ).rejects.toMatchObject({ subtype: "invalid_argument" });
    await expect(
      schema.resolve(
        ["--input", '{"customerId":"customer-1"}', "--input-file", "order.json"],
        Readable.from([]),
      ),
    ).rejects.toMatchObject({ subtype: "invalid_argument" });
  });

  it("infers run args only from the declared Zod schema", () => {
    defineCommand({
      name: "typed",
      description: "typed",
      args: {
        schema: z.object({
          id: z.string(),
          limit: z.number().default(20),
          query: z.string().optional(),
        }),
        pos: ["id"],
      },
      async run(_ctx, args) {
        expectTypeOf(args.id).toEqualTypeOf<string>();
        expectTypeOf(args.limit).toEqualTypeOf<number>();
        expectTypeOf(args.query).toEqualTypeOf<string | undefined>();
        return { data: args };
      },
    });
  });

  it("includes write-policy flags in the discoverable command signature", () => {
    const schema = compileCommandSchema(
      "create",
      { type: "json", schema: z.object({ id: z.string() }) },
      {
        mode: "write",
        dryRun: true,
        confirmation: "required",
        idempotency: "required",
      },
    );

    expect(schema.signature.options).toEqual([
      "[--input <json>]",
      "[--input-file <path>]",
      "[--dry-run]",
      "[--yes]",
      "--idempotency-key <string>",
    ]);
  });
});

describe("positional arguments reject their --flag name", () => {
  it("accepts only the bare form for a positional field", async () => {
    const schema = compileCommandSchema("page", {
      schema: z.object({ payload: z.string().optional() }),
      pos: ["payload"],
    });

    await expect(schema.resolve(['{"keyword":"x"}'], Readable.from([]))).resolves.toEqual({
      payload: '{"keyword":"x"}',
    });
  });

  it("rejects the --name form instead of silently discarding it", async () => {
    const schema = compileCommandSchema("page", {
      schema: z.object({ payload: z.string().optional() }),
      pos: ["payload"],
    });

    await expect(
      schema.resolve(["--payload", '{"keyword":"x"}'], Readable.from([])),
    ).rejects.toMatchObject({
      subtype: "invalid_argument",
      param: "--payload",
    });
  });

  it("still accepts flags for non-positional fields", async () => {
    const schema = compileCommandSchema("records-page", {
      schema: z.object({
        module: z.string(),
        payload: z.string().optional(),
      }),
      pos: ["module"],
    });

    await expect(
      schema.resolve(["lead", "--payload", '{"keyword":"x"}'], Readable.from([])),
    ).resolves.toEqual({
      module: "lead",
      payload: '{"keyword":"x"}',
    });
  });
});
