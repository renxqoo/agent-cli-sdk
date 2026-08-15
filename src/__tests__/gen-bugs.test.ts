/**
 * BUG-2 红测:gen --init 对已有 SKILL.md 应要求 --force,而非静默覆盖。
 * BUG-13 红测:formatDefault/desc 不转义,破坏 markdown 表格(argsTable)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinSkillsCommands } from "../skills/builtin.js";
import { argsTable } from "../skills/gen.js";
import { generateSkillSkeleton, refreshAutogen } from "../skills/gen.js";
import { defineCommand, defineCommands } from "../define.js";
import { APIError } from "../errs/index.js";
import type { DefineCliOptions } from "../types.js";
import * as z from "zod";

// ---------------------------------------------------------------------------
// BUG-2: gen --init 已存在文件需 --force
// ---------------------------------------------------------------------------

describe("BUG-2: gen --init 对已有 SKILL.md 应要求 --force", () => {
  let skillsDir: string;
  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), "rxcli-gen-"));
  });
  afterEach(() => rmSync(skillsDir, { recursive: true, force: true }));

  const cliOptions: Pick<DefineCliOptions<any>, "commands" | "namespaces" | "name"> = {
    name: "testcli",
    commands: defineCommands({
      list: defineCommand({ name: "list", description: "list", async run() {} }),
    }),
  };

  it("SKILL.md 已存在 + --init 不带 --force → 抛 ValidationError,文件不变", async () => {
    const cmds = createBuiltinSkillsCommands("testcli", skillsDir, cliOptions);
    // 先建一个有手写内容的 skill
    mkdirSync(join(skillsDir, "orders"), { recursive: true });
    const original = "---\nname: orders\ndescription: 手写内容\n---\n# 我的手写 skill\n";
    writeFileSync(join(skillsDir, "orders", "SKILL.md"), original);

    const gen = cmds.gen;
    await expect(gen.run({} as never, { name: "orders", init: true } as never)).rejects.toThrow(
      APIError,
    );
    await expect(
      gen.run({} as never, { name: "orders", init: true } as never),
    ).rejects.toMatchObject({ subtype: "already_exists" });
    // 文件应保持原样
    expect(readFileSync(join(skillsDir, "orders", "SKILL.md"), "utf8")).toBe(original);
  });

  it("SKILL.md 已存在 + --init --force → 覆盖为骨架", async () => {
    const cmds = createBuiltinSkillsCommands("testcli", skillsDir, cliOptions);
    mkdirSync(join(skillsDir, "orders"), { recursive: true });
    writeFileSync(join(skillsDir, "orders", "SKILL.md"), "old content");
    const gen = cmds.gen;
    const result = await gen.run(
      {} as never,
      {
        name: "orders",
        init: true,
        force: true,
      } as never,
    );
    const data = result?.data as { mode: string };
    expect(data.mode).toBe("init");
    const after = readFileSync(join(skillsDir, "orders", "SKILL.md"), "utf8");
    expect(after).toContain("{{FILL");
    expect(after).not.toContain("old content");
  });

  it("SKILL.md 不存在 + --init → 正常生成骨架(无需 --force)", async () => {
    const cmds = createBuiltinSkillsCommands("testcli", skillsDir, cliOptions);
    const gen = cmds.gen;
    const result = await gen.run({} as never, { name: "fresh", init: true } as never);
    expect(result?.data).toMatchObject({ mode: "init" });
    expect(readFileSync(join(skillsDir, "fresh", "SKILL.md"), "utf8")).toContain("{{FILL");
  });
});

// ---------------------------------------------------------------------------
// BUG-13: formatDefault/desc 不转义 → 破坏 markdown 表格
// ---------------------------------------------------------------------------

describe("BUG-13: argsTable 转义 | 和换行(避免破坏 markdown 表格)", () => {
  it("default 含 | 应转义为 \\|,不增加表格列数", () => {
    const table = argsTable({
      schema: z.object({ tags: z.string().describe("tags").default("a|b") }),
    });
    // 表格只有一行数据(表头 + 分隔 + 1 行),该行应含转义的 \|
    const lines = table.split("\n");
    const dataRow = lines[2]; // [0]=header [1]=separator [2]=data
    expect(dataRow).toBeDefined();
    // 数据行的列数(按未转义的 | 分割应为 6 列)
    const cells = dataRow.split("|").filter((_, i, arr) => i > 0 && i < arr.length - 1);
    expect(cells.length).toBe(6);
    expect(dataRow).toContain("a\\|b");
  });

  it("desc 含换行应转成空格,不破坏表格行", () => {
    const table = argsTable({
      schema: z.object({ note: z.string().describe("line1\nline2").optional() }),
    });
    const dataRow = table.split("\n")[2];
    expect(dataRow).toBeDefined();
    // 不应出现裸换行(已转空格)
    expect(dataRow).not.toContain("\n");
    expect(dataRow).toContain("line1");
    expect(dataRow).toContain("line2");
  });

  it("desc 含 | 同样转义", () => {
    const table = argsTable({
      schema: z.object({ x: z.boolean().describe("a|b|c").default(false) }),
    });
    const dataRow = table.split("\n")[2];
    expect(dataRow).toContain("a\\|b\\|c");
  });
});

describe("skill generation boundaries", () => {
  const options: Pick<DefineCliOptions<any>, "commands" | "namespaces"> = {
    commands: defineCommands({
      list: defineCommand({ name: "list", description: "list", async run() {} }),
    }),
  };

  it("serializes frontmatter values without YAML field injection", () => {
    const generated = generateSkillSkeleton(
      "orders",
      "safe\nadmin: true",
      'rxcli"\nmalicious: true',
      options,
    );
    const frontmatter = generated.split("---")[1] ?? "";

    expect(frontmatter).toContain("safe");
    expect(frontmatter).not.toMatch(/^admin:/m);
    expect(frontmatter).not.toMatch(/^malicious:/m);
  });

  it("rejects malformed AUTO-GEN marker structure instead of duplicating content", () => {
    expect(() =>
      refreshAutogen("# skill\n<!-- AUTO-GEN:START commands -->\nbroken", "rxcli", options),
    ).toThrow(/AUTO-GEN markers/);
  });
});
