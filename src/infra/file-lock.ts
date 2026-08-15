/**
 * Cross-process advisory locking via an O_EXCL lockfile with stale-owner recovery.
 *
 * Shared by the credential store (refresh transaction) and skills sync. The lock is
 * released in a `finally`; callers that may be terminated by signals should register
 * their own SIGINT/SIGHUP cleanup for the abrupt-exit case.
 */

import {
  constants,
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConflictError } from "../errs/index.js";

export interface WithFileLockOptions {
  /** Max total wait to acquire the lock, in ms. 0 = single attempt (fail fast). Default 0. */
  timeoutMs?: number;
  /** Poll interval while waiting, in ms. Default 50. */
  pollIntervalMs?: number;
  /** A lock older than this (ms) is reclaimed even if its owner looks live. Default 60_000. */
  staleAfterMs?: number;
}

interface LockOwner {
  pid: number;
  startedAt: number;
}

const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 50;

function lockFilePath(dir: string, key: string): string {
  // Keep the filename filesystem-safe across POSIX + Windows.
  const safe = key.replace(/[^a-z0-9-]/gi, "_").slice(0, 64) || "default";
  return join(dir, `.rxcli-${safe}.lock`);
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(path: string): LockOwner | null {
  try {
    const data = readFileSync(path, "utf8");
    const parsed = JSON.parse(data) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "number") {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function isStale(owner: LockOwner | null, staleAfterMs: number): boolean {
  if (!owner) return true;
  if (owner.pid === process.pid) return false;
  if (!isPidAlive(owner.pid)) return true;
  return Date.now() - owner.startedAt > staleAfterMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding an exclusive lock named `key` inside `dir`.
 *
 * Acquisition uses `O_EXCL | O_CREAT`: the create is atomic. If the lockfile already
 * exists, its owner record is inspected; a lock whose owner PID is dead, or whose
 * `startedAt` exceeds `staleAfterMs`, is reclaimed. This recovers from a process
 * killed mid-critical-section (where the `finally` release never ran).
 */
export async function withFileLock<T>(
  dir: string,
  key: string,
  fn: () => Promise<T>,
  options: WithFileLockOptions = {},
): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lockPath = lockFilePath(dir, key);
  const timeoutMs = options.timeoutMs ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  // Acquire.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const handle = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      // Close the fd explicitly: writeFileSync(fd) does NOT close it. On Windows an
      // open handle blocks unlinkSync (EPERM), so the lock could never be released.
      closeSync(handle);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStale(readOwner(lockPath), staleAfterMs)) {
        // Best-effort reclaim: unlink then retry the atomic create next loop iteration.
        try {
          unlinkSync(lockPath);
        } catch {
          /* another process reclaimed it; loop will retry */
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new ConflictError(`Could not acquire lock "${key}" within ${timeoutMs}ms`);
    }
    await sleep(pollIntervalMs);
  }

  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* lock already gone */
    }
  }
}

/** Remove a lockfile if present (for cleanup helpers / signal handlers). */
export function releaseFileLock(dir: string, key: string): void {
  try {
    unlinkSync(lockFilePath(dir, key));
  } catch {
    /* ignore */
  }
}

/**
 * Synchronous single-attempt variant for call stacks that must stay synchronous
 * (e.g. skills sync). It acquires once with stale-owner reclaim — no polling — so a
 * contended lock throws immediately. Stale recovery still lets the next run reclaim a
 * lock left behind by a killed process.
 */
export function withFileLockSync<T>(
  dir: string,
  key: string,
  fn: () => T,
  options: WithFileLockOptions = {},
): T {
  mkdirSync(dir, { recursive: true });
  const lockPath = lockFilePath(dir, key);
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;

  const acquire = (): boolean => {
    try {
      const handle = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      closeSync(handle); // see withFileLock: must close before unlink on Windows
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };

  if (!acquire()) {
    if (isStale(readOwner(lockPath), staleAfterMs)) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* another process reclaimed it */
      }
      if (!acquire()) {
        throw new ConflictError(`Could not acquire lock "${key}" in ${dir} (held by another process)`);
      }
    } else {
      throw new ConflictError(`Could not acquire lock "${key}" in ${dir} (held by another process)`);
    }
  }

  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* lock already gone */
    }
  }
}
