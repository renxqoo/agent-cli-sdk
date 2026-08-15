import type { RawTextCommandResult, StructuredData } from "./types.js";

/** 创建绕过 envelope 的原文输出。该能力不能通过任意业务 meta 伪造。 */
export function rawText(text: string): RawTextCommandResult {
  return Object.freeze({ kind: "raw-text", text });
}

export function isRawTextResult(value: unknown): value is RawTextCommandResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RawTextCommandResult> & Record<string, unknown>;
  return (
    candidate.kind === "raw-text" &&
    typeof candidate.text === "string" &&
    Object.keys(candidate).every((key) => key === "kind" || key === "text")
  );
}

export function isStructuredData(value: unknown): value is StructuredData {
  return value === null || Array.isArray(value) || (typeof value === "object" && value !== null);
}
