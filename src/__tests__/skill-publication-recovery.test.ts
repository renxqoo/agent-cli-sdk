import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fault = vi.hoisted(() => ({
  destination: "",
  activation: "",
  read: "",
  cleanup: false,
  rollback: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (String(args[0]) === fault.read)
        throw Object.assign(new Error("injected source EACCES"), { code: "EACCES" });
      return actual.readFileSync(...args);
    },
    rmSync(path: string, options?: Parameters<typeof actual.rmSync>[1]) {
      if (fault.cleanup && path.endsWith(".publication")) throw new Error("injected cleanup EIO");
      return actual.rmSync(path, options);
    },
    renameSync(source: string, destination: string) {
      if (
        (destination === fault.destination && source.endsWith(".tmp")) ||
        destination === fault.activation ||
        (fault.rollback && source.replaceAll("\\", "/").includes(".publication/previous/"))
      ) {
        throw Object.assign(new Error("injected publication EIO"), { code: "EIO" });
      }
      return actual.renameSync(source, destination);
    },
  };
});
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncSkills } from "../skills/sync.js";

const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "skill-publication-"));
  roots.push(root);
  return root;
}
function skill(root: string, name = "orders", body = "original") {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\n${body}`,
  );
}
function manifest(source: string, target: string) {
  return join(
    target,
    ".rxcli-sync-manifests",
    createHash("sha256").update(source).digest("hex") + ".json",
  );
}
afterEach(() => {
  fault.destination = "";
  fault.activation = "";
  fault.read = "";
  fault.cleanup = false;
  fault.rollback = false;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("complete publication source", () => {
  it("returns per-target failures without touching targets when a skill cannot be read", () => {
    const source = directory(),
      target = directory();
    skill(source);
    const options = { targets: [{ key: "test", dir: target }] };
    syncSkills(source, options);
    const ownership = readFileSync(manifest(source, target));
    fault.read = join(source, "orders/SKILL.md");
    expect(syncSkills(source, options).targets[0]).toMatchObject({
      ok: false,
      error: "injected source EACCES",
    });
    expect(readFileSync(manifest(source, target))).toEqual(ownership);
    expect(readFileSync(join(target, "orders/SKILL.md"), "utf8")).toContain("original");
  });
  it("preserves target bytes and manifest when the source root disappears", () => {
    const parent = directory(),
      source = join(parent, "source"),
      target = directory();
    skill(source);
    const options = { targets: [{ key: "test", dir: target }] };
    expect(syncSkills(source, options).targets[0]?.ok).toBe(true);
    const before = readFileSync(join(target, "orders/SKILL.md"));
    const ownership = readFileSync(manifest(source, target));
    renameSync(source, join(parent, "unavailable"));
    const result = syncSkills(source, options);
    expect(result.targets[0]?.ok).toBe(false);
    expect(readFileSync(join(target, "orders/SKILL.md"))).toEqual(before);
    expect(readFileSync(manifest(source, target))).toEqual(ownership);
  });

  it.each(["escaping-file", "missing-file", "linked-directory"])(
    "fails closed for a previously published %s instead of pruning it",
    (damage) => {
      const source = directory(),
        target = directory(),
        outside = directory();
      skill(source);
      const options = { targets: [{ key: "test", dir: target }] };
      expect(syncSkills(source, options).targets[0]?.ok).toBe(true);
      const before = readFileSync(join(target, "orders/SKILL.md"));
      const ownership = readFileSync(manifest(source, target));
      if (damage === "linked-directory") {
        rmSync(join(source, "orders"), { recursive: true });
        symlinkSync(outside, join(source, "orders"), "junction");
      } else {
        rmSync(join(source, "orders/SKILL.md"));
        if (damage === "escaping-file") {
          writeFileSync(join(outside, "SKILL.md"), "outside");
          symlinkSync(join(outside, "SKILL.md"), join(source, "orders/SKILL.md"));
        }
      }
      expect(syncSkills(source, options).targets[0]?.ok).toBe(false);
      expect(readFileSync(join(target, "orders/SKILL.md"))).toEqual(before);
      expect(readFileSync(manifest(source, target))).toEqual(ownership);
    },
  );

  it("still prunes a deliberately removed directory from a readable source", () => {
    const source = directory(),
      target = directory();
    skill(source);
    const options = { targets: [{ key: "test", dir: target }] };
    syncSkills(source, options);
    rmSync(join(source, "orders"), { recursive: true });
    expect(syncSkills(source, options).targets[0]?.ok).toBe(true);
    expect(existsSync(join(target, "orders"))).toBe(false);
    expect(JSON.parse(readFileSync(manifest(source, target), "utf8")).skills).toEqual([]);
  });
});

describe("publication and ownership recovery", () => {
  it("leaves the previous publication intact when preparing the recovery intent fails", () => {
    const source = directory(),
      target = directory();
    skill(source, "orders", "old");
    const options = { targets: [{ key: "test", dir: target }] };
    syncSkills(source, options);
    const ownership = readFileSync(manifest(source, target));
    skill(source, "orders", "new");
    fault.destination = join(target, ".rxcli-sync-manifests/.publication/intent.json");
    expect(syncSkills(source, options).targets[0]?.ok).toBe(false);
    expect(readFileSync(join(target, "orders/SKILL.md"), "utf8")).toContain("old");
    expect(readFileSync(manifest(source, target))).toEqual(ownership);
    fault.destination = "";
    expect(syncSkills(source, options).targets[0]?.ok).toBe(true);
    expect(readFileSync(join(target, "orders/SKILL.md"), "utf8")).toContain("new");
  });

  it("finalizes a committed publication after interrupted cleanup instead of rolling it back", () => {
    const source = directory(),
      other = directory(),
      target = directory();
    const options = { targets: [{ key: "test", dir: target }] };
    skill(source, "orders", "old");
    syncSkills(source, options);
    skill(source, "orders", "committed");
    fault.cleanup = true;
    expect(syncSkills(source, options).targets[0]?.ok).toBe(false);
    const ownership = readFileSync(manifest(source, target));
    fault.cleanup = false;
    rmSync(source, { recursive: true });
    expect(syncSkills(other, options).targets[0]?.ok).toBe(true);
    expect(readFileSync(join(target, "orders/SKILL.md"), "utf8")).toContain("committed");
    expect(readFileSync(manifest(source, target))).toEqual(ownership);
    expect(readdirSync(join(target, ".rxcli-sync-manifests"))).not.toContain(".publication");
  });
  it.each([false, true])(
    "does not orphan a new skill after manifest EIO (existing manifest: %s)",
    (existing) => {
      const source = directory(),
        target = directory();
      const options = { targets: [{ key: "test", dir: target }] };
      if (existing) expect(syncSkills(source, options).targets[0]?.ok).toBe(true);
      skill(source);
      fault.destination = manifest(source, target);
      const failed = syncSkills(source, options);
      expect(failed.targets[0]?.ok).toBe(false);
      expect(failed.targets[0]?.error).toContain("injected publication EIO");
      fault.destination = "";
      rmSync(join(source, "orders"), { recursive: true });
      expect(syncSkills(source, options).targets[0]?.ok).toBe(true);
      expect(existsSync(join(target, "orders"))).toBe(false);
      expect(JSON.parse(readFileSync(manifest(source, target), "utf8")).skills).toEqual([]);
    },
  );

  it("rolls back earlier activations and deletions when a later activation fails", () => {
    const source = directory(),
      target = directory();
    const options = { targets: [{ key: "test", dir: target }] };
    skill(source, "orders", "old");
    skill(source, "removed", "retain on failure");
    syncSkills(source, options);
    const ownership = readFileSync(manifest(source, target));
    skill(source, "orders", "new");
    rmSync(join(source, "removed"), { recursive: true });
    skill(source, "zebra");
    fault.activation = join(target, "zebra");
    expect(syncSkills(source, options).targets[0]?.ok).toBe(false);
    expect(readFileSync(join(target, "orders/SKILL.md"), "utf8")).toContain("old");
    expect(readFileSync(join(target, "removed/SKILL.md"), "utf8")).toContain("retain on failure");
    expect(existsSync(join(target, "zebra"))).toBe(false);
    expect(readFileSync(manifest(source, target))).toEqual(ownership);
  });

  it("recovers an interrupted rollback before a different source publishes, without consulting the old source", () => {
    const source = directory(),
      other = directory(),
      target = directory();
    const options = { targets: [{ key: "test", dir: target }] };
    skill(source, "orders", "old");
    syncSkills(source, options);
    skill(source, "orders", "failed update");
    fault.destination = manifest(source, target);
    fault.rollback = true;
    expect(syncSkills(source, options).targets[0]?.ok).toBe(false);
    fault.destination = "";
    fault.rollback = false;
    rmSync(source, { recursive: true });
    skill(other, "products", "other source");
    expect(syncSkills(other, options).targets[0]?.ok).toBe(true);
    expect(readFileSync(join(target, "orders/SKILL.md"), "utf8")).toContain("old");
    expect(readFileSync(join(target, "products/SKILL.md"), "utf8")).toContain("other source");
    expect(readdirSync(join(target, ".rxcli-sync-manifests"))).not.toContain(".publication");
  });

  it("preserves another source's same-name skill and unowned user content after a failed first publication", () => {
    const source = directory(),
      other = directory(),
      target = directory();
    const options = { targets: [{ key: "test", dir: target }] };
    skill(other, "orders", "other owner");
    syncSkills(other, options);
    skill(target, "manual", "user content");
    skill(source, "orders", "failed owner");
    skill(source, "manual", "failed overwrite");
    fault.destination = manifest(source, target);
    expect(syncSkills(source, options).targets[0]?.ok).toBe(false);
    fault.destination = "";
    rmSync(join(source, "orders"), { recursive: true });
    rmSync(join(source, "manual"), { recursive: true });
    expect(syncSkills(source, options).targets[0]?.ok).toBe(true);
    expect(readFileSync(join(target, "orders/SKILL.md"), "utf8")).toContain("other owner");
    expect(readFileSync(join(target, "manual/SKILL.md"), "utf8")).toContain("user content");
  });
});
