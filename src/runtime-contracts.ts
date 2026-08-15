import type { PipeRecord } from "./output-contracts.js";
import type { RequestOptions, TransportResponse } from "./request-contracts.js";

export interface CredentialsApi {
  get(namespace: string): Promise<Record<string, string> | null>;
  save(namespace: string, credentials: Record<string, unknown>): Promise<void>;
  clear(namespace: string): Promise<void>;
}

export interface PipeApi {
  in(): AsyncIterable<PipeRecord>;
  isInPipe(): boolean;
}

export interface LogApi {
  info(message: unknown): void;
  warn(message: unknown): void;
  error(message: unknown): void;
}

export interface CommandContext<State = Record<string, never>> {
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<TransportResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<TransportResponse<T>>;
  put<T = unknown>(path: string, body?: unknown): Promise<TransportResponse<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<TransportResponse<T>>;
  delete<T = unknown>(path: string): Promise<TransportResponse<T>>;
  request<T = unknown>(options: RequestOptions): Promise<TransportResponse<T>>;
  state: State;
  log: LogApi;
  pipe: PipeApi;
  credentials: CredentialsApi;
}
