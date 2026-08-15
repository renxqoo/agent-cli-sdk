export type StructuredData = Record<string, unknown> | unknown[] | null;

export interface Pagination {
  complete: boolean;
  pages?: number;
  items?: number;
  nextToken?: string;
}

export interface Meta {
  count?: number;
  pagination?: Pagination;
  rollback?: string;
  [key: string]: unknown;
}

export interface DataCommandResult<T = unknown> {
  data: T;
  meta?: Meta;
}

export interface RawTextCommandResult {
  kind: "raw-text";
  text: string;
}

export type CommandResult<T = unknown> = DataCommandResult<T> | RawTextCommandResult;

export interface PipeRecord {
  type: string;
  id?: string;
  data?: unknown;
  meta?: Record<string, unknown>;
}
