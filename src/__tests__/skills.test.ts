import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSubPath, listPath, readSkill } from "../skills/reader.js";
import { syncSkills } from "../skills/sync.js";
import {
  DEFAULT_SKILL_TARGETS,
  resolveSkillTargets,
  resolveActiveTargets,
  isTargetInstalled,
  expandTargetDir,
  type SkillTarget,
} from "../skills/targets.js";
import {
  signatureLine,
  argsTable,
  generateAutogenBlock,
  refreshAutogen,
  generateSkillSkeleton,
  AUTOGEN_START,
  AUTOGEN_END,
} from "../skills/gen.js";
import { defineCommand, defineCommands } from "../index.js";
import { NotFoundError } from "../errs/index.js";
import type { DefineCliOptions } from "../types.js";
import * as z from "zod";

describe("cleanSubPath: 路径穿越校验(安全边界)", () => {
  it("合法相对路径通过", () => {
    expect(cleanSubPath("references/orders.md")).toBe("references/orders.md");
    expect(cleanSubPath("a/b/c.md")).toBe("a/b/c.md");
  });

  it("拒绝绝对路径(POSIX)", () => {
    expect(() => cleanSubPath("/etc/passwd")).toThrow();
  });

  it("拒绝 Windows 绝对路径", () => {
    expect(() => cleanSubPath("C:\\windows\\system32")).toThrow();
  });

  it("拒绝 .. 穿越", () => {
    expect(() => cleanSubPath("../../../etc/passwd")).toThrow();
    expect(() => cleanSubPath("..")).toThrow();
    expect(() => cleanSubPath("../secret")).toThrow();
  });

  it("拒绝空路径", () => {
    expect(() => cleanSubPath("")).toThrow();
  });
});

describe("gen: 命令签名生成", () => {
  it("required positional → <id>", () => {
    const cmd = {
      path: "get",
      spec: defineCommand({
        name: "get",
        description: "查详情",
        args: { schema: z.object({ id: z.string() }), pos: ["id"] },
        async run() {},
      }),
    };
    expect(signatureLine("rxcli-orders", cmd)).toBe("rxcli-orders get <id>");
  });

  it("optional flag → [--limit <number>]", () => {
    const cmd = {
      path: "list",
      spec: defineCommand({
        name: "list",
        description: "列表",
        args: {
          schema: z.object({
            limit: z.coerce.number().default(30),
            status: z.string().optional(),
          }),
        },
        async run() {},
      }),
    };
    const sig = signatureLine("rxcli-orders", cmd);
    expect(sig).toContain("[--limit <number>]");
    expect(sig).toContain("[--status <string>]");
    expect(sig).toContain("rxcli-orders list");
  });

  it("boolean flag → [--flag]", () => {
    const cmd = {
      path: "force",
      spec: defineCommand({
        name: "force",
        description: "强制",
        args: { schema: z.object({ force: z.boolean().default(false) }) },
        async run() {},
      }),
    };
    expect(signatureLine("rxcli", cmd)).toBe("rxcli force [--force]");
  });

  it("array flag 的元素类型签名是 string", () => {
    const cmd = {
      path: "search",
      spec: defineCommand({
        name: "search",
        description: "search",
        args: { schema: z.object({ tag: z.array(z.string()).default([]) }) },
        async run() {},
      }),
    };
    expect(signatureLine("rxcli", cmd)).toBe("rxcli search [--tag <value>...]");
  });
});

describe("gen: AUTO-GEN 块生成", () => {
  const cliOptions: Pick<DefineCliOptions<any>, "commands" | "namespaces"> = {
    commands: defineCommands({
      list: defineCommand({
        name: "list",
        description: "查询订单列表",
        args: {
          schema: z.object({
            limit: z.coerce.number().describe("返回数量上限").default(30),
          }),
        },
        async run() {},
      }),
      get: defineCommand({
        name: "get",
        description: "查询订单详情",
        args: { schema: z.object({ id: z.string() }), pos: ["id"] },
        async run() {},
      }),
    }),
  };

  it("generateAutogenBlock 只生成命令索引表(不含参数说明)", () => {
    const block = generateAutogenBlock("rxcli-orders", cliOptions);
    expect(block).toContain("## Commands");
    expect(block).toContain("| Operation | Command |");
    expect(block).toContain("查询订单列表");
    expect(block).toContain("rxcli-orders list");
    // 参数细节不进 AUTO-GEN 块(交给 references 按需加载)
    expect(block).not.toContain("### Argument");
    expect(block).not.toContain("| Argument | Type |");
    expect(block).not.toContain("返回数量上限");
  });

  it("generateAutogenBlock 含无参命令时只列命令索引", () => {
    const opts: Pick<DefineCliOptions<any>, "commands" | "namespaces"> = {
      commands: defineCommands({
        ping: defineCommand({ name: "ping", description: "无参命令", async run() {} }),
        list: defineCommand({
          name: "list",
          description: "有参命令",
          args: {
            schema: z.object({ limit: z.coerce.number().describe("上限").default(10) }),
          },
          async run() {},
        }),
      }),
    };
    const block = generateAutogenBlock("demo", opts);
    expect(block).toContain("demo ping");
    expect(block).toContain("demo list");
    expect(block).not.toContain("### Argument");
    expect(block).not.toContain("无参数");
  });

  it("refreshAutogen 替换已有块,块外语义内容保留", () => {
    const existing = `# orders

这是人写的语义内容,gen 不该动。

${AUTOGEN_START}
旧的块内容,该被替换
${AUTOGEN_END}

## 何时用
人写的,保留。
`;
    const updated = refreshAutogen(existing, "rxcli-orders", cliOptions);
    // 块外语义内容保留
    expect(updated).toContain("这是人写的语义内容,gen 不该动。");
    expect(updated).toContain("## 何时用");
    expect(updated).toContain("人写的,保留。");
    // 块内容被替换
    expect(updated).not.toContain("旧的块内容,该被替换");
    expect(updated).toContain("rxcli-orders list");
  });

  it("refreshAutogen 无块时接在末尾", () => {
    const existing = "# orders\n\n手写简介";
    const updated = refreshAutogen(existing, "rxcli-orders", cliOptions);
    expect(updated).toContain("手写简介");
    expect(updated).toContain(AUTOGEN_START);
    expect(updated).toContain("rxcli-orders list");
  });
});

describe("gen: 骨架生成(--init)", () => {
  it("generateSkillSkeleton 含 frontmatter + AUTO-GEN 块 + {{FILL}} 占位", () => {
    const cliOptions: Pick<DefineCliOptions<any>, "commands" | "namespaces"> = {
      commands: defineCommands({
        list: defineCommand({ name: "list", description: "列表", async run() {} }),
      }),
    };
    const skel = generateSkillSkeleton("orders", "查询订单", "rxcli-orders", cliOptions);
    expect(skel).toContain("---");
    expect(skel).toContain("name: orders");
    expect(skel).toContain("description: 查询订单");
    expect(skel).toContain("{{FILL"); // 占位
    expect(skel).toContain(AUTOGEN_START);
    expect(skel).toContain("rxcli-orders list");
    expect(skel).not.toContain("## When to use");
    expect(skel).toContain("## Error handling");
  });
});

describe("gen: lang 参数(中英文)", () => {
  const cliOptions: Pick<DefineCliOptions<any>, "commands" | "namespaces"> = {
    commands: defineCommands({
      list: defineCommand({
        name: "list",
        description: "查询订单列表",
        args: {
          schema: z.object({
            limit: z.coerce.number().describe("返回数量上限").optional(),
          }),
        },
        async run() {},
      }),
    }),
  };

  it("generateAutogenBlock lang='en' (默认) → 英文表头", () => {
    const block = generateAutogenBlock("rxcli", cliOptions);
    expect(block).toContain("## Commands");
    expect(block).toContain("| Operation | Command |");
    expect(block).not.toContain("## 命令");
  });

  it("generateAutogenBlock lang='zh' → 中文表头", () => {
    const block = generateAutogenBlock("rxcli", cliOptions, "zh");
    expect(block).toContain("## 命令");
    expect(block).toContain("| 操作 | 命令 |");
    expect(block).not.toContain("## Commands");
  });

  it("argsTable lang='en' (默认) → 英文表头 + yes/no", () => {
    const table = argsTable({
      schema: z.object({
        id: z.string().describe("ID"),
        tag: z.string().describe("标签").optional(),
      }),
    });
    expect(table).toContain("| Argument | Type | Required | Default | Description |");
    expect(table).toMatch(/\| .* \| .* \| yes \|/); // id required
    expect(table).toMatch(/\| .* \| .* \| no \|/); // tag optional
  });

  it("argsTable lang='zh' → 中文表头 + 是/否", () => {
    const table = argsTable(
      {
        schema: z.object({
          id: z.string().describe("ID"),
          tag: z.string().describe("标签").optional(),
        }),
      },
      "zh",
    );
    expect(table).toContain("| 参数 | 类型 | 必填 | 默认 | 说明 |");
    expect(table).toMatch(/\| .* \| .* \| 是 \|/);
    expect(table).toMatch(/\| .* \| .* \| 否 \|/);
  });

  it("generateSkillSkeleton lang='zh' → 中文章节标题 + 中文占位", () => {
    const skel = generateSkillSkeleton("orders", "查询订单", "rxcli", cliOptions, "zh");
    expect(skel).not.toContain("## 何时用");
    expect(skel).not.toContain("## 前置条件");
    expect(skel).toContain("## 错误处理");
    expect(skel).toContain("本区块由");
    expect(skel).toContain("{{FILL: 一句话");
    expect(skel).not.toContain("## When to use");
  });

  it("generateSkillSkeleton lang='en' (默认) → 英文章节标题", () => {
    const skel = generateSkillSkeleton("orders", "查询订单", "rxcli", cliOptions);
    expect(skel).not.toContain("## When to use");
    expect(skel).not.toContain("## Prerequisites");
    expect(skel).toContain("## Error handling");
    expect(skel).toContain("do not edit by hand");
    expect(skel).toContain("{{FILL: one sentence");
    expect(skel).not.toContain("## 何时用");
  });

  it("refreshAutogen lang='zh' → 中文 AUTO-GEN 注释 + 命令表", () => {
    const updated = refreshAutogen("# orders\n\n简介", "rxcli", cliOptions, "zh");
    expect(updated).toContain("本区块由");
    expect(updated).toContain("## 命令");
    expect(updated).toContain("| 操作 | 命令 |");
    // 块外语义内容保留
    expect(updated).toContain("简介");
  });
});

// ============================================================================
// 测试辅助:创建临时 skill 目录
// ============================================================================
let tmpRoot: string;
let tmpDest: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rxcli-src-"));
  tmpDest = mkdtempSync(join(tmpdir(), "rxcli-dest-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(tmpDest, { recursive: true, force: true });
});

function makeSkill(root: string, name: string, desc = "x") {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\nbody`,
  );
}

describe("skill 文件安全边界", () => {
  it("拒绝指向 skillsRoot 外部文件的 SKILL.md 符号链接", () => {
    const outside = join(tmpDest, "outside-secret.md");
    writeFileSync(outside, "TOP_SECRET");
    mkdirSync(join(tmpRoot, "leak"), { recursive: true });
    symlinkSync(outside, join(tmpRoot, "leak", "SKILL.md"));

    expect(() => readSkill(tmpRoot, "leak")).toThrow(/outside|allowed directory/i);
  });
});

// ============================================================================
// M4: syncSkills 应清理源端已删除的 skill(全量同步语义)
// ============================================================================
describe("M4: syncSkills 全量同步(清理源端已删除的 skill)", () => {
  it("源端删除的 skill 应从 destDir 移除", () => {
    // 初始:src 有 alpha + beta
    makeSkill(tmpRoot, "alpha");
    makeSkill(tmpRoot, "beta");
    syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
    expect(existsSync(join(tmpDest, "alpha"))).toBe(true);
    expect(existsSync(join(tmpDest, "beta"))).toBe(true);

    // 第二次:src 删掉 beta,只留 alpha
    rmSync(join(tmpRoot, "beta"), { recursive: true, force: true });
    syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });

    // 期望:destDir 的 beta 也被清理(全量同步语义),alpha 仍在
    expect(existsSync(join(tmpDest, "alpha"))).toBe(true);
    expect(existsSync(join(tmpDest, "beta"))).toBe(false); // 当前 bug:仍存在(残留)
  });

  it("新增的 skill 被同步过来", () => {
    makeSkill(tmpRoot, "alpha");
    syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
    makeSkill(tmpRoot, "gamma");
    syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
    expect(existsSync(join(tmpDest, "alpha"))).toBe(true);
    expect(existsSync(join(tmpDest, "gamma"))).toBe(true);
  });

  it("返回同步数量", () => {
    makeSkill(tmpRoot, "a");
    makeSkill(tmpRoot, "b");
    const { count } = syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
    expect(count).toBe(2);
  });

  it("不误删 destDir 中其他来源的无关目录(仅清理已知 skill 名)", () => {
    // destDir 里有个非 skill 的目录(其他工具放的),sync 不该删它
    mkdirSync(join(tmpDest, "other-tool-data"), { recursive: true });
    makeSkill(tmpRoot, "alpha");
    syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
    expect(existsSync(join(tmpDest, "other-tool-data"))).toBe(true);
  });

  it("不删除另一个业务包同步到同一 destDir 的 skill", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "rxcli-other-src-"));
    try {
      makeSkill(tmpRoot, "orders");
      makeSkill(otherRoot, "products");
      syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
      syncSkills(otherRoot, { targets: [{ key: "test", dir: tmpDest }] });
      expect(existsSync(join(tmpDest, "orders", "SKILL.md"))).toBe(true);
      expect(existsSync(join(tmpDest, "products", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("同名 skill 的一个 owner 删除后恢复另一 owner 的副本", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "rxcli-other-src-"));
    try {
      makeSkill(tmpRoot, "shared", "from-a");
      makeSkill(otherRoot, "shared", "from-b");
      syncSkills(otherRoot, { targets: [{ key: "test", dir: tmpDest }] });
      syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
      rmSync(join(tmpRoot, "shared"), { recursive: true, force: true });
      syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
      expect(readFileSync(join(tmpDest, "shared", "SKILL.md"), "utf8")).toContain("from-b");
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// M7: listPath 不存在的子路径应抛 NotFoundError(而非裸 statSync ENOENT)
// ============================================================================
describe("M7: listPath 错误处理", () => {
  it("skill 存在但子路径不存在 → NotFoundError(不抛裸 statSync 错误)", () => {
    makeSkill(tmpRoot, "orders");
    // 子路径 references 不存在:当前 statSync 抛裸 ENOENT → 被 pipeline 兜底成 internal/unknown
    expect(() => listPath(tmpRoot, "orders/nonexistent-sub")).toThrow(NotFoundError);
  });

  it("不存在的 skill → NotFoundError", () => {
    expect(() => listPath(tmpRoot, "ghost")).toThrow(NotFoundError);
  });

  it("子路径是文件不是目录 → InternalError(contract_violation)", () => {
    makeSkill(tmpRoot, "orders");
    mkdirSync(join(tmpRoot, "orders", "refs"), { recursive: true });
    writeFileSync(join(tmpRoot, "orders", "refs", "a.md"), "x");
    // listPath 指向文件应给 contract_violation 提示,而非裸错误
    expect(() => listPath(tmpRoot, "orders/refs/a.md")).toThrow(/file, not a directory|不是目录/);
  });
});

// ============================================================================
// targets 组件:默认列表 / 覆盖 / 展开
// ============================================================================
describe("targets 组件:默认列表 + 覆盖 + 展开", () => {
  it("DEFAULT_SKILL_TARGETS 含 7 个主流工具,key 唯一", () => {
    expect(DEFAULT_SKILL_TARGETS.length).toBe(7);
    const keys = DEFAULT_SKILL_TARGETS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length); // key 唯一
    // 覆盖用户点名的 7 个工具
    for (const k of ["agents", "claude", "codex", "cursor", "zcode", "openclaw", "pi"]) {
      expect(keys).toContain(k);
    }
  });

  it("默认 dir 都以 ~/ 开头(可读形式,展开前)", () => {
    for (const t of DEFAULT_SKILL_TARGETS) {
      expect(t.dir.startsWith("~/")).toBe(true);
    }
  });

  it("resolveSkillTargets(undefined) → 默认列表副本(改副本不影响原)", () => {
    const a = resolveSkillTargets();
    const b = resolveSkillTargets();
    expect(a).toEqual([...DEFAULT_SKILL_TARGETS]);
    expect(a).not.toBe(DEFAULT_SKILL_TARGETS); // 返回副本,非原引用
    expect(a).not.toBe(b);
  });

  it("resolveSkillTargets(非空) → 完全覆盖默认", () => {
    const custom: SkillTarget[] = [{ key: "mytool", dir: "/tmp/mytool-skills" }];
    expect(resolveSkillTargets(custom)).toEqual(custom);
    // 不含默认的 claude
    expect(resolveSkillTargets(custom).some((t) => t.key === "claude")).toBe(false);
  });

  it("resolveSkillTargets([]) → 空数组(关闭多 target)", () => {
    expect(resolveSkillTargets([])).toEqual([]);
  });

  it("expandTargetDir 展开 ~ 和 ~/", () => {
    // 跨平台:Windows 上 path.join 把 / 转成 \,所以用 [\/\\] 兼容两种分隔符
    expect(expandTargetDir("~/.claude/skills")).toMatch(/[/\\]\.claude[/\\]skills$/);
    expect(expandTargetDir("~").length).toBeGreaterThan(0); // 展开成家目录绝对路径
    // 不含 ~ 的路径原样返回
    expect(expandTargetDir("/abs/path")).toBe("/abs/path");
    expect(expandTargetDir("relative/path")).toBe("relative/path");
    // Windows 风格 ~\ 也展开(跨平台兼容)
    const winExpanded = expandTargetDir("~\\.claude\\skills");
    expect(winExpanded).not.toContain("~");
    expect(winExpanded.length).toBeGreaterThan(".claude".length);
  });
});

// ============================================================================
// 多 target 同步:syncSkills(skillsRoot, { targets })
// ============================================================================
describe("多 target 同步:syncSkills({ targets })", () => {
  it("同步到多个 target 目录,返回汇总结果", () => {
    makeSkill(tmpRoot, "alpha");
    const dirA = mkdtempSync(join(tmpdir(), "rxcli-tgtA-"));
    const dirB = mkdtempSync(join(tmpdir(), "rxcli-tgtB-"));
    try {
      const targets: SkillTarget[] = [
        { key: "toolA", dir: dirA },
        { key: "toolB", dir: dirB },
      ];
      const res = syncSkills(tmpRoot, { targets });
      expect(res.count).toBe(1);
      expect(res.targets).toHaveLength(2);
      expect(res.targets.every((t) => t.ok)).toBe(true);
      // 两个目录都有 skill
      expect(existsSync(join(dirA, "alpha", "SKILL.md"))).toBe(true);
      expect(existsSync(join(dirB, "alpha", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("单个 target 失败不中断其余,失败项带 error", () => {
    makeSkill(tmpRoot, "beta");
    const dirOk = mkdtempSync(join(tmpdir(), "rxcli-tgtOk-"));
    // 非法路径:空字符串会让 mkdirSync 抛错
    const badDir = "";
    try {
      const targets: SkillTarget[] = [
        { key: "bad", dir: badDir },
        { key: "ok", dir: dirOk },
      ];
      const res = syncSkills(tmpRoot, { targets });
      const badRes = res.targets.find((t) => t.key === "bad");
      const okRes = res.targets.find((t) => t.key === "ok");
      expect(badRes?.ok).toBe(false);
      expect(badRes?.error).toBeTruthy();
      expect(okRes?.ok).toBe(true);
      // 失败 target 不影响成功 target:ok 目录有 skill
      expect(existsSync(join(dirOk, "beta", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(dirOk, { recursive: true, force: true });
    }
  });

  it("省略 targets → 用默认列表(7 个)", () => {
    // 用显式 targets(绝对路径,指向临时目录)模拟"默认列表展开后"的样子,
    // 验证 syncSkills 逐个同步。不依赖 homedir mock(ESM 静态绑定难 mock)。
    makeSkill(tmpRoot, "gamma");
    const fakeHome = mkdtempSync(join(tmpdir(), "rxcli-fakehome-"));
    // 复刻默认 7 个 target,但 dir 用 fakeHome 下的绝对路径
    const targets: SkillTarget[] = DEFAULT_SKILL_TARGETS.map((t) => ({
      key: t.key,
      dir: t.dir.replace(/^~/, fakeHome),
    }));
    try {
      const res = syncSkills(tmpRoot, { targets });
      expect(res.count).toBe(1);
      expect(res.targets).toHaveLength(7);
      const keys = res.targets.map((t) => t.key);
      expect(keys).toEqual(DEFAULT_SKILL_TARGETS.map((t) => t.key));
      expect(res.targets.every((t) => t.ok)).toBe(true);
      // 逐个目录都有 skill
      const claudeDir = res.targets.find((t) => t.key === "claude")!;
      expect(existsSync(join(claudeDir.dir, "gamma", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("单元素 targets 只同步到一个目录", () => {
    makeSkill(tmpRoot, "delta");
    const only = mkdtempSync(join(tmpdir(), "rxcli-only-"));
    try {
      const res = syncSkills(tmpRoot, { targets: [{ key: "custom", dir: only }] });
      expect(res.targets).toHaveLength(1);
      expect(res.targets[0]!.ok).toBe(true);
      expect(existsSync(join(only, "delta", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(only, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 探测模式(detect):只写已装工具 + ~/.agents 兜底
// ============================================================================
describe("探测组件:isTargetInstalled / resolveActiveTargets", () => {
  it("isTargetInstalled:父目录存在 → true", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "rxcli-inst-home-"));
    try {
      // 模拟用户装了 claude(创建 ~/.claude)但没装 codex
      mkdirSync(join(fakeHome, ".claude"), { recursive: true });
      const installed = isTargetInstalled({
        key: "claude",
        dir: join(fakeHome, ".claude", "skills"),
      });
      const missing = isTargetInstalled({ key: "codex", dir: join(fakeHome, ".codex", "skills") });
      expect(installed).toBe(true); // ~/.claude 存在
      expect(missing).toBe(false); // ~/.codex 不存在
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("resolveActiveTargets:~/.agents 始终纳入,其余只留已装的", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "rxcli-active-home-"));
    try {
      // 模拟用户只装了 claude + cursor
      mkdirSync(join(fakeHome, ".claude"), { recursive: true });
      mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
      // candidates:复刻默认 7 个,dir 指向 fakeHome
      const candidates: SkillTarget[] = DEFAULT_SKILL_TARGETS.map((t) => ({
        key: t.key,
        dir: t.dir.replace(/^~/, fakeHome),
      }));
      const active = resolveActiveTargets(candidates);
      const keys = active.map((t) => t.key);
      // ~/.agents 始终在(兜底,即便 ~/.agents 目录没创建)
      expect(keys).toContain("agents");
      // 已装的 claude / cursor 在
      expect(keys).toContain("claude");
      expect(keys).toContain("cursor");
      // 没装的 codex / zcode / openclaw / pi 不在
      expect(keys).not.toContain("codex");
      expect(keys).not.toContain("zcode");
      expect(keys).not.toContain("openclaw");
      expect(keys).not.toContain("pi");
      // 总共 3 个:agents + claude + cursor
      expect(active).toHaveLength(3);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("resolveActiveTargets:用户一个工具都没装 → 只剩 agents 兜底", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "rxcli-empty-home-"));
    try {
      const candidates: SkillTarget[] = DEFAULT_SKILL_TARGETS.map((t) => ({
        key: t.key,
        dir: t.dir.replace(/^~/, fakeHome),
      }));
      const active = resolveActiveTargets(candidates);
      expect(active).toHaveLength(1);
      expect(active[0]!.key).toBe("agents");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("resolveActiveTargets:去重(agents 不重复)", () => {
    const candidates: SkillTarget[] = [
      { key: "agents", dir: "/tmp/x/.agents/skills" },
      { key: "agents", dir: "/tmp/y/.agents/skills" }, // 同 key 重复
      { key: "claude", dir: "/tmp/x/.claude/skills" },
    ];
    const active = resolveActiveTargets(candidates);
    const agentsCount = active.filter((t) => t.key === "agents").length;
    expect(agentsCount).toBe(1); // 只保留第一个
  });
});

describe("探测模式同步:syncSkills() 省略 opts → 探测", () => {
  it("默认探测:只写 ~/.agents + 已装工具,未装的记 skipped", () => {
    makeSkill(tmpRoot, "epsilon");
    const fakeHome = mkdtempSync(join(tmpdir(), "rxcli-detect-home-"));
    try {
      // 模拟用户只装了 claude
      mkdirSync(join(fakeHome, ".claude"), { recursive: true });
      // mock homedir → 用显式 targets + detect:true 模拟(避开 ESM homedir mock 难题)
      const targets: SkillTarget[] = DEFAULT_SKILL_TARGETS.map((t) => ({
        key: t.key,
        dir: t.dir.replace(/^~/, fakeHome),
      }));
      const res = syncSkills(tmpRoot, { targets, detect: true });
      const written = res.targets.filter((t) => t.ok);
      const skipped = res.targets.filter((t) => t.skipped);
      // 写入:agents(兜底) + claude(已装)= 2
      expect(written.map((t) => t.key).sort()).toEqual(["agents", "claude"]);
      expect(existsSync(join(fakeHome, ".agents", "skills", "epsilon", "SKILL.md"))).toBe(true);
      expect(existsSync(join(fakeHome, ".claude", "skills", "epsilon", "SKILL.md"))).toBe(true);
      // 跳过:codex/cursor/zcode/openclaw/pi = 5
      expect(skipped.map((t) => t.key).sort()).toEqual([
        "codex",
        "cursor",
        "openclaw",
        "pi",
        "zcode",
      ]);
      // 跳过的目录不应被创建
      expect(existsSync(join(fakeHome, ".codex", "skills"))).toBe(false);
      expect(existsSync(join(fakeHome, ".cursor", "skills"))).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("detect:false(显式 targets 默认)→ 强制全写,不探测", () => {
    makeSkill(tmpRoot, "zeta");
    const fakeHome = mkdtempSync(join(tmpdir(), "rxcli-nodetect-home-"));
    try {
      // 没装任何工具
      const targets: SkillTarget[] = DEFAULT_SKILL_TARGETS.map((t) => ({
        key: t.key,
        dir: t.dir.replace(/^~/, fakeHome),
      }));
      const res = syncSkills(tmpRoot, { targets }); // detect 默认 false
      const written = res.targets.filter((t) => t.ok);
      expect(written).toHaveLength(7); // 全写
      expect(res.targets.filter((t) => t.skipped)).toHaveLength(0); // 无跳过
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
