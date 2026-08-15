/**
 * 覆盖率补强:之前零测试或边界未覆盖的子系统。
 *   - qrcode 命令契约(此前零测试)
 *   - pipe data:null envelope(0 records 但不崩)
 */
import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qrcodeCommand } from "../qrcode.js";
import { createPipeReader } from "../pipe.js";
import { InternalError } from "../errs/index.js";
import type { PipeRecord } from "../types.js";

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

// ---------------------------------------------------------------------------
// qrcode 命令契约(此前零测试)
// ---------------------------------------------------------------------------

describe("qrcode 命令契约", () => {
  function makeCtx() {
    return {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Parameters<typeof qrcodeCommand.run>[0];
  }

  it("默认(无 --output):生成 ASCII 到 stderr,data.ascii=true", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await qrcodeCommand.run(makeCtx(), { url: "https://example.com" } as never);
      expect(result?.data).toMatchObject({ ascii: true });
      expect(writeSpy).toHaveBeenCalled();
      const text = writeSpy.mock.calls[0]![0] as string;
      expect(text).toMatch(/█|▀|▄|#| /); // ASCII 二维码字符
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("--output <path>:写 PNG 文件,data.output=路径", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rxcli-qr-"));
    try {
      const outPath = join(dir, "code.png");
      const result = await qrcodeCommand.run(makeCtx(), {
        url: "https://example.com",
        output: outPath,
      } as never);
      expect(result?.data).toMatchObject({ output: outPath });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--output 写失败(非法路径)→ InternalError", async () => {
    await expect(
      qrcodeCommand.run(makeCtx(), {
        url: "https://example.com",
        output: "/nonexistent-dir/x/code.png",
      } as never),
    ).rejects.toBeInstanceOf(InternalError);
  });

  it("无效 URL(qrcode 库拒绝空串)→ InternalError,不抛裸错", async () => {
    await expect(qrcodeCommand.run(makeCtx(), { url: "" } as never)).rejects.toBeInstanceOf(
      InternalError,
    );
  });
});

// ---------------------------------------------------------------------------
// pipe: data:null envelope(0 records 但不崩)
// ---------------------------------------------------------------------------

describe("pipe: data:null envelope → 0 records,不崩", () => {
  it("{ok:true, data:null} → 0 records", async () => {
    const stdin = makeStdin(JSON.stringify({ ok: true, source: "orders", data: null }));
    const reader = createPipeReader(stdin as NodeJS.ReadableStream & { isTTY?: boolean });
    const records = await collect(reader.in());
    expect(records).toEqual([]);
  });
});
