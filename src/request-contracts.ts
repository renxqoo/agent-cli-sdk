/** Controls shared by ctx.request and the convenience HTTP methods. */
export interface RequestControls {
  /** Per-attempt timeout in milliseconds; defaults to the app setting, then 30 seconds. */
  timeout?: number;
  /** Caller cancellation survives preparation hooks and authentication retries. */
  signal?: AbortSignal;
  /** Return HTTP errors for command-specific handling. Final 401 still throws. */
  allowHttpErrors?: boolean;
}

export interface RequestOptions extends RequestControls {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface TransportResponse<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export type AttemptOutcome<T = unknown> =
  | { kind: "response"; response: TransportResponse<T> }
  | { kind: "network-error"; error: unknown };

export interface HttpAdapter {
  send<T = unknown>(request: Readonly<RequestOptions>): Promise<AttemptOutcome<T>>;
}

export interface RequestAttemptEvent<T = unknown> {
  attempt: number;
  reason: "initial" | "authentication-retry";
  logicalRequest: Readonly<RequestOptions>;
  request: Readonly<RequestOptions>;
  outcome: AttemptOutcome<T>;
}

export type ErrorOnStatus = Record<number | `${number}xx`, string>;
