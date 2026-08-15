/**
 * @renxqoo/agent-cli-sdk —— defineCliApp:应用装配器(唯一目录决策点)
 *
 * vite 式装配:`dir` 是顶层配置,能力是插件,装配器把 resolved 本地状态派发给插件。
 * defineCliApp 是推荐入口;defineCli(同步、无 I/O)保留给高级/嵌入式用户。
 *
 * ```ts
 * const app = await defineCliApp({
 *   dir: join(homedir(), '.crm'),
 *   plugins: [
 *     defineAuth({ credentialNamespace: 'crm', baseUrl, scope }),
 *     defineInstaller({ skillsSource }),
 *     createUpdateNotifier({ packageName, currentVersion }),
 *   ],
 *   commands: {}, namespaces: {...}, ...
 * })
 * ```
 *
 * 流程:createLocalState({dir}) → 冻结 AppServices → 按注册序 applyPlugins
 * (插件在 apply 里解析 services、填充 provides;失败 = 启动失败)→ defineCli。
 */

import { defineCli } from "./define.js";
import { createLocalState, type LocalState } from "./local-state.js";
import { applyPlugins } from "./plugin.js";
import type { AppServices } from "./plugin-contracts.js";
import type { App, DefineCliOptions } from "./types.js";

/** 目录决策:dir(文件本地状态)与 localState(注入/内存)二选一,类型级互斥。 */
export type DefineCliAppState =
  | { dir: string; localState?: undefined }
  | { localState: LocalState; dir?: undefined };

export type DefineCliAppOptions<State> = DefineCliOptions<State> & DefineCliAppState;

/**
 * 装配并编译一个 CLI app。异步:插件的 apply 可能读配置/发网络请求(如 defineAuth)。
 * 任一插件装配失败则 reject —— 与旧版"模块顶层 await defineAuth 失败"同语义。
 */
export async function defineCliApp<State = Record<string, never>>(
  options: DefineCliAppOptions<State>,
): Promise<App> {
  const { dir, localState, ...cliOptions } = options;
  if (dir !== undefined && localState !== undefined) {
    throw new TypeError("defineCliApp: dir and localState are mutually exclusive");
  }
  const state: LocalState = localState ?? createLocalState({ dir });
  const services: Readonly<AppServices> = Object.freeze({
    localState: state,
    appName: cliOptions.name,
    ...(cliOptions.binName !== undefined ? { binName: cliOptions.binName } : {}),
  });

  await applyPlugins(cliOptions.plugins ?? [], services);
  // DefineCliOptions 的 createState 是分布式条件类型,无法穿透 Omit;此 cast 仅恢复其形状。
  return defineCli(cliOptions as DefineCliOptions<State>);
}
