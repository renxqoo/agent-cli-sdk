export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
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
