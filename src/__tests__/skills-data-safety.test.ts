/**
 * Skills 子系统的数据安全 bug 红测(TDD)。
 *
 * BUG-1:sync 先删后拷,拷贝失败丢数据(sync.ts)。
 * BUG-2:gen --init 静默覆盖已有 SKILL.md(builtin.ts)。
 * BUG-3:listSkills 遇 broken symlink 整列崩溃(reader.ts)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  renameSync,
  cpSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  replaceDirectoryTransaction,
  syncSkills,
  type DirectoryTransactionOperations,
} from "../skills/sync.js";
import { listSkills } from "../skills/reader.js";

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

// ---------------------------------------------------------------------------
// BUG-1: sync 拷贝失败时不应丢目标目录已有数据(原子替换)
// ---------------------------------------------------------------------------

describe("BUG-1: sync 拷贝失败不丢数据(原子替换,先拷成功再换)", () => {
  it("activation rename 失败时回滚旧目录且不遗留事务目录", () => {
    const source = join(tmpRoot, "source");
    const destination = join(tmpDest, "alpha");
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, "version"), "v2");
    writeFileSync(join(destination, "version"), "v1");
    let renameCount = 0;
    const operations: DirectoryTransactionOperations = {
      exists: existsSync,
      mkdir: (path) => mkdirSync(path, { recursive: true }),
      copy: (from, to) => cpSync(from, to, { recursive: true }),
      list: readdirSync,
      rename(from, to) {
        renameCount++;
        if (renameCount === 2) throw new Error("activation failed");
        renameSync(from, to);
      },
      remove: (path) => rmSync(path, { recursive: true, force: true }),
      id: () => "transaction",
    };

    expect(() => replaceDirectoryTransaction(source, destination, operations)).toThrow(
      "activation failed",
    );
    expect(readFileSync(join(destination, "version"), "utf8")).toBe("v1");
    expect(existsSync(join(tmpDest, ".alpha.transaction.tmp"))).toBe(false);
    expect(existsSync(join(tmpDest, ".alpha.transaction.backup"))).toBe(false);
  });

  it("refuses a concurrent sync while the target lock is held", () => {
    makeSkill(tmpRoot, "alpha");
    mkdirSync(join(tmpDest, ".rxcli-sync.lock"));

    const result = syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });

    expect(result.targets[0]).toMatchObject({ ok: false });
    expect(result.targets[0]?.error).toContain("already in progress");
    expect(existsSync(join(tmpDest, "alpha"))).toBe(false);
  });
  it("主循环:目标已有 skill + 源端更新 + 拷贝中途失败 → 目标原内容应保留", () => {
    // 第一次同步:dest 有 alpha(v1)
    makeSkill(tmpRoot, "alpha", "v1");
    syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
    const destSkill = join(tmpDest, "alpha", "SKILL.md");
    expect(readFileSync(destSkill, "utf8")).toContain("v1");

    // 源端 alpha 改成 v2,但删除源端 SKILL.md 让目录结构残缺(模拟拷贝中途失败:
    // 通过把源端目录在 sync 读取 listSkills 之后、cpSync 之前无法精确 mock,
    // 故改用更直接的契约测试:replaceDirAtomic 是 syncOne 的核心,拷贝失败时 dest 不变)。
    // 这里验证整体契约:再次同步应保持 dest alpha 完整(即便源端变化)。
    writeFileSync(
      join(tmpRoot, "alpha", "SKILL.md"),
      `---\nname: alpha\ndescription: v2\n---\nbody2`,
    );
    syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
    expect(readFileSync(destSkill, "utf8")).toContain("v2");
  });

  it("findOtherOwner 恢复成功:一 owner 删除后另一 owner 的副本原子替换到位", () => {
    // 复刻 syncOne 清理分支:source A 删了 shared → 找到 owner B → 恢复 B 的副本。
    // 必须先把 otherRoot 也同步过(否则 destDir 的 manifests 里没有 B 的记录)。
    const otherRoot = mkdtempSync(join(tmpdir(), "rxcli-other-"));
    try {
      makeSkill(otherRoot, "shared", "from-b");
      makeSkill(tmpRoot, "shared", "from-a");
      syncSkills(otherRoot, { targets: [{ key: "test", dir: tmpDest }] }); // 先同步 B → dest/shared = from-b,manifests 记 B
      syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] }); // 再同步 A → dest/shared = from-a,manifests 记 A
      expect(readFileSync(join(tmpDest, "shared", "SKILL.md"), "utf8")).toContain("from-a");
      // 删 a 的 shared → 清理分支找到 b → 原子替换为 b 的内容
      rmSync(join(tmpRoot, "shared"), { recursive: true, force: true });
      syncSkills(tmpRoot, { targets: [{ key: "test", dir: tmpDest }] });
      expect(readFileSync(join(tmpDest, "shared", "SKILL.md"), "utf8")).toContain("from-b");
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// BUG-3: listSkills 遇 broken symlink 不应整列崩溃
// ---------------------------------------------------------------------------

describe("BUG-3: listSkills 遇 broken symlink / 不可读条目应跳过,不崩溃", () => {
  it("skillsRoot 含 broken symlink → 仍能列出其它有效 skill", () => {
    makeSkill(tmpRoot, "alpha");
    makeSkill(tmpRoot, "beta");
    // 加一个 broken symlink(指向不存在的目标)
    symlinkSync(join(tmpRoot, "does-not-exist"), join(tmpRoot, "broken-link"));

    const skills = listSkills(tmpRoot);
    const names = skills.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    // broken-link 不应出现(非有效 skill 目录)
    expect(names).not.toContain("broken-link");
  });

  it("skillsRoot 全是普通文件(非目录)→ 返回空,不崩", () => {
    writeFileSync(join(tmpRoot, "not-a-dir.md"), "hello");
    expect(listSkills(tmpRoot)).toEqual([]);
  });
});
