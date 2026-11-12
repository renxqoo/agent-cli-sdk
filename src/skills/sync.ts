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
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { listSkillsForPublication } from "./reader.js";
import { readSkillTree, writeSkillTree, type SkillTree } from "./files.js";
import { assertExistingPathInside, validateSkillName } from "./path-guard.js";
import { isAbsolute } from "node:path";
import { ConfigError } from "../errs/index.js";
import { withFileLockSync } from "../infra/file-lock.js";
import { writeAtomicFile } from "../infra/atomic-file.js";
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

function copyTreeDereferenced(source: string, destination: string): void {
  writeSkillTree(readSkillTree(source), destination);
}

/** Crash-recoverable directory swap. A failed activation restores the previous destination. */
export function replaceDirectoryTransaction(
  src: string | SkillTree,
  dest: string,
  operations: DirectoryTransactionOperations = NODE_DIRECTORY_OPERATIONS,
): void {
  if (typeof src === "string" && !operations.exists(src)) {
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
    if (typeof src === "string") operations.copy(src, temp);
    else writeSkillTree(src, temp);
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
function syncOne(
  skillsRoot: string,
  destDir: string,
  snapshots: ReadonlyMap<string, SkillTree>,
): void {
  mkdirSync(destDir, { recursive: true });
  withSyncLock(destDir, () => syncOneLocked(skillsRoot, destDir, snapshots));
}

function syncOneLocked(
  skillsRoot: string,
  destDir: string,
  snapshots: ReadonlyMap<string, SkillTree>,
): void {
  const sourceNames = new Set(snapshots.keys());
  const sourceId = createHash("sha256").update(resolve(skillsRoot)).digest("hex");
  const operations = indexedDirectoryOperations(copyTreeDereferenced);

  // 共享目标目录按 source 分别记账。只删除"这个 source 上次同步、这次已删除"的条目,
  // 绝不扫描并删除其他业务包/用户安装的 skill。
  const manifestsDir = join(destDir, ".rxcli-sync-manifests");
  mkdirSync(manifestsDir, { recursive: true });
  assertExistingPathInside(destDir, manifestsDir, "Skill manifests");
  recoverPublication(destDir, manifestsDir);
  const manifestPath = join(manifestsDir, `${sourceId}.json`);
  recoverFileTransaction(manifestPath);
  const previousManifest = existsSync(manifestPath) ? readManifest(manifestPath) : undefined;
  const previousNames = previousManifest?.skills ?? [];
  const otherOwners = new Map<string, string>();
  for (const file of readdirSync(manifestsDir)) {
    if (join(manifestsDir, file) === manifestPath || !/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const manifest = readManifest(join(manifestsDir, file));
    for (const name of manifest.skills) {
      const source = join(manifest.source, name);
      if (existsSync(join(source, "SKILL.md"))) {
        assertExistingPathInside(manifest.source, source, "Skill owner source");
        otherOwners.set(name, manifest.source);
      }
    }
  }

  const changes = new Map<string, SkillTree | null>();
  for (const previous of previousNames) {
    if (!sourceNames.has(previous)) {
      recoverInterruptedSwap(join(destDir, previous), operations);
      const otherSource = otherOwners.get(previous);
      if (otherSource) {
        changes.set(previous, readSkillTree(join(otherSource, previous)));
      } else {
        changes.set(previous, null);
      }
    }
  }

  for (const [name, tree] of snapshots) {
    const target = join(destDir, name);
    recoverInterruptedSwap(target, operations);
    let unchanged = false;
    if (previousManifest?.digests?.[name] === tree.digest && existsSync(target)) {
      try {
        unchanged = readSkillTree(target, destDir).digest === tree.digest;
      } catch {
        unchanged = false;
      }
    }
    if (!unchanged) changes.set(name, tree);
  }
  publishTransaction(destDir, manifestsDir, manifestPath, changes, {
    source: resolve(skillsRoot),
    skills: [...sourceNames].toSorted(),
    digests: Object.fromEntries([...snapshots].map(([name, tree]) => [name, tree.digest])),
  });
}

interface PublicationIntent {
  id: string;
  manifest: string;
  changes: { name: string; hadPrevious: boolean; publish: boolean }[];
}

/** Keep target-local undo data until content AND ownership have committed. */
function publishTransaction(
  destDir: string,
  manifestsDir: string,
  manifestPath: string,
  changes: ReadonlyMap<string, SkillTree | null>,
  manifest: SyncManifest,
): void {
  const directory = join(manifestsDir, ".publication");
  mkdirSync(join(directory, "staged"), { recursive: true });
  mkdirSync(join(directory, "previous"));
  const intent: PublicationIntent = {
    id: randomUUID(),
    manifest: basename(manifestPath),
    changes: [...changes].map(([name, tree]) => ({
      name,
      hadPrevious: existsSync(join(destDir, name)),
      publish: tree !== null,
    })),
  };
  try {
    for (const [name, tree] of changes) {
      if (tree) writeSkillTree(tree, join(directory, "staged", name));
    }
    // No target mutations are allowed before the complete recovery intent is visible.
    writeAtomicFile(join(directory, "intent.json"), JSON.stringify(intent));
    for (const change of intent.changes) {
      const target = join(destDir, change.name);
      if (change.hadPrevious) renameSync(target, join(directory, "previous", change.name));
      if (change.publish) renameSync(join(directory, "staged", change.name), target);
    }
    // This identity is the commit point, including when cleanup is interrupted.
    writeFileTransaction(
      manifestPath,
      JSON.stringify({ ...manifest, publicationId: intent.id }, null, 2) + "\n",
    );
  } catch (error) {
    // If rollback itself fails, leave the journal and backups for the next lock holder.
    recoverPublication(destDir, manifestsDir);
    throw error;
  }
  recoverPublication(destDir, manifestsDir);
}

/** Called under the target lock before ANY source can publish to this target. */
function recoverPublication(destDir: string, manifestsDir: string): void {
  const directory = join(manifestsDir, ".publication");
  if (!existsSync(directory)) return;
  assertExistingPathInside(manifestsDir, directory, "Skill publication");
  const intentPath = join(directory, "intent.json");
  if (!existsSync(intentPath)) {
    // Preparation never mutated the target without an intent.
    rmSync(directory, { recursive: true, force: true });
    return;
  }
  assertExistingPathInside(directory, intentPath, "Skill publication intent");
  const intent = JSON.parse(readFileSync(intentPath, "utf8")) as PublicationIntent;
  if (
    !intent ||
    typeof intent.id !== "string" ||
    !/^[a-f0-9]{64}\.json$/.test(intent.manifest) ||
    !Array.isArray(intent.changes)
  ) {
    throw new ConfigError({
      subtype: "invalid_config",
      message: "Invalid skill publication intent",
    });
  }
  // Validate the entire intent before performing any recovery mutations.
  for (const change of intent.changes) {
    if (
      !change ||
      typeof change.name !== "string" ||
      typeof change.hadPrevious !== "boolean" ||
      typeof change.publish !== "boolean"
    ) {
      throw new ConfigError({
        subtype: "invalid_config",
        message: "Invalid skill publication change",
      });
    }
    validateSkillName(change.name);
  }
  for (const child of ["staged", "previous"]) {
    assertExistingPathInside(directory, join(directory, child), "Skill publication data");
  }
  const manifestPath = join(manifestsDir, intent.manifest);
  recoverFileTransaction(manifestPath);
  const committed =
    existsSync(manifestPath) && readManifest(manifestPath).publicationId === intent.id;
  if (!committed) {
    for (const change of intent.changes) {
      const target = join(destDir, change.name);
      const previous = join(directory, "previous", change.name);
      if (existsSync(previous)) {
        rmSync(target, { recursive: true, force: true });
        renameSync(previous, target);
      } else if (
        !change.hadPrevious &&
        change.publish &&
        !existsSync(join(directory, "staged", change.name))
      ) {
        // The staged directory disappeared only when its activation rename succeeded.
        rmSync(target, { recursive: true, force: true });
      }
    }
  }
  rmSync(directory, { recursive: true, force: true });
}

function withSyncLock<T>(destDir: string, operation: () => T): T {
  return withFileLockSync(destDir, "sync", operation);
}

interface SyncManifest {
  source: string;
  skills: string[];
  digests?: Record<string, string>;
  publicationId?: string;
}

function readManifest(path: string): SyncManifest {
  assertExistingPathInside(dirname(path), path, "Skill manifest");
  const value = JSON.parse(readFileSync(path, "utf8")) as SyncManifest;
  if (
    !value ||
    typeof value.source !== "string" ||
    !isAbsolute(value.source) ||
    !Array.isArray(value.skills)
  ) {
    throw new ConfigError({ subtype: "invalid_config", message: "Invalid skill sync manifest" });
  }
  const expectedName = createHash("sha256").update(resolve(value.source)).digest("hex") + ".json";
  if (basename(path) !== expectedName)
    throw new ConfigError({
      subtype: "invalid_config",
      message: "Skill manifest source does not match its identity",
    });
  for (const name of value.skills) {
    if (typeof name !== "string")
      throw new ConfigError({ subtype: "invalid_config", message: "Invalid skill manifest name" });
    validateSkillName(name);
  }
  return value;
}

/** Recovery queries reuse a single directory inventory while swaps update the index. */
function indexedDirectoryOperations(
  copy: DirectoryTransactionOperations["copy"],
): DirectoryTransactionOperations {
  const listings = new Map<string, Set<string>>();
  const list = (path: string): Set<string> => {
    let entries = listings.get(path);
    if (!entries) {
      entries = new Set(readdirSync(path));
      listings.set(path, entries);
    }
    return entries;
  };
  return {
    ...NODE_DIRECTORY_OPERATIONS,
    copy,
    list: (path) => [...list(path)],
    rename(source, destination) {
      renameSync(source, destination);
      listings.get(dirname(source))?.delete(basename(source));
      listings.get(dirname(destination))?.add(basename(destination));
    },
    remove(path) {
      rmSync(path, { recursive: true, force: true });
      listings.get(dirname(path))?.delete(basename(path));
    },
  };
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

  let count = 0;
  const snapshots = new Map<string, SkillTree>();
  let sourceError: unknown;
  try {
    const skills = listSkillsForPublication(skillsRoot);
    count = skills.length;
    for (const skill of skills) {
      const source = join(skillsRoot, skill.name);
      assertExistingPathInside(skillsRoot, source, "Skill source");
      snapshots.set(skill.name, readSkillTree(source));
    }
  } catch (error) {
    sourceError = error;
  }
  const results: SyncTargetResult[] = [];

  for (const t of activeTargets) {
    const expanded = expandTargetDir(t.dir);
    try {
      if (sourceError) throw sourceError;
      syncOne(skillsRoot, expanded, snapshots);
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
