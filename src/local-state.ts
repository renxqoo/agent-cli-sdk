import { join, resolve } from "node:path";
import { fileStore, memoryStore } from "./credentials/config-store.js";
import type { ConfigStore } from "./credentials/types.js";

export interface LocalStatePaths {
  /** One application-owned root configured once by the CLI package. */
  root: string;
  /** Per-namespace application configuration (`<ns>.json`, e.g. registered clientId). */
  configDir: string;
  /** Sensitive credential documents, partitioned by credential namespace. */
  credentialsDir: string;
  /** Deletable operational cache. */
  cacheDir: string;
  /** Cached package-version metadata. */
  updatesDir: string;
}

export interface FileLocalState {
  kind: "file";
  paths: Readonly<LocalStatePaths>;
  store: ConfigStore;
}

export interface MemoryLocalState {
  kind: "memory";
  store: ConfigStore;
}

export type LocalState = FileLocalState | MemoryLocalState;

export interface CreateLocalStateOptions {
  /** Application-specific local-state root. Use a distinct directory for each CLI app. */
  dir: string;
  lockTimeoutMs?: number;
  lockStaleAfterMs?: number;
}

/**
 * Create the single local-state object shared by auth, install, update awareness, and app code.
 *
 * Layout:
 *   <dir>/config/<namespace>.json
 *   <dir>/credentials/<namespace>.json
 *   <dir>/cache/updates/<package-hash>.json
 */
export function createLocalState(options: CreateLocalStateOptions): FileLocalState {
  if (!options.dir.trim()) throw new TypeError("local state dir must not be empty");
  const root = resolve(options.dir);
  const paths = Object.freeze({
    root,
    configDir: join(root, "config"),
    credentialsDir: join(root, "credentials"),
    cacheDir: join(root, "cache"),
    updatesDir: join(root, "cache", "updates"),
  });
  return Object.freeze({
    kind: "file" as const,
    paths,
    store: fileStore({
      dir: root,
      lockTimeoutMs: options.lockTimeoutMs,
      lockStaleAfterMs: options.lockStaleAfterMs,
    }),
  });
}

/** In-memory local state for tests and embedded runtimes that deliberately prohibit file I/O. */
export function createMemoryLocalState(
  initial: {
    credentials?: Record<string, Record<string, unknown>>;
    config?: Record<string, Record<string, unknown>>;
  } = {},
): MemoryLocalState {
  return Object.freeze({ kind: "memory" as const, store: memoryStore(initial) });
}
