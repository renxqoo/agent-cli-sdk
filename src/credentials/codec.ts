import { ConfigError } from "../errs/index.js";
import { parseStrictJson, type JsonInputLimits } from "../strict-json.js";

const NAMESPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * B3: credential/config files are untrusted-at-rest and parsed with the same strict,
 * bounded parser as command JSON input (no duplicate keys, no unsafe keys, bounded
 * depth/size). Previously a bare `JSON.parse` exposed the secret store to deep/multi-MB
 * payloads and silently masked tampering via duplicate keys.
 */
const DOCUMENT_LIMITS: JsonInputLimits = {
  maxBytes: 256 * 1024,
  maxDepth: 32,
  maxProperties: 1000,
  maxArrayItems: 1000,
  maxIssues: 100,
};

export function assertCredentialNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new ConfigError({
      subtype: "invalid_config",
      message: `Invalid credential namespace: ${JSON.stringify(namespace)}`,
    });
  }
}

export function encodeJsonDocument(data: Record<string, unknown>, label: string): string {
  try {
    const encoded = JSON.stringify(data, null, 2);
    if (encoded === undefined) throw new Error("document is not JSON serializable");
    return `${encoded}\n`;
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw invalidDocument(label, cause);
  }
}

export function decodeJsonDocument(text: string, label: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > DOCUMENT_LIMITS.maxBytes) {
    throw invalidDocument(label, new Error("document exceeds size limit"));
  }
  try {
    const parsed = parseStrictJson(text, DOCUMENT_LIMITS);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("document root must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw invalidDocument(label, cause);
  }
}

export function roundTripJsonDocument(
  data: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  return decodeJsonDocument(encodeJsonDocument(data, label), label);
}

function invalidDocument(label: string, cause: unknown): ConfigError {
  return new ConfigError({
    subtype: "invalid_config",
    message: `Invalid JSON document: ${label}`,
    cause,
  });
}
