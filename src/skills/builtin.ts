/**
 * @renxqoo/agent-cli-sdk/skills —— 内置 skills 命令(list/read/sync/gen)
 *
 * 设计依据:docs/06-skills.md、docs/01-cli-usage.md "skill 自服务发现"。
 * 这些命令由 defineCli 在有 skillsDir 时自动注入(作为 'skills' 子命名空间)。
 *
 * 输出约定:
 *   - list / sync:走标准成功输出 {ok, data, meta}
 *   - gen:写到文件 + 返回统一输出(生成的路径)
 *   - read:**输出契约例外**(stdout 吐 SKILL.md 原文,见 03-envelopes.md)
 */

import { type SkillTarget } from "./targets.js";
import * as z from "zod";
import type { CommandGroup, DefineCliOptions } from "../types.js";
import { ConfigError } from "../errs/index.js";
import { rawText } from "../output.js";
import { SkillRepository } from "./repository.js";

/**
 * 创建内置 skills 命令组(注入 defineCli 的 namespaces.skills)。
 *
 * @param binName bin 名(defineCli.name,用于签名/gen)
 * @param skillsDir skill 目录
 * @param cliOptions defineCli 的 options(gen 用 commands/namespaces 提取签名)
 * @param skillsTargets 同步目标(agent 工具发现目录)。省略 → targets.ts 默认 7 个
 */
export function createBuiltinSkillsCommands(
  binName: string,
  skillsDir: string,
  cliOptions: Pick<DefineCliOptions<any>, "commands" | "namespaces" | "name" | "binName">,
  skillsTargets?: SkillTarget[],
): CommandGroup {
  const repository = new SkillRepository({
    root: skillsDir,
    binName,
    cli: cliOptions,
    ...(skillsTargets ? { targets: skillsTargets } : {}),
  });
  return {
    // list:列出所有 skill(统一输出格式),或列举一层(带 name/path 参数)
    list: {
      name: "list",
      description: "List all skills, or list one level under a skill",
      skipPluginHooks: true,
      args: {
        schema: z.object({
          name: z.string().describe("skill name or name/subpath").optional(),
        }),
        pos: ["name"],
      },
      async run(_ctx, args) {
        if (!args.name) {
          const all = repository.list();
          return { data: all, meta: { count: all.length } };
        }
        const { entries, listed } = repository.listAt(args.name);
        return { data: entries, meta: { count: entries.length, path: listed } };
      },
    },

    // read:读 SKILL.md 或 reference。**输出契约例外**:stdout 吐原文
    read: {
      name: "read",
      description:
        "Read a skill's SKILL.md or reference (raw content to stdout, output contract exception)",
      skipPluginHooks: true,
      args: {
        schema: z.object({
          name: z.string().describe("skill name or name/subpath"),
        }),
        pos: ["name"],
      },
      async run(_ctx, args) {
        return rawText(repository.read(args.name));
      },
    },

    // sync:同步到已装的 AI agent 工具发现目录(探测模式)
    //   - 默认(未配 skillsTargets):~/.agents 始终写 + 探测到的已装工具
    //   - 配了 skillsTargets:完全按业务包列表(强制全写,不探测)
    sync: {
      name: "sync",
      description:
        "Sync skills to installed AI agent discovery dirs (~/.agents always + detected: .claude/.codex/.cursor/.zcode/.openclaw/.pi)",
      skipPluginHooks: true,
      async run() {
        // skillsTargets 未配 → 省略 opts,走探测模式;配了 → 显式传,强制全写。
        const { count, targets } = repository.sync();
        const written = targets.filter((t) => t.ok);
        const skipped = targets.filter((t) => t.skipped);
        const failed = targets.filter((t) => !t.ok && !t.skipped);
        if (failed.length > 0) {
          throw new ConfigError({
            subtype: "skill_sync_failed",
            message: `failed to sync skills to ${failed.length} target(s)`,
            hint: failed
              .map((target) => `${target.key} (${target.dir}): ${target.error ?? "unknown error"}`)
              .join("; "),
          });
        }
        return {
          data: {
            synced: count,
            targets: targets.map((t) => ({
              key: t.key,
              dir: t.dir,
              ok: t.ok,
              ...(t.skipped ? { skipped: true } : {}),
              ...(t.error ? { error: t.error } : {}),
            })),
          },
          meta: {
            synced: count,
            written: written.length,
            skipped: skipped.length,
            failed: failed.length,
          },
        };
      },
      humanFormat(data) {
        const d = data as {
          synced: number;
          targets: { key: string; dir: string; ok: boolean; skipped?: boolean; error?: string }[];
        };
        const written = d.targets.filter((t) => t.ok);
        const lines = [`Synced ${d.synced} skill(s) to ${written.length} target(s):`];
        for (const t of d.targets) {
          if (t.ok) {
            lines.push(`  ✓ ${t.key.padEnd(10)} ${t.dir}`);
          } else if (t.skipped) {
            lines.push(`  · ${t.key.padEnd(10)} (not installed, skipped)`);
          } else {
            lines.push(`  ✗ ${t.key.padEnd(10)} ${t.dir}  (${t.error ?? "failed"})`);
          }
        }
        return lines.join("\n");
      },
    },

    // gen:自动生成命令文档(刷新 AUTO-GEN 块 / --init 吐骨架)
    gen: {
      name: "gen",
      description:
        "Generate SKILL.md command docs from defineCommands (refreshes the AUTO-GEN block)",
      skipPluginHooks: true,
      args: {
        schema: z.object({
          // M13: constrain the skill identifier at the schema so an invalid name yields
          // a validation error (invalid_argument) instead of a misleading NotFoundError.
          name: z
            .string()
            .regex(
              /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
              "must be a lowercase identifier (letters, digits, single hyphens)",
            )
            .describe("skill name (= directory name)"),
          init: z.boolean().default(false),
          force: z.boolean().default(false),
          lang: z.enum(["en", "zh"]).default("en"),
        }),
        pos: ["name"],
      },
      async run(_ctx, args) {
        const result = repository.generate({
          name: args.name,
          initialize: Boolean(args.init),
          force: Boolean(args.force),
          language: args.lang === "zh" ? "zh" : "en",
        });
        return {
          data:
            result.mode === "init"
              ? { generated: result.path, mode: result.mode }
              : { refreshed: result.path, mode: result.mode },
        };
      },
    },
  };
}
