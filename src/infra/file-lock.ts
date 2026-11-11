import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConflictError } from "../errs/index.js";

export interface WithFileLockOptions {
  /** Maximum acquisition wait. Zero makes one immediate attempt. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** SQLite's OS locks are shared by Node and Bun and released on process termination. */
function openLock(dir: string, key: string): DatabaseSync {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(key).digest("hex");
  const path = join(dir, `.rxcli-${digest}.sqlite`);
  const database = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    if (process.platform !== "win32") {
      database.close();
      throw error;
    }
  }
  database.exec("PRAGMA busy_timeout = 0");
  return database;
}

function tryAcquire(database: DatabaseSync): boolean {
  try {
    database.exec("BEGIN IMMEDIATE");
    return true;
  } catch (error) {
    if ((error as { errcode?: number }).errcode === 5) return false;
    throw error;
  }
}

export async function withFileLock<T>(
  dir: string,
  key: string,
  operation: () => Promise<T>,
  options: WithFileLockOptions = {},
): Promise<T> {
  const timeout = options.timeoutMs ?? 0;
  const pollInterval = options.pollIntervalMs ?? 25;
  if (
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    !Number.isFinite(pollInterval) ||
    pollInterval <= 0
  ) {
    throw new RangeError("Lock timeout must be non-negative and polling interval must be positive");
  }
  const deadline = performance.now() + timeout;
  const database = openLock(dir, key);
  try {
    while (!tryAcquire(database)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new ConflictError(`Could not acquire lock "${key}" within ${timeout}ms`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollInterval, remaining)));
    }
    return await operation();
  } finally {
    // Closing the connection rolls back the empty transaction and releases its OS lock.
    database.close();
  }
}

export function withFileLockSync<T>(dir: string, key: string, operation: () => T): T {
  const database = openLock(dir, key);
  try {
    if (!tryAcquire(database)) throw new ConflictError(`Lock "${key}" is held by another process`);
    return operation();
  } finally {
    database.close();
  }
}
