/**
 * 单次 HTTP adapter 与响应分类。
 *
 * adapter 只执行一次物理 I/O；它不知道 plugin、401 refresh、重试和 errorOnStatus。
 * 这些生命周期规则统一由 context 内的 RequestExecutor 拥有。
 */
import type {
  AttemptOutcome,
  ErrorOnStatus,
  HttpAdapter,
  RequestOptions,
  TransportResponse,
} from "./types.js";
import {
  APIError,
  AuthenticationError,
  ConfigError,
  ConfirmationRequiredError,
  InternalError,
  NetworkError,
  PermissionError,
  PolicyError,
  ValidationError,
  categoryOfSubtype,
  type Category,
} from "./errs/index.js";

export interface CreateFetchAdapterOptions {
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
  timeout?: number;
  fetch?: typeof globalThis.fetch;
}

/** 创建只发送一次请求的 Fetch adapter。 */
export function createFetchAdapter(options: CreateFetchAdapterOptions = {}): HttpAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async send<T>(request: Readonly<RequestOptions>): Promise<AttemptOutcome<T>> {
      const headers = mergeHeaders(options.defaultHeaders, request.headers);
      let body: string | undefined;
      if (request.body !== undefined && request.method !== "GET") {
        headers["content-type"] = headers["content-type"] ?? "application/json";
        try {
          body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
        } catch (cause) {
          throw new InternalError({
            subtype: "contract_violation",
            message: "Request body is not JSON serializable",
            cause,
          });
        }
      }

      const base = /^https?:\/\//i.test(request.path) ? "" : (options.baseUrl ?? "");
      const url = appendQuery(base + request.path, request.query);
      const timeout = request.timeout ?? options.timeout;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: request.method,
          headers,
          body,
          ...(timeout === undefined ? {} : { signal: AbortSignal.timeout(timeout) }),
        });
      } catch (cause) {
        return { kind: "network-error", error: toNetworkError(cause, timeout) };
      }

      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        return { kind: "network-error", error: toNetworkError(cause, timeout) };
      }

      let data: unknown;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value;
      });
      return {
        kind: "response",
        response: { status: response.status, data: data as T, headers: responseHeaders },
      };
    },
  };
}

/** 最终响应分类。只在所有 attempt 审计结束后调用。 */
export function throwForResponse(response: TransportResponse, errorOnStatus?: ErrorOnStatus): void {
  if (response.status === 401) {
    const configured = matchErrorOnStatus(401, errorOnStatus);
    if (configured) throwBySubtype(configured, response);
    throw new AuthenticationError({
      subtype: "no_token",
      code: 401,
      message: extractErrorMessage(response.data) ?? "Request not authenticated",
      hint: "Please log in or provide valid credentials and retry",
    });
  }

  if (response.status < 400) return;
  const subtype = matchErrorOnStatus(response.status, errorOnStatus);
  if (subtype) throwBySubtype(subtype, response);
}

function matchErrorOnStatus(status: number, mapping?: ErrorOnStatus): string | undefined {
  if (!mapping) return undefined;
  const exact = mapping[status];
  if (exact) return exact;
  return mapping[`${Math.floor(status / 100)}xx` as `${number}xx`];
}

function throwBySubtype(subtype: string, response: TransportResponse): never {
  const status = response.status;
  const hint = status === 429 ? retryHint(response.headers) : undefined;
  const problem = {
    subtype,
    code: status,
    message: extractErrorMessage(response.data) ?? `HTTP ${status}`,
    retryable: status === 429 || status >= 500,
    ...(hint ? { hint } : {}),
  };
  const Constructor = CATEGORY_CONSTRUCTORS[categoryOfSubtype(subtype)];
  throw new Constructor(problem);
}

const CATEGORY_CONSTRUCTORS: Record<Category, typeof APIError> = {
  validation: ValidationError,
  authentication: AuthenticationError,
  authorization: PermissionError,
  config: ConfigError,
  network: NetworkError,
  api: APIError,
  policy: PolicyError,
  internal: InternalError,
  confirmation: ConfirmationRequiredError,
};

function toNetworkError(cause: unknown, timeout?: number): NetworkError {
  const timedOut =
    cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
  return new NetworkError({
    subtype: timedOut ? "timeout" : "connection_refused",
    message: timedOut
      ? `Request timed out (${timeout ?? "unknown"}ms)`
      : `Network error: ${cause instanceof Error ? cause.message : String(cause)}`,
    retryable: true,
    cause,
  });
}

function extractErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  if (typeof value.message === "string") return value.message;
  return typeof value.error === "string" ? value.error : undefined;
}

function retryHint(headers: Record<string, string>): string | undefined {
  const value = headers["retry-after"];
  return value ? `Retry-After: ${value}s` : undefined;
}

function appendQuery(path: string, query?: Record<string, unknown>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(name, String(item));
    } else {
      params.append(name, String(value));
    }
  }
  const encoded = params.toString();
  if (!encoded) return path;
  const hashIndex = path.indexOf("#");
  const base = hashIndex < 0 ? path : path.slice(0, hashIndex);
  const hash = hashIndex < 0 ? "" : path.slice(hashIndex);
  const separator = base.includes("?") ? (/[?&]$/.test(base) ? "" : "&") : "?";
  return `${base}${separator}${encoded}${hash}`;
}

function mergeHeaders(
  defaults?: Record<string, string>,
  request?: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(defaults ?? {})) setHeader(result, name, value);
  for (const [name, value] of Object.entries(request ?? {})) setHeader(result, name, value);
  return result;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing) headers[existing] = value;
  else headers[name.toLowerCase()] = value;
}
