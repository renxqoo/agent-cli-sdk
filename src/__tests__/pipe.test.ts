import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createPipeReader } from "../pipe.js";
import type { PipeRecord } from "../types.js";

/** 把字符串包成 Readable stream(模拟 stdin)。 */
function makeStdin(data: string): NodeJS.ReadableStream {
  const s = new Readable({ read() {} });
  s.push(data);
  s.push(null);
  return s as unknown as NodeJS.ReadableStream & { isTTY?: boolean };
}

async function collect(iter: AsyncIterable<PipeRecord>): Promise<PipeRecord[]> {
  const out: PipeRecord[] = [];
  for await (const rec of iter) out.push(rec);
  return out;
}

describe("pipe: 统一输出格式整包 parse → 逐条 yield PipeRecord", () => {
  it("data 是数组 → 逐条 yield,每条包成 PipeRecord", async () => {
    const stdin = makeStdin(
      JSON.stringify({
        ok: true,
        source: "orders",
        data: [
          { id: "o1", total: 100 },
          { id: "o2", total: 200 },
        ],
        meta: { pagination: { complete: true } },
      }),
    );
    const reader = createPipeReader(stdin as NodeJS.ReadableStream & { isTTY?: boolean });
    const records = await collect(reader.in());
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ type: "orders", id: "o1", data: { id: "o1", total: 100 } });
    expect(records[1]).toEqual({ type: "orders", id: "o2", data: { id: "o2", total: 200 } });
  });

  it("data 是单对象 → yield 一条", async () => {
    const stdin = makeStdin(
      JSON.stringify({ ok: true, source: "orders", data: { id: "o1", status: "paid" } }),
    );
    const reader = createPipeReader(stdin as NodeJS.ReadableStream & { isTTY?: boolean });
    const records = await collect(reader.in());
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("o1");
  });

  it("拒绝根 data scalar，保持结构化管道契约", async () => {
    const reader = createPipeReader(
      makeStdin(
        JSON.stringify({ ok: true, source: "numbers", data: 42 }),
      ) as NodeJS.ReadableStream & {
        isTTY?: boolean;
      },
    );
    await expect(collect(reader.in())).rejects.toThrow(/object, array, or null/i);
  });

  it("uses the upstream envelope source", async () => {
    const reader = createPipeReader(
      makeStdin(
        JSON.stringify({ ok: true, source: "orders", data: [{ id: "o1" }] }),
      ) as NodeJS.ReadableStream & {
        isTTY?: boolean;
      },
    );
    expect(await collect(reader.in())).toEqual([{ type: "orders", id: "o1", data: { id: "o1" } }]);
  });

  it("data 是单个显式 PipeRecord 时不重复包装", async () => {
    const record = { type: "customers", id: "c1", data: { name: "alice" } };
    const stdin = makeStdin(JSON.stringify({ ok: true, source: "orders", data: record }));
    const reader = createPipeReader(stdin as NodeJS.ReadableStream & { isTTY?: boolean });
    expect(await collect(reader.in())).toEqual([record]);
  });

  it("data 项已带 type(多级管道)→ 保留上游 type", async () => {
    const stdin = makeStdin(
      JSON.stringify({
        ok: true,
        source: "orders",
        data: [{ type: "customers", id: "c1", data: { name: "alice" } }],
      }),
    );
    const reader = createPipeReader(stdin as NodeJS.ReadableStream & { isTTY?: boolean });
    const records = await collect(reader.in());
    expect(records[0].type).toBe("customers"); // 保留显式上游 type
  });

  it("普通业务对象即使有 type 字段,没有 PipeRecord.data 时仍应被包装", async () => {
    const item = { type: "physical", id: "p1", title: "Book" };
    const stdin = makeStdin(JSON.stringify({ ok: true, source: "products", data: [item] }));
    const reader = createPipeReader(stdin as NodeJS.ReadableStream & { isTTY?: boolean });
    const records = await collect(reader.in());
    expect(records[0]).toEqual({ type: "products", id: "p1", data: item });
  });

  it("拒绝把失败输出静默当成空管道", async () => {
    const stdin = makeStdin(
      JSON.stringify({ ok: false, error: { type: "api", subtype: "server_error" } }),
    );
    const reader = createPipeReader(stdin as NodeJS.ReadableStream & { isTTY?: boolean });
    await expect(collect(reader.in())).rejects.toThrow(/error envelope|pipe/i);
  });

  it("空 stdin → 无记录", async () => {
    const stdin = makeStdin("");
    const reader = createPipeReader(stdin as NodeJS.ReadableStream & { isTTY?: boolean });
    const records = await collect(reader.in());
    expect(records).toHaveLength(0);
  });

  it("非法 JSON → 抛 InternalError(decode_failure)", async () => {
    const stdin = makeStdin("not json {{{");
    const reader = createPipeReader(stdin as NodeJS.ReadableStream & { isTTY?: boolean });
    await expect(collect(reader.in())).rejects.toThrow(/not valid JSON|pipe input/i);
    await expect(collect(reader.in())).rejects.toThrow(/not valid JSON|pipe input/i);
  });

  it("缺少 ok/data 的普通对象不是合法成功输出", async () => {
    const reader = createPipeReader(
      makeStdin(JSON.stringify({ hello: "world" })) as NodeJS.ReadableStream & { isTTY?: boolean },
    );
    await expect(collect(reader.in())).rejects.toThrow(/success fields/i);
  });

  it("拒绝缺少 source 的旧 envelope", async () => {
    const reader = createPipeReader(
      makeStdin(JSON.stringify({ ok: true, data: [] })) as NodeJS.ReadableStream & {
        isTTY?: boolean;
      },
    );
    await expect(collect(reader.in())).rejects.toThrow(/missing source/i);
  });
});
