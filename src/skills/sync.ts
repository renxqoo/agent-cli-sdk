/**
 * @renxqoo/agent-cli-sdk/skills —— skill 同步(到多个 AI agent 工具发现目录)
 *
 * 设计依据:docs/06-skills.md "skill 同步机制"。
 * 实现 skills 同步:把业务包的 skills 目录同步到多个 AI agent 工具的标准发现路径。
 *
 * 组件分工:
 *   - targets.ts:定义"同步到哪"(默认 7 个工具目录 + 可覆盖)
 *   - sync.ts:定义"怎么同步"(本文件)—— 全量同步到单个目录的 syncOne + 遍历多 target 的 syncSkills
 *
 * 全量策略:临时目录复制 + 目录交换 + 失败回滚，不让目标暴露半成品。
 * 多 target 容错:逐个 target 独立同步,单个失败(权限/磁盘)不中断其余,最后汇总。
 */

import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { listSkills } from "./reader.js";
import { ConflictError } from "../errs/index.js";
import { withFileLockSync } from "../infra/file-lock.js";
import {
  resolveSkillTargets,
  resolveActiveTargets,
  expandTargetDir,
  type SkillTarget,
} from "./targets.js";

/** 单个 target 的同步结果(汇总用)。 */
export interface SyncTargetResult {
  key: string;
  dir: string;
  /** 写入成功 true;跳过(未装)或失败 false。结合 skipped/error 区分。 */
  ok: boolean;
  /** 探测模式下该工具未安装,已跳过(未创建目录)。 */
  skipped?: boolean;
  /** 失败时的错误信息(成功省略)。 */
  error?: string;
}

export interface SyncResult {
  /** 同步的 skill 种数(各 target 一致)。 */
  count: number;
  /** 每个 target 的同步结果(成功/失败 + 错误)。 */
  targets: SyncTargetResult[];
}

export interface SyncSkillsOptions {
  targets?: SkillTarget[];
  /** 对 targets 也走探测(只写父目录已存在的);默认 false(targets 强制全写)。 */
  detect?: boolean;
  /**
   * 跨进程锁的陈旧回收阈值(ms):一个被信号中断的 sync 留下的锁,超过该时长且属主进程
   * 已死时,下次 sync 直接回收。默认 5 分钟。调大可容忍更长的 sync,调小可更快恢复。
   */
  lockStaleAfterMs?: number;
}

/**
 * 原子地把 src 目录替换到 dest:先拷到 dest 同级的临时目录,成功后 rename 覆盖 dest,
 * 任何拷贝中途失败都保留 dest 原样(修复 BUG-1:删除即拷贝导致拷贝失败丢数据)。
 *
 * src 不存在时视为"应清理 dest":删除 dest 后返回(findOtherOwner 恢复失败时,dest 不应残留半截)。
 */
export interface DirectoryTransactionOperations {
  exists(path: string): boolean;
  mkdir(path: string): void;
  copy(source: string, destination: string): void;
  list(path: string): string[];
  rename(source: string, destination: string): void;
  remove(path: string): void;
  id(): string;
}

const NODE_DIRECTORY_OPERATIONS: DirectoryTransactionOperations = {
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  // B2: materialize symlinks into real files. Agent tools that scan the discovery dir
  // bypass the reader's path guard, so symlinks must not be propagated verbatim. Node's
  // cpSync `dereference` does NOT materialize nested symlinks, so we recurse manually.
  copy: copyTreeDereferenced,
  list: readdirSync,
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  id: randomUUID,
};

/**
 * Recursive copy that dereferences every symlink into a real file/dir. Broken
 * symlinks are skipped; symlink cycles (a link resolving to an ancestor) are
 * broken via a realpath-seen guard so the copy cannot recurse forever.
 */
function copyTreeDereferenced(source: string, destination: string): void {
  const seen = new Set<string>();
  const copy = (src: string, dest: string): void => {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isSymbolicLink()) {
        let real;
        try {
          real = statSync(srcPath); // follows the link
        } catch {
          continue; // broken symlink — skip
        }
        if (real.isDirectory()) {
          let resolved: string | undefined;
          try {
            resolved = realpathSync(srcPath);
          } catch {
            resolved = undefined;
          }
          // B2: break symlink cycles — skip a link whose target we already copied.
          if (!resolved || seen.has(resolved)) continue;
          seen.add(resolved);
          copy(srcPath, destPath);
        } else {
          copyFileSync(srcPath, destPath); // follows the link, copies target content
        }
      } else if (entry.isDirectory()) {
        copy(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  };
  copy(source, destination);
}

/** Crash-recoverable directory swap. A failed activation restores the previous destination. */
export function replaceDirectoryTransaction(
  src: string,
  dest: string,
  operations: DirectoryTransactionOperations = NODE_DIRECTORY_OPERATIONS,
): void {
  if (!operations.exists(src)) {
    removeDirectoryTransaction(dest, operations);
    return;
  }

  const parent = dirname(dest);
  operations.mkdir(parent);
  recoverInterruptedSwap(dest, operations);
  const transaction = operations.id();
  const temp = join(parent, `.${basename(dest)}.${transaction}.tmp`);
  const backup = join(parent, `.${basename(dest)}.${transaction}.backup`);
  let movedPrevious = false;
  try {
    operations.copy(src, temp);
    if (operations.exists(dest)) {
      operations.rename(dest, backup);
      movedPrevious = true;
    }
    try {
      operations.rename(temp, dest);
    } catch (error) {
      if (movedPrevious && operations.exists(backup) && !operations.exists(dest)) {
        operations.rename(backup, dest);
      }
      throw error;
    }
    if (movedPrevious) operations.remove(backup);
  } finally {
    operations.remove(temp);
  }
}

function removeDirectoryTransaction(
  dest: string,
  operations: DirectoryTransactionOperations = NODE_DIRECTORY_OPERATIONS,
): void {
  recoverInterruptedSwap(dest, operations);
  if (!operations.exists(dest)) return;
  const backup = join(dirname(dest), `.${basename(dest)}.${operations.id()}.backup`);
  operations.rename(dest, backup);
  operations.remove(backup);
}

function recoverInterruptedSwap(
  dest: string,
  operations: DirectoryTransactionOperations = NODE_DIRECTORY_OPERATIONS,
): void {
  const parent = dirname(dest);
  if (!operations.exists(parent)) return;
  const prefix = `.${basename(dest)}.`;
  // L11: clean stale .tmp (copy artifacts from a crashed swap) alongside .backup recovery.
  for (const name of operations.list(parent)) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) {
      operations.remove(join(parent, name));
    }
  }
  const backups = operations
    .list(parent)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".backup"))
    .sort();
  for (const name of backups) {
    const backup = join(parent, name);
    if (!operations.exists(dest)) operations.rename(backup, dest);
    else operations.remove(backup);
  }
}

/**
 * 把 skillsRoot 下所有 skill 全量同步到单个 destDir。
 * 含 manifest 清理:destDir 中存在、但源端已删除的 skill 会被清掉(多业务包隔离)。
 *
 * 这是原 syncSkills 的核心逻辑,抽出来供多 target 循环复用。
 */
function syncOne(skillsRoot: string, destDir: string, lockStaleAfterMs?: number): void {
  mkdirSync(destDir, { recursive: true });
  withSyncLock(destDir, () => syncOneLocked(skillsRoot, destDir), lockStaleAfterMs);
}

function syncOneLocked(skillsRoot: string, destDir: string): void {
  const skills = listSkills(skillsRoot);
  const sourceNames = new Set(skills.map((s) => s.name));

  // 共享目标目录按 source 分别记账。只删除"这个 source 上次同步、这次已删除"的条目,
  // 绝不扫描并删除其他业务包/用户安装的 skill。
  const manifestsDir = join(destDir, ".rxcli-sync-manifests");
  mkdirSync(manifestsDir, { recursive: true });
  const sourceId = createHash("sha256").update(resolve(skillsRoot)).digest("hex");
  const manifestPath = join(manifestsDir, `${sourceId}.json`);
  recoverFileTransaction(manifestPath);
  let previousNames: string[] = [];
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { skills?: unknown };
      if (Array.isArray(parsed.skills)) {
        previousNames = parsed.skills.filter((name): name is string => typeof name === "string");
      }
    } catch {
      previousNames = [];
    }
  }

  const findOtherOwner = (name: string): string | undefined => {
    for (const file of readdirSync(manifestsDir)) {
      if (join(manifestsDir, file) === manifestPath || !file.endsWith(".json")) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(manifestsDir, file), "utf8")) as {
          source?: unknown;
          skills?: unknown;
        };
        if (
          typeof manifest.source === "string" &&
          Array.isArray(manifest.skills) &&
          manifest.skills.includes(name) &&
          existsSync(join(manifest.source, name, "SKILL.md"))
        ) {
          return manifest.source;
        }
      } catch {
        // 损坏/并发中的其他 manifest 不影响当前 source 同步。
      }
    }
    return undefined;
  };

  for (const previous of previousNames) {
    if (!sourceNames.has(previous)) {
      const target = join(destDir, previous);
      const otherSource = findOtherOwner(previous);
      if (otherSource) {
        // 原子替换:另一 owner 源拷贝失败时,保留 dest 原内容(BUG-1)。
        replaceDirectoryTransaction(join(otherSource, previous), target);
      } else {
        // 无其它 owner:明确清理 dest(源端已删,该 skill 应被移除)。
        removeDirectoryTransaction(target);
      }
    }
  }

  for (const s of skills) {
    const target = join(destDir, s.name);
    // 原子替换:拷贝失败时 dest 保留旧版本(BUG-1)。
    replaceDirectoryTransaction(join(skillsRoot, s.name), target);
  }
  writeFileTransaction(
    manifestPath,
    JSON.stringify({ source: resolve(skillsRoot), skills: [...sourceNames].sort() }, null, 2) +
      "\n",
  );
}

function withSyncLock<T>(destDir: string, operation: () => T, lockStaleAfterMs?: number): T {
  // B1: cross-process O_EXCL lockfile with stale-PID + TTL recovery. A sync killed by
  // a signal (Ctrl+C / SIGTERM) leaves the lock behind; the next run reclaims it once
  // the recorded PID is dead or the TTL elapses.
  try {
    return withFileLockSync(destDir, "sync", operation, {
      staleAfterMs: lockStaleAfterMs ?? 5 * 60_000,
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new ConflictError(`skill sync already in progress for ${destDir}`);
    }
    throw error;
  }
}

function writeFileTransaction(path: string, content: string): void {
  const transaction = randomUUID();
  const temp = `${path}.${transaction}.tmp`;
  const backup = `${path}.${transaction}.backup`;
  let movedPrevious = false;
  try {
    writeFileSync(temp, content);
    if (existsSync(path)) {
      renameSync(path, backup);
      movedPrevious = true;
    }
    try {
      renameSync(temp, path);
    } catch (error) {
      if (movedPrevious && existsSync(backup) && !existsSync(path)) renameSync(backup, path);
      throw error;
    }
    if (movedPrevious) rmSync(backup, { force: true });
  } finally {
    rmSync(temp, { force: true });
  }
}

function recoverFileTransaction(path: string): void {
  const parent = dirname(path);
  const prefix = `${basename(path)}.`;
  // L11: clean stale .tmp write artifacts from a crashed manifest write.
  for (const name of readdirSync(parent)) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) {
      rmSync(join(parent, name), { force: true });
    }
  }
  const backups = readdirSync(parent)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".backup"))
    .sort();
  for (const name of backups) {
    const backup = join(parent, name);
    if (!existsSync(path)) renameSync(backup, path);
    else rmSync(backup, { force: true });
  }
}

/**
 * 把 skillsRoot 下所有 skill 同步到一个或多个 AI agent 工具发现目录。
 *
 * @param skillsRoot 业务包的 skills 目录
 * @param options
 *   - **省略** → 探测模式:~/.agents 始终写 + 探测到的已装工具(父目录存在)。
 *     避免给只装 1-2 个工具的用户创建一堆空目录。
 *   - **{ targets }** → 同步到指定 target 列表(**强制全写,不探测**;业务包显式指定 = 强制)
 *   - **{ targets, detect: true }** → 对指定列表也走探测(只写已装的)
 *
 * 多 target 容错:逐个 target 独立 try/catch,单个失败不中断其余,最后汇总返回。
 * 探测模式:未安装的工具记 `skipped: true`(不创建目录、不算失败)。
 */
export function syncSkills(skillsRoot: string, options?: SyncSkillsOptions): SyncResult {
  // 解析 candidates(候选 target 列表)+ 是否探测。
  let candidates: SkillTarget[];
  let detect = false;
  if (options === undefined) {
    // 默认:探测模式(~/.agents 始终写 + 已装的)
    candidates = resolveSkillTargets();
    detect = true;
  } else {
    candidates = resolveSkillTargets(options.targets);
    detect = options.detect ?? false;
  }

  // 探测模式:resolveActiveTargets 保证 ~/.agents 始终在 + 其余只留已装的。
  const activeTargets = detect ? resolveActiveTargets(candidates) : candidates;
  // skipped 集合:探测时被过滤掉的 target(汇总输出用,告诉用户哪些工具没装所以没写)。
  const skippedKeys = new Set(
    candidates.filter((c) => !activeTargets.some((a) => a.key === c.key)).map((c) => c.key),
  );

  const count = listSkills(skillsRoot).length;
  const results: SyncTargetResult[] = [];

  for (const t of activeTargets) {
    const expanded = expandTargetDir(t.dir);
    try {
      syncOne(skillsRoot, expanded, options?.lockStaleAfterMs);
      results.push({ key: t.key, dir: expanded, ok: true });
    } catch (err) {
      // 单个 target 失败(权限/磁盘/路径非法)不中断其余 target。
      results.push({
        key: t.key,
        dir: expanded,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // 探测跳过的 target 记入结果(skipped:true,不算失败,汇总提示用)
  for (const c of candidates) {
    if (skippedKeys.has(c.key)) {
      results.push({ key: c.key, dir: expandTargetDir(c.dir), ok: false, skipped: true });
    }
  }

  return { count, targets: results };
}
