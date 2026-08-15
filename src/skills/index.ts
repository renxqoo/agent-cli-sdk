/**
 * @renxqoo/agent-cli-sdk/skills —— skill 系统(reader + sync + targets + gen)
 *
 * 子路径导出(供自定义 skill 处理用):
 *   import { listSkills, readSkill, syncSkills, refreshAutogen } from '@renxqoo/agent-cli-sdk/skills'
 */

export type { SkillInfo, DirEntry, ParsedFrontmatter } from "./reader.js";
export {
  listSkills,
  listPath,
  readSkill,
  readReference,
  splitArg,
  cleanSubPath,
  parseFrontmatter,
  parseFrontmatterText,
} from "./reader.js";

export { syncSkills } from "./sync.js";
export type { SyncResult, SyncSkillsOptions, SyncTargetResult } from "./sync.js";

export type { SkillTarget } from "./targets.js";
export {
  DEFAULT_SKILL_TARGETS,
  resolveSkillTargets,
  resolveActiveTargets,
  isTargetInstalled,
  detectInstalledTargets,
  expandTargetDir,
} from "./targets.js";

export type { GenLang } from "./gen.js";
export {
  SkillRepository,
  type SkillRepositoryOptions,
  type GenerateSkillOptions,
  type SkillFileStore,
} from "./repository.js";
export {
  flattenCommands,
  signatureLine,
  argsTable,
  generateAutogenBlock,
  refreshAutogen,
  generateSkillSkeleton,
  AUTOGEN_START,
  AUTOGEN_END,
} from "./gen.js";
