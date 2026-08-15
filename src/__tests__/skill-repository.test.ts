import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillRepository } from "../skills/repository.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function repository() {
  const root = mkdtempSync(join(tmpdir(), "skill-repository-"));
  roots.push(root);
  return {
    root,
    repository: new SkillRepository({
      root,
      binName: "acme",
      cli: { name: "acme", binName: "acme", commands: {}, namespaces: {} },
      targets: [],
    }),
  };
}

describe("SkillRepository boundary", () => {
  it("owns generation, discovery and raw content reads", () => {
    const { repository: skills } = repository();
    const generated = skills.generate({ name: "orders", initialize: true });
    expect(generated.mode).toBe("init");
    expect(skills.list().map((skill) => skill.name)).toEqual(["orders"]);
    expect(skills.read("orders")).toContain("name: orders");
  });

  it("refreshes only the generated region", () => {
    const { root, repository: skills } = repository();
    mkdirSync(join(root, "orders"), { recursive: true });
    writeFileSync(
      join(root, "orders", "SKILL.md"),
      "---\nname: orders\ndescription: custom\n---\n\nHuman text\n",
    );
    skills.generate({ name: "orders" });
    const content = readFileSync(join(root, "orders", "SKILL.md"), "utf8");
    expect(content).toContain("Human text");
    expect(content).toContain("AUTO-GEN:START");
  });
});
