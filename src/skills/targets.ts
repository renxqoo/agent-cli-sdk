/**
 * @renxqoo/agent-cli-sdk/skills —— 同步目标(targets)组件
 *
 * 设计依据:docs/06-skills.md "skill 同步机制"。
 *
 * skill 需要让多个 AI agent 工具都能发现。不同工具扫描各自的家目录:
 *   - Agent Skills 标准:~/.agents/skills
 *   - Claude Code:~/.claude/skills
 *   - OpenAI Codex:~/.codex/skills
 *   - Cursor:~/.cursor/skills
 *   - ZCode:~/.zcode/skills
 *   - OpenClaw:~/.openclaw/skills
 *   - Pi Coding Agent:~/.pi/agent/skills
 *
 * 本组件是 sync.ts / builtin.ts / define.ts 共用的"目标解析层":
 *   - DEFAULT_SKILL_TARGETS:框架内置默认列表(7 个)
 *   - resolveSkillTargets(override):业务包可通过 defineCli({ skillsTargets }) 覆盖
 *   - resolveActiveTargets:默认 sync 用的"探测模式"——~/.agents 始终写 +
 *     其余只写父目录已存在(已装)的工具,避免给只装 1-2 个工具的用户创建空目录
 *   - expandTargetDir:把 ~ 展开为 homedir(让 target 的 dir 可读又可执行)
 *
 * 独立成组件(sync.ts 只管"怎么同步",targets.ts 只管"同步到哪"),
 * 方便后续增减工具时只改这一处默认列表。
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

/** 单个同步目标:key 是工具名(日志/汇总用),dir 是 skill 发现目录(可含 ~)。 */
export interface SkillTarget {
  /** 工具标识,如 'claude'、'codex'。用于 sync 汇总输出。 */
  key: string;
  /** skill 发现目录,允许 ~ 开头(同步前由 expandTargetDir 展开)。 */
  dir: string;
}

/**
 * 框架内置的默认同步目标(7 个主流 AI agent 工具的标准发现路径)。
 * 业务包不传 skillsTargets 时用这份;传了 skillsTargets 则完全覆盖这份。
 */
export const DEFAULT_SKILL_TARGETS: readonly SkillTarget[] = [
  { key: "agents", dir: "~/.agents/skills" },
  { key: "claude", dir: "~/.claude/skills" },
  { key: "codex", dir: "~/.codex/skills" },
  { key: "cursor", dir: "~/.cursor/skills" },
  { key: "zcode", dir: "~/.zcode/skills" },
  { key: "openclaw", dir: "~/.openclaw/skills" },
  { key: "pi", dir: "~/.pi/agent/skills" },
] as const;

/**
 * 解析最终要同步的 target 列表。
 *
 * @param override 业务包通过 defineCli({ skillsTargets }) 传入的自定义列表。
 *   - undefined / 省略 → 用 DEFAULT_SKILL_TARGETS
 *   - 非空数组 → 完全用 override(覆盖默认)
 *   - 空数组 [] → 返回空(sync 不做任何同步,用于业务包想彻底关闭多 target 的场景)
 */
export function resolveSkillTargets(override?: SkillTarget[]): SkillTarget[] {
  if (override === undefined) return [...DEFAULT_SKILL_TARGETS];
  return [...override];
}

/**
 * 判断单个 target 是否"已安装"——其父目录(工具家目录)已存在。
 *
 * 判定依据:target 的 dir 是 `~/.<tool>/skills`,父目录 `~/.<tool>` 存在 = 用户装了该工具。
 * 例如 `~/.claude/skills` → 检查 `~/.claude` 是否存在。
 * 特例:`agents` target(~/.agents/skills)是 Agent Skills 标准路径,不算具体工具,
 *   由调用方(resolveActiveTargets)始终纳入,本函数不特殊处理。
 *
 * @param target 待检测的 target(dir 可含 ~,会先展开)
 * @returns 父目录存在 → true
 */
export function isTargetInstalled(target: SkillTarget): boolean {
  const expanded = expandTargetDir(target.dir);
  return existsSync(dirname(expanded));
}

/**
 * 探测哪些 target 已安装(父目录存在)。返回新数组,不改入参。
 */
export function detectInstalledTargets(targets: SkillTarget[]): SkillTarget[] {
  return targets.filter((t) => isTargetInstalled(t));
}

/**
 * 解析"实际要写入"的 target 列表(默认探测模式用)。
 *
 * 规则:
 *   1. 取 candidates(默认 = DEFAULT_SKILL_TARGETS)
 *   2. 始终纳入 `agents`(~/.agents/skills,标准兜底,无论是否"已安装"都写)
 *   3. 其余 target 只保留父目录已存在的(用户装了的工具)
 *
 * 这样只装了 Claude Code 的用户只会写 ~/.agents/skills + ~/.claude/skills,
 * 不会污染 ~/.codex、~/.cursor 等没装的工具目录。
 * 去重:同一 key 只保留一份(candidates 里已有 agents 时不会重复)。
 */
export function resolveActiveTargets(
  candidates: readonly SkillTarget[] = DEFAULT_SKILL_TARGETS,
): SkillTarget[] {
  const result: SkillTarget[] = [];
  const seen = new Set<string>();
  // M12: agents 始终纳入仅当调用方用的是默认列表;调用方完全自定义列表时按字面尊重,
  // 不再强行注入默认 agents 目标(否则违反"完全覆盖"契约)。
  const usingDefaults = candidates === DEFAULT_SKILL_TARGETS;
  const agentsTarget =
    candidates.find((t) => t.key === "agents") ??
    (usingDefaults ? DEFAULT_SKILL_TARGETS[0] : undefined);
  if (agentsTarget && !seen.has(agentsTarget.key)) {
    result.push(agentsTarget);
    seen.add(agentsTarget.key);
  }
  // 其余 target:父目录已存在才纳入
  for (const t of candidates) {
    if (seen.has(t.key)) continue;
    if (isTargetInstalled(t)) {
      result.push(t);
      seen.add(t.key);
    }
  }
  return result;
}

/**
 * 把 target 的 dir 中的 ~ 展开为真实家目录。
 * 不含 ~ 的路径原样返回(已是绝对路径的场景)。
 *
 * 跨平台:同时识别 `~/`(POSIX)和 `~\`(Windows)前缀。默认 target 列表统一用 `~/`,
 * 但用户自定义 skillsTargets 时可能在 Windows 上写 `~\`,这里一并兼容。
 * path.join 会把混合分隔符(`/` + `\`)归一化为当前平台的标准分隔符。
 *
 * @example expandTargetDir("~/.claude/skills") → "/Users/wrr/.claude/skills"
 * @example (Windows) expandTargetDir("~\\.claude\\skills") → "C:\\Users\\wrr\\.claude\\skills"
 */
export function expandTargetDir(dir: string): string {
  if (dir === "~") return homedir();
  // ~/ (POSIX) 或 ~\ (Windows)
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return join(homedir(), dir.slice(2));
  return dir;
}
