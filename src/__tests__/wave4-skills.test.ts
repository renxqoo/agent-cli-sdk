/**
 * Wave 4 regression tests — skills subsystem:
 *   B1 — sync lock stale recovery
 *   L7 — listSkills skips a bad/escaping entry instead of crashing
 *   L8 — listPath does not crash on a dangling symlink entry
 *   B2 — sync dereferences symlinks (synced copies are real files)
 *   M10 — refreshAutogen preserves content outside the AUTO-GEN block
 *   M12 — resolveActiveTargets respects a custom target list without forcing agents
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
  lstatSync,
  readdirSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLockSync } from "../infra/file-lock.js";
import { listSkills, listPath } from "../skills/reader.js";
import { replaceDirectoryTransaction, syncSkills } from "../skills/sync.js";
import { resolveActiveTargets, DEFAULT_SKILL_TARGETS } from "../skills/targets.js";
import { refreshAutogen, AUTOGEN_START, AUTOGEN_END } from "../skills/gen.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "rxcli-wave4-"));
  dirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// B1: stale lock recovery
// ---------------------------------------------------------------------------

describe("B1: withFileLockSync reclaims a stale lock", () => {
  it("reclaims a lockfile whose owner PID is dead", () => {
    const dir = tempDir();
    // pre-create a stale lock for key "sync" with a dead PID
    const lockPath = join(dir, ".rxcli-sync.lock");
    const handle = openSync(lockPath, "w");
    writeSync(handle, JSON.stringify({ pid: 999_999, startedAt: 1 }));
    closeSync(handle);

    let ran = false;
    const result = withFileLockSync(dir, "sync", () => {
      ran = true;
      return "done";
    });
    expect(result).toBe("done");
    expect(ran).toBe(true);
    // lock released after the operation
    expect(existsSync(lockPath)).toBe(false);
  });

  it("throws when a live lock is held (cannot be reclaimed)", () => {
    const dir = tempDir();
    const lockPath = join(dir, ".rxcli-sync.lock");
    // owner = current process (alive) and fresh → not stale
    const handle = openSync(lockPath, "w");
    writeSync(handle, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    closeSync(handle);

    expect(() => withFileLockSync(dir, "sync", () => "x")).toThrow(/held by another process/);
  });
});

// ---------------------------------------------------------------------------
// L7: listSkills resilience
// ---------------------------------------------------------------------------

describe("L7: listSkills skips a bad/escaping entry", () => {
  it("returns the good skill and skips one whose SKILL.md escapes the root", () => {
    const root = tempDir();
    // good skill
    mkdirSync(join(root, "good"), { recursive: true });
    writeFileSync(join(root, "good", "SKILL.md"), "---\ndescription: good one\n---\n# good\n");
    // bad skill: SKILL.md is a symlink resolving outside the root
    mkdirSync(join(root, "bad"), { recursive: true });
    const outside = join(root, "outside-target.md");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(root, "bad", "SKILL.md"));

    const skills = listSkills(root);
    const names = skills.map((s) => s.name);
    expect(names).toEqual(["good"]);
  });
});

// ---------------------------------------------------------------------------
// L8: listPath resilience
// ---------------------------------------------------------------------------

describe("L8: listPath does not crash on a dangling symlink entry", () => {
  it("lists a directory containing a dangling symlink without throwing", () => {
    const root = tempDir();
    mkdirSync(join(root, "skill", "references"), { recursive: true });
    writeFileSync(join(root, "skill", "SKILL.md"), "---\ndescription: x\n---\n");
    writeFileSync(join(root, "skill", "references", "real.md"), "real");
    // dangling symlink inside references
    symlinkSync("/nonexistent/target", join(root, "skill", "references", "dangling.md"));

    const { entries } = listPath(root, "skill/references");
    const paths = entries.map((e) => e.path);
    // did not throw; the real file is still listed (the dangling symlink may be skipped)
    expect(paths).toContain("skill/references/real.md");
  });
});

// ---------------------------------------------------------------------------
// B2: sync dereferences symlinks
// ---------------------------------------------------------------------------

describe("B2: replaceDirectoryTransaction dereferences symlinks", () => {
  it("materializes an internal symlink into a real file in the destination", () => {
    const src = tempDir();
    mkdirSync(join(src, "refs"), { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "head");
    writeFileSync(join(src, "refs", "real.md"), "body");
    // internal relative symlink
    symlinkSync("../SKILL.md", join(src, "refs", "link.md"));
    expect(lstatSync(join(src, "refs", "link.md")).isSymbolicLink()).toBe(true);

    const dest = join(tempDir(), "copied");
    replaceDirectoryTransaction(src, dest);

    const synced = join(dest, "refs", "link.md");
    expect(existsSync(synced)).toBe(true);
    // dereferenced → a regular file containing the target content, not a symlink
    expect(lstatSync(synced).isSymbolicLink()).toBe(false);
    expect(readFileSync(synced, "utf8")).toBe("head");
  });

  it("breaks a symlink cycle instead of recursing forever", () => {
    const src = tempDir();
    writeFileSync(join(src, "SKILL.md"), "head");
    mkdirSync(join(src, "refs"), { recursive: true });
    writeFileSync(join(src, "refs", "real.md"), "body");
    // a symlink pointing at an ancestor directory → would recurse forever
    // (until stack overflow) without the cycle guard.
    symlinkSync(src, join(src, "loop"));

    const dest = join(tempDir(), "copied");
    // Must not throw (RangeError from stack overflow) or hang.
    expect(() => replaceDirectoryTransaction(src, dest)).not.toThrow();

    // real files are still copied...
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("head");
    expect(readFileSync(join(dest, "refs", "real.md"), "utf8")).toBe("body");
    // ...and the loop was entered exactly once: its target was already seen on
    // the second hit, so no nested loop dir is created.
    expect(existsSync(join(dest, "loop", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "loop", "loop"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M10: refreshAutogen preserves content outside the block
// ---------------------------------------------------------------------------

describe("M10: refreshAutogen preserves content outside the AUTO-GEN block", () => {
  const opts = {
    commands: {
      ping: { name: "ping", description: "ping", async run() {} } as never,
    },
  };

  it("does not trim leading whitespace when appending a new block", () => {
    const existing = "   \n# My Skill\n\nSome intro.\n";
    const result = refreshAutogen(existing, "mycli", opts);
    // leading spaces preserved (previously trimStart stripped them)
    expect(result.startsWith("   ")).toBe(true);
    expect(result).toContain("# My Skill");
    expect(result).toContain(AUTOGEN_START);
  });

  it("preserves trailing user content after a replaced block", () => {
    const existing = `# Skill\n\n${AUTOGEN_START}\nold block\n${AUTOGEN_END}\n\n## Notes\n\nTrailing user notes.\n`;
    const result = refreshAutogen(existing, "mycli", opts);
    expect(result).toContain("## Notes");
    expect(result).toContain("Trailing user notes.");
    expect(result).not.toContain("old block");
    expect(result).toContain(AUTOGEN_START);
  });
});

// ---------------------------------------------------------------------------
// M12: resolveActiveTargets respects a custom list
// ---------------------------------------------------------------------------

describe("M12: resolveActiveTargets with a custom target list", () => {
  it("does not force-add the default agents target when the custom list omits it", () => {
    // parent dir (tmpdir) exists → custom target counts as installed and is included,
    // but the default "agents" target must NOT be force-added.
    const custom = [{ key: "custom-only", dir: join(tmpdir(), "rxcli-custom-only-target") }];
    const result = resolveActiveTargets(custom);
    expect(result.map((t) => t.key)).toEqual(["custom-only"]);
    expect(result.map((t) => t.key)).not.toContain("agents");
  });

  it("still injects agents for the default list", () => {
    const result = resolveActiveTargets(DEFAULT_SKILL_TARGETS);
    expect(result.map((t) => t.key)).toContain("agents");
  });
});

// ---------------------------------------------------------------------------
// lockStaleAfterMs option threading
// ---------------------------------------------------------------------------

describe("syncSkills lockStaleAfterMs option", () => {
  it("accepts a custom lockStaleAfterMs and completes the sync", () => {
    const root = tempDir();
    mkdirSync(join(root, "good"), { recursive: true });
    writeFileSync(join(root, "good", "SKILL.md"), "---\ndescription: x\n---\n# good\n");
    const dest = join(tempDir(), "out");

    const res = syncSkills(root, {
      targets: [{ key: "t", dir: dest }],
      lockStaleAfterMs: 1000,
    });
    expect(res.targets.find((t) => t.key === "t")?.ok).toBe(true);
    expect(existsSync(join(dest, "good", "SKILL.md"))).toBe(true);
  });
});
