/**
 * JSON 输入边界:有界读取(--input / --input-file / stdin)、严格解析、Zod 校验映射、
 * 规范化摘要。从 command-schema 拆出,职责单一:只处理"一个完整 JSON 文档"的输入,
 * 不关心 argv tokenize 与命令策略。
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import type { Readable } from "node:stream";
import * as z from "zod";
import { ValidationError } from "./errs/index.js";
import { parseStrictJson, type JsonInputLimits } from "./strict-json.js";

const DEFAULT_JSON_LIMITS: JsonInputLimits = {
  maxBytes: 1024 * 1024,
  maxDepth: 64,
  maxProperties: 10_000,
  maxArrayItems: 10_000,
  maxIssues: 100,
};

export interface JsonInputMeta {
  source: "inline" | "file" | "stdin";
  bytes: number;
  rawDigest: string;
  validatedDigest: string;
}

/**
 * 把 JSON 模式解析出的选项解析成一个完整输入文档并做 Zod 校验。
 * 返回校验后的数据与输入溯源元数据(raw/validated 双摘要,供审计与 dry-run 用)。
 */
export async function resolveJson(
  options: Record<string, unknown>,
  stdin: Readable,
  schema: z.ZodObject,
): Promise<{ data: Record<string, unknown>; meta: JsonInputMeta }> {
  if (options["input-schema"] || options["input-example"]) {
    throw new ValidationError({
      subtype: "invalid_argument",
      param: options["input-schema"] ? "--input-schema" : "--input-example",
      message: "Input discovery is handled before command execution",
    });
  }
  const hasInline = typeof options.input === "string";
  const hasFile = typeof options["input-file"] === "string";
  if (hasInline && hasFile) {
    throw new ValidationError({
      subtype: "invalid_argument",
      param: "--input",
      message: "JSON input sources are mutually exclusive",
      hint: "Use exactly one of --input, --input-file, or native stdin.",
    });
  }
  const source: JsonInputMeta["source"] = hasInline ? "inline" : hasFile ? "file" : "stdin";
  if (source === "stdin" && (stdin as Readable & { isTTY?: boolean }).isTTY) {
    throw new ValidationError({
      subtype: "missing_required",
      param: "input",
      message: "JSON input is required",
      hint: "Use --input, --input-file, a pipe, or stdin redirection.",
    });
  }
  const bytes =
    source === "inline"
      ? bounded(Buffer.from(options.input as string, "utf8"), "--input")
      : source === "file"
        ? await readInputFile(options["input-file"] as string)
        : await readBoundedStream(stdin);
  const decoded = decodeUtf8(bytes);
  const input = parseStrictJson(decoded, DEFAULT_JSON_LIMITS);
  const data = await validateZod(schema, input);
  return {
    data,
    meta: {
      source,
      bytes: bytes.byteLength,
      rawDigest: digest(bytes),
      validatedDigest: digest(Buffer.from(canonicalize(data), "utf8")),
    },
  };
}

/** Zod 校验 + 统一错误映射(issues 截断到 maxIssues,param 用点分路径)。 */
export async function validateZod(
  schema: z.ZodObject,
  value: unknown,
): Promise<Record<string, unknown>> {
  const result = await z.safeParseAsync(schema, value);
  if (result.success) return result.data as Record<string, unknown>;
  const issues = result.error.issues.slice(0, DEFAULT_JSON_LIMITS.maxIssues).map((issue) => ({
    param: issue.path.length === 0 ? "args" : issue.path.map(String).join("."),
    message: issue.message,
  }));
  throw new ValidationError({
    subtype: "invalid_argument",
    param: issues[0]?.param ?? "args",
    params: issues,
    message: issues[0]?.message ?? "Arguments do not match the Zod schema",
  });
}

async function readInputFile(path: string): Promise<Buffer> {
  let handle;
  try {
    // O_NOFOLLOW 在 Windows 上 constants.O_NOFOLLOW 为 undefined(?? 0 后失效),open 会跟随
    // symlink;先用 lstat(不跟随)显式拒绝非常规文件(含 symlink)。
    const pathStat = await lstat(path);
    if (!pathStat.isFile()) throw new ValidationError({
      subtype: "invalid_argument",
      param: "--input-file",
      message: "path is not a regular file",
      hint: "Use a readable regular file; symlinks and device files are not accepted.",
    });
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    // 对已打开的 fd 做 fstat:类型与大小以 fd 为准,消除 open 与 path 检查之间的路径竞态。
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ValidationError({
      subtype: "invalid_argument",
      param: "--input-file",
      message: "path is not a regular file",
      hint: "Use a readable regular file; symlinks and device files are not accepted.",
    });
    if (stat.size > DEFAULT_JSON_LIMITS.maxBytes) throw inputTooLarge("--input-file");
    return bounded(await handle.readFile(), "--input-file");
  } catch (cause) {
    if (cause instanceof ValidationError) throw cause;
    throw new ValidationError({
      subtype: "invalid_argument",
      param: "--input-file",
      message: "Unable to read JSON input file",
      hint: "Use a readable regular file; symlinks and device files are not accepted.",
      cause,
    });
  } finally {
    await handle?.close();
  }
}

async function readBoundedStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > DEFAULT_JSON_LIMITS.maxBytes) throw inputTooLarge("stdin");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function bounded(bytes: Buffer, param: string): Buffer {
  if (bytes.byteLength > DEFAULT_JSON_LIMITS.maxBytes) throw inputTooLarge(param);
  return bytes;
}

function inputTooLarge(param: string): ValidationError {
  return new ValidationError({
    subtype: "out_of_range",
    param,
    message: `JSON input exceeds ${DEFAULT_JSON_LIMITS.maxBytes} bytes`,
  });
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new ValidationError({
      subtype: "invalid_argument",
      param: "input",
      message: "JSON input must be valid UTF-8",
      cause,
    });
  }
}

function digest(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw nonJsonZodOutput();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw nonJsonZodOutput();
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key) => !/^(?:0|[1-9]\d*)$/.test(key))) {
      throw nonJsonZodOutput();
    }
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw nonJsonZodOutput();
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function nonJsonZodOutput(): ValidationError {
  return new ValidationError({
    subtype: "invalid_argument",
    param: "args",
    message: "JSON argument schema output must remain JSON-compatible",
    hint: "Do not transform JSON arguments into Date, Map, BigInt, undefined, or class instances.",
  });
}
