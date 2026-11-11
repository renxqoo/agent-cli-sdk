import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({ activated: "", source: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(source: string, destination: string) {
      actual.renameSync(source, destination);
      if (destination === mutation.activated) actual.rmSync(mutation.source, { recursive: true });
    },
  };
});
import { syncSkills } from "../skills/sync.js";

const roots: string[] = [];
afterEach(() => {
  mutation.activated = "";
  mutation.source = "";
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

it("publishes the same captured source to every target after the original source disappears", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-source-snapshot-"));
  roots.push(root);
  const source = join(root, "source");
  const skill = join(source, "orders");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: orders\ndescription: captured\n---\n");
  const first = join(root, "first");
  const second = join(root, "second");
  mutation.activated = join(first, "orders");
  mutation.source = skill;
  const result = syncSkills(source, {
    targets: [
      { key: "first", dir: first },
      { key: "second", dir: second },
    ],
  });
  expect(existsSync(skill)).toBe(false);
  expect(result.targets.map((target) => target.ok)).toEqual([true, true]);
  expect(readFileSync(join(first, "orders", "SKILL.md"), "utf8")).toBe(
    readFileSync(join(second, "orders", "SKILL.md"), "utf8"),
  );
});
