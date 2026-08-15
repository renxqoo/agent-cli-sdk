/**
 * @renxqoo/agent-cli-sdk —— defineInstaller:安装向导插件
 *
 * 把安装向导收编为一个内部插件:提供顶层 `install` 命令(`skipPluginHooks`,
 * 因此在登录前也能跑),命令体复用 install-workflow(纯策略)+ install-wizard(Node 适配)。
 *
 * 目录决策不在插件里:apply(services) 从 services.localState 取本地状态,
 * defineCliApp 统一注入。业务入口不再需要 install 拦截分支。
 */

import * as z from "zod";
import { defineCommand } from "./define.js";
import { BareError, InternalError } from "./errs/index.js";
import { InstallWorkflow } from "./install-workflow.js";
import { ClackInstallPresenter, NodeInstallSystem } from "./install-wizard.js";
import type { FileLocalState } from "./local-state.js";
import { rawText } from "./output.js";
import { detectBizPackage } from "./package-detect.js";
import type { CommandContext, CommandResult, Plugin } from "./types.js";

export interface DefineInstallerOptions {
  /** Remote skills source URL; when set the wizard prefers `npx skills add`. */
  skillsSource?: string;
  /** npm package name of this CLI. Defaults to detection from the consuming package.json. */
  pkgName?: string;
  /** Global binary name used for register/login and skills sync. Defaults to detection. */
  binName?: string;
  /**
   * Whether the CLI has an auth flow (register + login steps). Default true.
   * Set false for open-data CLIs without auth — the wizard stops after skills.
   */
  auth?: boolean;
}

/**
 * Create the installer plugin. Provides the top-level `install` command
 * (`rxcli install [--lang zh|en]`); the command runs the wizard on stderr and
 * returns an empty stdout payload — failures exit via BareError without extra envelopes.
 */
export function defineInstaller<State = Record<string, never>>(
  options: DefineInstallerOptions = {},
): Plugin<State> {
  let localState: FileLocalState | null = null;
  const requireLocalState = (): FileLocalState => {
    if (!localState) {
      throw new InternalError({
        subtype: "contract_violation",
        message: "installer plugin used before apply(services) completed",
      });
    }
    return localState;
  };

  return {
    name: "installer",
    enforce: "normal",

    async apply(services) {
      if (services.localState.kind !== "file") {
        throw new TypeError("defineInstaller requires file-backed local state");
      }
      localState = services.localState;
    },

    provides: {
      commands: {
        install: defineCommand({
          name: "install",
          description:
            "Install this CLI and its skills (global install, optional register/login, skills sync)",
          // 装配命令:必须在登录前可用,跳过所有插件钩子(含 auth 的 beforeCommand)。
          skipPluginHooks: true,
          args: {
            schema: z.object({
              lang: z.enum(["zh", "en"]).optional().describe("Wizard language (zh/en)"),
            }),
          },
          async run(_ctx: CommandContext<State>, args): Promise<CommandResult> {
            const state = requireLocalState();
            const detected = detectBizPackage();
            const interactive = Boolean(process.stdin.isTTY);
            const clack = await import("@clack/prompts");
            const workflow = new InstallWorkflow(
              new NodeInstallSystem(state),
              new ClackInstallPresenter(clack, interactive),
            );
            const code = await workflow.run({
              package: {
                name: options.pkgName ?? detected?.name ?? "",
                bin: options.binName ?? detected?.bin ?? "rxcli",
              },
              skillsSource: options.skillsSource,
              interactive,
              language: args.lang,
              auth: options.auth,
            });
            // 向导已通过 presenter 报告结果;BareError 只负责携带退出码,不渲染额外输出。
            if (code !== 0) throw new BareError(code);
            return rawText("");
          },
        }),
      },
    },
  };
}
