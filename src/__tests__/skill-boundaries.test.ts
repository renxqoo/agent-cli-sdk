import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillRepository } from "../skills/repository.js";
import { syncSkills } from "../skills/sync.js";
import { listSkills } from "../skills/reader.js";

const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "skill-boundary-"));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function sourceSkill(root: string, name = "orders") {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), "---\nname: orders\ndescription: orders\n---\n");
  return path;
}

describe("skill filesystem boundaries", () => {
  it("preserves script permissions and republishes a permission-only change", () => {
    const root = directory();
    const skill = sourceSkill(root);
    const target = directory();
    const script = join(skill, "run.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const options = { targets: [{ key: "test", dir: target }] };
    syncSkills(root, options);
    expect(statSync(join(target, "orders", "run.sh")).mode & 0o777).toBe(
      statSync(script).mode & 0o777,
    );
    chmodSync(script, 0o644);
    syncSkills(root, options);
    expect(statSync(join(target, "orders", "run.sh")).mode & 0o777).toBe(
      statSync(script).mode & 0o777,
    );
  });

  it("recovers transaction artifacts before skipping an unchanged target", () => {
    const root = directory();
    const target = directory();
    sourceSkill(root);
    const options = { targets: [{ key: "test", dir: target }] };
    syncSkills(root, options);
    const backup = join(target, ".orders.interrupted.backup");
    const staging = join(target, ".orders.interrupted.tmp");
    mkdirSync(backup);
    mkdirSync(staging);
    writeFileSync(join(backup, "fixture"), "old");
    expect(syncSkills(root, options).targets[0]?.ok).toBe(true);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(staging)).toBe(false);
    expect(readFileSync(join(target, "orders", "SKILL.md"), "utf8")).toContain("orders");
  });
  it("rejects nested links outside the selected skill before publishing anything", () => {
    const root = directory();
    const skill = sourceSkill(root);
    const external = directory();
    const target = directory();
    writeFileSync(join(external, "fixture.txt"), "outside-content");
    symlinkSync(join(external, "fixture.txt"), join(skill, "linked.txt"));
    const result = syncSkills(root, { targets: [{ key: "test", dir: target }] });
    expect(result.targets[0]?.ok).toBe(false);
    expect(result.targets[0]?.error).toContain("outside");
    expect(readdirSync(target)).toEqual([]);
  });

  it("rejects manifest traversal without deleting an adjacent directory", () => {
    const root = directory();
    const parent = directory();
    const target = join(parent, "target");
    sourceSkill(root);
    syncSkills(root, { targets: [{ key: "test", dir: target }] });
    const manifests = join(target, ".rxcli-sync-manifests");
    const file = join(
      manifests,
      readdirSync(manifests).find((name) => name.endsWith(".json"))!,
    );
    const document = JSON.parse(readFileSync(file, "utf8"));
    document.skills = ["../preserved"];
    writeFileSync(file, JSON.stringify(document));
    mkdirSync(join(parent, "preserved"));
    writeFileSync(join(parent, "preserved", "fixture"), "keep");
    const result = syncSkills(root, { targets: [{ key: "test", dir: target }] });
    expect(result.targets[0]?.ok).toBe(false);
    expect(readFileSync(join(parent, "preserved", "fixture"), "utf8")).toBe("keep");
  });

  it("rejects generation through an escaping SKILL.md link", () => {
    const root = directory();
    const external = join(directory(), "fixture.md");
    writeFileSync(external, "keep");
    mkdirSync(join(root, "orders"));
    symlinkSync(external, join(root, "orders", "SKILL.md"));
    const repository = new SkillRepository({
      root,
      binName: "demo",
      cli: { name: "demo", commands: {} },
    });
    expect(() => repository.generate({ name: "orders", initialize: true, force: true })).toThrow(
      /outside/,
    );
    expect(readFileSync(external, "utf8")).toBe("keep");
  });

  it("leaves unchanged skill files in place and repairs changed target contents", () => {
    const root = directory();
    const target = directory();
    sourceSkill(root);
    const options = { targets: [{ key: "test", dir: target }] };
    syncSkills(root, options);
    const path = join(target, "orders", "SKILL.md");
    const before = statSync(path, { bigint: true });
    expect(syncSkills(root, options).targets[0]?.ok).toBe(true);
    const after = statSync(path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    writeFileSync(path, "changed");
    expect(syncSkills(root, options).targets[0]?.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("description: orders");
  });

  it("excludes reserved and invalid directory names from discovery", () => {
    const root = directory();
    sourceSkill(root);
    sourceSkill(root, ".rxcli-sync-manifests");
    expect(listSkills(root).map((skill) => skill.name)).toEqual(["orders"]);
  });
});
