import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Write beside the destination, flush contents, then atomically replace its directory entry. */
export function writeAtomicFile(path: string, content: string | Buffer, mode = 0o600): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* A failed write's owned temporary can be reclaimed by the next writer. */
    }
  }
}
