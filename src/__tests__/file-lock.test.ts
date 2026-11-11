import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }),
  );
  children.clear();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sdk-lock-process-"));
  roots.push(root);
  mkdirSync(join(root, "infra"));
  mkdirSync(join(root, "errs"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const file of ["infra/file-lock", "errs/index"]) {
    const source = readFileSync(join(process.cwd(), "src", file + ".ts"), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
    }).outputText;
    writeFileSync(join(root, file + ".js"), output);
  }
  const worker = join(root, "worker.mjs");
  writeFileSync(
    worker,
    `
    import { withFileLock } from "./infra/file-lock.js";
    import { once } from "node:events";
    const [directory, key, mode] = process.argv.slice(2);
    try {
      await withFileLock(directory, key, async () => {
        process.stdout.write("held\\n");
        if (mode === "hold") {
          await once(process.stdin, "data");
          process.stdin.pause();
        }
      });
    } catch (error) {
      process.stdout.write("busy\\n");
      process.exitCode = 9;
    }
  `,
  );
  const start = (key: string, mode = "hold") => {
    const child = spawn(process.execPath, [worker, join(root, "locks"), key, mode], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    const exited = once(child, "exit");
    let output = "";
    let errors = "";
    child.stderr!.on("data", (chunk) => {
      errors += String(chunk);
    });
    const ready = new Promise<string>((resolve, reject) => {
      child.stdout!.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("\n")) resolve(output.trim());
      });
      child.on("error", reject);
      void exited.then(() => {
        if (!output.includes("\n"))
          reject(new Error(errors || "Worker exited before acquiring lock"));
      });
    });
    return { child, ready, exited };
  };
  return { start };
}

describe("cross-process lock ownership", () => {
  it("excludes concurrent owners, isolates keys and recovers after a killed holder", async () => {
    const { start } = fixture();
    const holder = start("session");
    expect(await holder.ready).toBe("held");
    const competing = start("session", "try");
    expect(await competing.ready).toBe("busy");
    expect((await competing.exited)[0]).toBe(9);
    const independent = start("another-session", "try");
    expect(await independent.ready).toBe("held");
    expect((await independent.exited)[0]).toBe(0);
    holder.child.kill("SIGKILL");
    await holder.exited;
    const successor = start("session");
    expect(await successor.ready).toBe("held");
    const third = start("session", "try");
    expect(await third.ready).toBe("busy");
    await third.exited;
    successor.child.stdin!.write("release\n");
    expect((await successor.exited)[0]).toBe(0);
  });
});
