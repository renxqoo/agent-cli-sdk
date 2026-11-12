import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillRepository } from "../skills/repository.js";
import { AUTOGEN_START } from "../skills/gen.js";

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
  it.each(["$&", "$$", "$`", "$'"])(
    "preserves literal replacement token %s across repeated generation",
    (token) => {
      const { root } = repository();
      const description = `Replace using literal ${token} text`;
      const skills = new SkillRepository({
        root,
        binName: "demo",
        cli: {
          name: "demo",
          commands: {
            replace: {
              name: "replace",
              description,
              async run() {
                return { data: null };
              },
            },
          },
        },
      });
      const generated = skills.generate({ name: "text", initialize: true });
      const initial = readFileSync(generated.path, "utf8");
      const original = `Manual prefix\n${initial}\nManual suffix\n`;
      writeFileSync(generated.path, original);
      for (let iteration = 0; iteration < 2; iteration++) {
        skills.generate({ name: "text" });
        const refreshed = readFileSync(generated.path, "utf8");
        expect(refreshed).toBe(original);
        expect(refreshed).toContain(
          token === "$`" ? "Replace using literal $&#96; text" : description,
        );
        expect(refreshed.split(AUTOGEN_START)).toHaveLength(2);
      }
    },
  );
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
