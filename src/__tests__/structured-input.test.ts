import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { defineCli, defineCommand } from "../index.js";
import { commandExecutionKey, compileCommandSchema } from "../command-schema.js";

const orderSchema = z
  .object({
    customerId: z.string(),
    items: z.array(z.object({ sku: z.string(), quantity: z.number() })),
    token: z.string().optional(),
  })
  .register(z.globalRegistry, {
    sensitive: ["/token"],
    examples: [{ customerId: "c1", items: [] }],
  });
type OrderArgs = z.output<typeof orderSchema>;

let stdout = "";
let stderr = "";
const temporaryDirectories: string[] = [];

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

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function command(run = vi.fn(async (_ctx: unknown, args: OrderArgs) => ({ data: args }))) {
  return defineCommand({
    name: "create",
    description: "Create an order",
    args: { type: "json", schema: orderSchema },
    policy: {
      mode: "write",
      dryRun: true,
      confirmation: "required",
      idempotency: "required",
    },
    run,
  });
}

describe("JSON command arguments", () => {
  it("accepts inline JSON and passes the validated object directly to run", async () => {
    const run = vi.fn(async (_ctx: unknown, args: OrderArgs) => ({ data: args }));
    const app = defineCli({
      name: "orders",
      description: "orders",
      commands: { create: command(run) },
    });
    await app.run([
      "create",
      "--input",
      JSON.stringify({ customerId: "c1", items: [] }),
      "--idempotency-key",
      "retry-1",
      "--yes",
    ]);
    expect(process.exitCode).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![1].customerId).toBe("c1");
  });

  it("rejects duplicate JSON keys without echoing the payload", async () => {
    const app = defineCli({
      name: "orders",
      description: "orders",
      commands: { create: command() },
    });
    await app.run([
      "create",
      "--input",
      '{"customerId":"secret-a","customerId":"secret-b","items":[]}',
      "--idempotency-key",
      "retry-1",
      "--yes",
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain("Duplicate object key");
    expect(stderr).not.toContain("secret-a");
    expect(stderr).not.toContain("secret-b");
  });

  it("dry-run redacts sensitive paths and makes run unreachable", async () => {
    const run = vi.fn(async () => ({ data: null }));
    const app = defineCli({
      name: "orders",
      description: "orders",
      commands: { create: command(run) },
    });
    await app.run([
      "create",
      "--input",
      JSON.stringify({ customerId: "c1", items: [], token: "top-secret" }),
      "--dry-run",
    ]);
    const envelope = JSON.parse(stdout);
    expect(envelope.dry_run).toBe(true);
    expect(envelope.data.args.token).toBe("[REDACTED]");
    expect(run).not.toHaveBeenCalled();
  });

  it("reads file and native stdin through the same validator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rxcli-input-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "order.json");
    const payload = JSON.stringify({ customerId: "c-file", items: [] });
    await writeFile(file, payload, "utf8");
    const compiled = compileCommandSchema("create", { type: "json", schema: orderSchema });

    const fromFile = await compiled.resolve(["--input-file", file], Readable.from([]));
    const fromStdin = await compiled.resolve([], Readable.from([payload]));
    expect(fromFile.customerId).toBe("c-file");
    expect(fromFile[commandExecutionKey]?.json?.source).toBe("file");
    expect(fromStdin[commandExecutionKey]?.json?.source).toBe("stdin");
    expect(fromFile[commandExecutionKey]?.json?.validatedDigest).toBe(
      fromStdin[commandExecutionKey]?.json?.validatedDigest,
    );
  });

  it("rejects symbolic-link input files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rxcli-input-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target.json");
    const link = join(directory, "link.json");
    await writeFile(target, JSON.stringify({ customerId: "c1", items: [] }), "utf8");
    await symlink(target, link);
    const compiled = compileCommandSchema("create", { type: "json", schema: orderSchema });
    await expect(compiled.resolve(["--input-file", link], Readable.from([]))).rejects.toMatchObject(
      {
        subtype: "invalid_argument",
        param: "--input-file",
      },
    );
  });

  it("rejects repeated JSON input and idempotency flags instead of silently overriding", async () => {
    const compiled = compileCommandSchema(
      "create",
      { type: "json", schema: orderSchema },
      { mode: "write", dryRun: true, confirmation: "required", idempotency: "optional" },
    );
    await expect(
      compiled.resolve(["--input", "{}", "--input", "{}"], Readable.from([])),
    ).rejects.toMatchObject({
      subtype: "invalid_argument",
      param: "--input",
      message: "Argument --input cannot be repeated",
    });
    await expect(
      compiled.resolve(["--input-file", "a.json", "--input-file", "b.json"], Readable.from([])),
    ).rejects.toMatchObject({ subtype: "invalid_argument", param: "--input-file" });
    await expect(
      compiled.resolve(
        ["--idempotency-key", "first", "--idempotency-key", "second"],
        Readable.from([]),
      ),
    ).rejects.toMatchObject({ subtype: "invalid_argument", param: "--idempotency-key" });
  });

  it("injects the caller-owned idempotency key into write requests", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("idempotency-key")).toBe("stable-retry-key");
      return new Response(JSON.stringify({ created: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = defineCli({
      name: "orders",
      description: "orders",
      baseUrl: "https://orders.example",
      commands: {
        create: command(async (ctx, args) => {
          const response = await ctx.post("/orders", args);
          return { data: response.data as Record<string, unknown> };
        }),
      },
    });
    await app.run([
      "create",
      "--input",
      JSON.stringify({ customerId: "c1", items: [] }),
      "--idempotency-key",
      "stable-retry-key",
      "--yes",
    ]);
    expect(process.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("exports the Zod-derived schema without requiring input", async () => {
    const app = defineCli({
      name: "orders",
      description: "orders",
      commands: { create: command() },
    });
    await app.run(["create", "--input-schema"]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout).data.schema.type).toBe("object");
  });
});
