import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { syncSkills } from "../skills/sync.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function skill(root: string, body: string) {
  mkdirSync(join(root, "orders"), { recursive: true });
  writeFileSync(join(root, "orders/SKILL.md"), `---\ndescription: orders\n---\n${body}`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sdk-publication-process-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
  for (const file of [
    "skills/sync",
    "skills/reader",
    "skills/files",
    "skills/path-guard",
    "skills/targets",
    "infra/file-lock",
    "infra/atomic-file",
    "errs/index",
  ]) {
    const source = readFileSync(join(process.cwd(), "src", file + ".ts"), "utf8");
    // Keep real filesystem operations, adding only a deterministic process-stop boundary.
    const output = ts.transpileModule(source.replaceAll('"node:fs"', '"../fault-fs.js"'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
    }).outputText;
    mkdirSync(join(root, file.split("/")[0]!), { recursive: true });
    writeFileSync(join(root, file + ".js"), output);
  }
  writeFileSync(
    join(root, "fault-fs.js"),
    `
    export * from "node:fs";
    import { renameSync as rename, writeSync } from "node:fs";
    export function renameSync(source, destination) {
      rename(source, destination);
      const phase = process.argv[4];
      const from = String(source).replaceAll("\\\\", "/");
      const to = String(destination).replaceAll("\\\\", "/");
      const stop =
        (phase === "prepared" && to.endsWith("/.publication/intent.json")) ||
        (phase === "previous" && to.endsWith("/.publication/previous/orders")) ||
        (phase === "activated" && from.endsWith("/.publication/staged/orders")) ||
        (phase === "manifest-backup" && from.includes("/.rxcli-sync-manifests/") && from.endsWith(".json") && to.endsWith(".backup")) ||
        (phase === "committed" && to.includes("/.rxcli-sync-manifests/") && !to.includes("/.publication/") && to.endsWith(".json") && from.endsWith(".tmp"));
      if (stop) {
        writeSync(1, "crash-boundary\\n");
        process.kill(process.pid, "SIGKILL");
      }
    }
  `,
  );
  const worker = join(root, "worker.mjs");
  writeFileSync(
    worker,
    `
    import { syncSkills } from "./skills/sync.js";
    const [source, target] = process.argv.slice(2);
    const result = syncSkills(source, { targets: [{ key: "test", dir: target }] });
    process.stdout.write(JSON.stringify(result));
    if (!result.targets[0].ok) process.exitCode = 1;
  `,
  );
  return { root, worker };
}

it.each([
  [true, "prepared"],
  [true, "previous"],
  [true, "activated"],
  [true, "manifest-backup"],
  [true, "committed"],
  [false, "activated"],
  [false, "committed"],
])(
  "recovers in a fresh process after a kill at %s / %s, with no original source",
  (existing, phase) => {
    const { root, worker } = fixture();
    const source = join(root, "source"),
      target = join(root, "target"),
      other = join(root, "other");
    const options = { targets: [{ key: "test", dir: target }] };
    if (existing) {
      skill(source, "old");
      expect(syncSkills(source, options).targets[0]?.ok).toBe(true);
    }
    skill(source, "new");
    mkdirSync(other);
    const interrupted = spawnSync(process.execPath, [worker, source, target, phase as string], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(interrupted.error).toBeUndefined();
    expect(interrupted.stdout).toBe("crash-boundary\n");
    expect(interrupted.status).not.toBe(0);
    rmSync(source, { recursive: true });
    const restarted = spawnSync(process.execPath, [worker, other, target, "recover"], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(restarted.error).toBeUndefined();
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout).targets[0].ok).toBe(true);
    const path = join(target, "orders/SKILL.md");
    if (phase === "committed" || existing) {
      expect(readFileSync(path, "utf8")).toBe(
        `---\ndescription: orders\n---\n${phase === "committed" ? "new" : "old"}`,
      );
    } else expect(existsSync(path)).toBe(false);
    expect(existsSync(join(target, ".rxcli-sync-manifests/.publication"))).toBe(false);
  },
);
