/**
 * @renxqoo/agent-cli-sdk —— 管道(pipe)
 *
 * 设计依据:docs/01-cli-usage.md "管道用法"、docs/03-envelopes.md "PipeRecord"。
 * 方案(已批准):统一输出格式整包。上游 stdout 是完整统一输出格式 {ok,data,meta};
 * 下游读完整 stdin → JSON.parse → 取 envelope.data → 数组逐条 yield PipeRecord,单对象 yield 一条。
 * isInPipe:stdin 非 TTY 即管道(下游命令据此分流)。
 *
 * 阶段 1:本文件给接口骨架(createPipeReader);阶段 3 完整实现并接入 pipeline。
 */

import type { PipeApi, PipeRecord } from "./types.js";
import { InternalError } from "./errs/index.js";

/** stdin 类型:ReadableStream + isTTY 标志(Node 的 process.stdin 有 isTTY)。 */
type StdinLike = NodeJS.ReadableStream & { isTTY?: boolean };

/** 读完整 stream 为字符串(stdin 是 Readable)。 */
async function readAll(stream: StdinLike): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const maxBytes = 16 * 1024 * 1024;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new InternalError({
        subtype: "contract_violation",
        message: `Pipe input exceeds ${maxBytes} bytes limit`,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 创建管道读取器。正式 envelope 必须携带顶层 source；显式 PipeRecord 保留自身 type。
 */
export function createPipeReader(stdin: StdinLike = process.stdin as StdinLike): PipeApi {
  let cached: Promise<PipeRecord[]> | undefined;

  const load = async (): Promise<PipeRecord[]> => {
    if (cached !== undefined) return cached;
    cached = (async () => {
      const raw = await readAll(stdin);
      if (!raw.trim()) return [];
      let envelope: unknown;
      try {
        envelope = JSON.parse(raw);
      } catch (e) {
        throw new InternalError({
          subtype: "decode_failure",
          message: "Pipe input is not valid JSON",
          cause: e,
        });
      }

      // 统一输出结构:{ ok, data, meta };data 可能是数组或单对象
      if (!envelope || typeof envelope !== "object") {
        throw new InternalError({
          subtype: "decode_failure",
          message: "Pipe input is not an object envelope",
        });
      }
      const env = envelope as { ok?: unknown; source?: unknown; data?: unknown };
      if (env.ok === false) {
        throw new InternalError({
          subtype: "decode_failure",
          message: "Pipe input is an error envelope",
        });
      }
      if (env.ok !== true || !Object.prototype.hasOwnProperty.call(env, "data")) {
        throw new InternalError({
          subtype: "decode_failure",
          message: "Pipe input is missing success fields",
        });
      }
      if (typeof env.source !== "string" || !env.source) {
        throw new InternalError({
          subtype: "decode_failure",
          message: "Pipe input is missing source",
        });
      }
      const data = env.data;
      if (data !== null && !Array.isArray(data) && typeof data !== "object") {
        throw new InternalError({
          subtype: "contract_violation",
          message: "Pipe input data must be object, array, or null",
        });
      }
      const source = env.source;
      const records: PipeRecord[] = [];

      if (Array.isArray(data)) {
        for (const item of data) {
          records.push(toPipeRecord(item, source));
        }
      } else if (data !== null && data !== undefined) {
        records.push(toPipeRecord(data, source));
      }
      return records;
    })();
    return cached;
  };

  return {
    async *in() {
      const records = await load();
      for (const rec of records) {
        yield rec;
      }
    },
    isInPipe() {
      return !stdin.isTTY;
    },
  };
}

function toPipeRecord(item: unknown, source: string): PipeRecord {
  if (
    item &&
    typeof item === "object" &&
    typeof (item as Record<string, unknown>).type === "string" &&
    Object.prototype.hasOwnProperty.call(item, "data")
  ) {
    return item as PipeRecord;
  }
  const obj = (item ?? {}) as Record<string, unknown>;
  return {
    type: source,
    ...(obj.id !== undefined ? { id: String(obj.id) } : {}),
    data: item,
  };
}

/** 空管道(非管道场景用)。 */
export function emptyPipe(): PipeApi {
  return {
    async *in() {
      /* 无数据 */
    },
    isInPipe() {
      return false;
    },
  };
}
