/**
 * @renxqoo/agent-cli-sdk —— defineAuth:OAuth 2.1 鉴权工厂
 *
 * 把标准 OAuth 2.1 三种流程收编成框架层的一个插件工厂(同步):
 *   - device(设备授权,RFC 8628)—— 受限设备的交互流程,默认
 *   - authorization_code(授权码 + PKCE,RFC 6749 §4.1 + RFC 7636)—— 唯一需要用户交互的流程
 *   - client_credentials(客户端凭据,RFC 6749 §4.4)—— 服务器间的无用户流程
 *
 * 异步装配(读配置)在插件 apply(services) 里完成,defineCliApp 自动执行;
 * 同时通过 plugin.provides 自动贡献命令(login/status/logout/register)。
 * 注册 metadata(RFC 7591)按字段缺省派生:client_name ← credentialNamespace、
 * grant_types ← flow、scope ← opts.scope、token_endpoint_auth_method ← client_secret_basic;
 * 显式传 clientMetadata 字段优先。
 *
 * ```ts
 * const app = await defineCliApp({
 *   dir, plugins: [
 *     defineAuth({                       // 同步工厂,不碰文件
 *       credentialNamespace: 'crm',      // → config/crm.json + credentials/crm.json
 *       baseUrl: AUTH_BASE_URL,          // OAuth 中间层
 *       scope: 'company.api offline_access', // 授权与注册声明共用,业务自定,无默认
 *     }),
 *   ], ...
 * })
 * ```
 *
 * 精确豁免:auth plugin 贡献的命令(login/status/logout/register)自动跳过自身 beforeCommand,
 * 故 login 不会被"必须登录"拦截。
 */

import type { Plugin, CommandGroup, CommandContext } from "../types.js";
import { type ClientMetadata, type OAuthClientConfig } from "../oauth.js";
import { deviceFlow } from "../flows/device.js";
import { authCodeFlow } from "../flows/authCode.js";
import { clientCredentialsFlow } from "../flows/clientCredentials.js";
import type { AuthFlow, FlowType } from "../flows/types.js";
import { createLoginCommand } from "./commands/login.js";
import { createStatusCommand } from "./commands/status.js";
import { createLogoutCommand } from "./commands/logout.js";
import { createRegisterCommand } from "./commands/register.js";
import type { ConfigStore } from "../credentials/index.js";
import type { CredentialProvider } from "../credentials/types.js";
import { credentialArgsKey } from "../context.js";
import { InternalError } from "../errs/index.js";
import {
  buildOn401Handler,
  buildProviderChain,
  resolveAuthConfig,
  resolveClientMetadata,
} from "./helpers.js";
import { AuthSessionManager } from "./session-manager.js";

// ============================================================================
// 工厂入参/出参类型
// ============================================================================

export interface DefineAuthOptions {
  /** 凭证与配置隔离命名空间(决定 credentials/<ns>.json 与 config/<ns>.json)。 */
  credentialNamespace: string;
  /** OAuth/auth 中间层地址(device flow / token / user_info / revoke / register 端点)。 */
  baseUrl: string;
  /**
   * OAuth 2.1 scope。授权请求与注册声明(clientMetadata.scope)共用这一份;
   * 两者需要不同时,在 clientMetadata 里显式写 scope 覆盖。
   * 空/未传 = 不带 scope。
   */
  scope?: string;
  /** 命令命名空间(→ rxcli <ns> login)。默认 'auth'。 */
  commandNamespace?: string;
  /**
   * clientId/clientSecret:优先 env(RXCLI_CLIENT_ID/SECRET),回退 config/<ns>.json(register 写入)。
   * 不传 = 空；未注册客户端可先运行 register 命令写入配置。
   */
  clientId?: string;
  clientSecret?: string;
  /**
   * OAuth 2.1 流程。默认 "device"。
   * - "device":设备授权(RFC 8628,CLI/无头设备,支持 --no-wait/--device-code split-flow)
   * - "authorization_code":授权码 + PKCE(唯一需要用户交互的流程)
   * - "client_credentials":客户端凭证(服务器间,无用户)
   */
  flow?: FlowType;
  /**
   * RFC 7591 client_metadata(注册时声明)。缺省字段按 flow/scope 派生
   * (见 resolveClientMetadata);显式字段优先。
   */
  clientMetadata?: ClientMetadata;
  /** authorization_code flow:本地回调端口(不传=随机)。 */
  redirectPort?: number;
  /**
   * 预注入的 Bearer token(sandbox/CI 场景,admin issue-token 返回的 JWT)。
   * 设了就直接用(priority=0,最高优先),跳过 provider chain + login。
   * 最简注入:defineAuth({ credentialNamespace, baseUrl, bearerToken: process.env.CRM_BEARER_TOKEN })
   */
  bearerToken?: string;
  /**
   * 自定义 provider chain。不传 = defaultProviders()。
   * 业务 app 可自定义 token 来源(如环境变量、文件、secret manager)。
   */
  providers?: CredentialProvider[];
}

// ============================================================================
// defineAuth 工厂
// ============================================================================

/**
 * 创建 OAuth 2.1 鉴权 plugin(钩子 + 命令一捆)。
 *
 * 同步工厂:不碰任何文件/网络。异步装配在 apply(services) 完成 ——
 * `defineCliApp` 自动调用;低层用户手动 `await plugin.apply?.(services)`。
 * 未装配(或装配失败)时钩子抛 InternalError,绝不静默降级。
 *
 * @returns Plugin,塞进 defineCliApp/defineCli 的 plugins[] 即:钩子生效 + auth 命令自动挂载。
 *          业务无需在 namespaces 里手挂 auth。
 */
export function defineAuth<State = Record<string, never>>(opts: DefineAuthOptions): Plugin<State> {
  // —— 基础配置(同步) ——
  const cmdNs = opts.commandNamespace ?? "auth";
  const credNs = opts.credentialNamespace;

  // —— 选 flow(OAuth 2.1 三种,默认 device) ——
  const flowType = opts.flow ?? "device";
  const flow = resolveFlow(flowType);

  // —— 注册 metadata 归一化(缺省字段按 flow/scope 派生,显式优先) ——
  const clientMetadata = resolveClientMetadata({
    credentialNamespace: credNs,
    flow: flowType,
    scope: opts.scope,
    clientMetadata: opts.clientMetadata,
  });

  // —— apply 里完成的装配(异步:读 config/<ns>.json) ——
  let assembly: { sessions: AuthSessionManager; commands: CommandGroup } | null = null;
  const requireAssembly = (): { sessions: AuthSessionManager; commands: CommandGroup } => {
    if (!assembly) {
      throw new InternalError({
        subtype: "contract_violation",
        message: `auth plugin (${credNs}) used before apply(services) completed`,
      });
    }
    return assembly;
  };

  return {
    name: `auth:${credNs}`,
    enforce: "pre",

    async apply(services) {
      const store = services.localState.store;

      // —— ① 解析 client 凭证(env → config/<ns>.json → 空)——
      const { oauth } = await resolveAuthConfig(opts, store, credNs);

      // —— ② 构造 provider chain ——
      const providers = buildProviderChain(opts);

      // —— ③ 构造 401 续期 handler(只创建一次,singleflight map 才能覆盖并发 401) ——
      const refresh = buildOn401Handler({
        flow,
        oauth,
        store,
        namespace: credNs,
        scope: opts.scope,
      });

      const sessions = new AuthSessionManager({
        namespace: credNs,
        commandNamespace: cmdNs,
        store,
        providers,
        refresh,
      });

      // —— ④ 构造 auth 命令组 ——
      const commands = createAuthCommands({
        oauth,
        store,
        credentialNamespace: credNs,
        commandNamespace: cmdNs,
        scope: opts.scope,
        baseUrl: opts.baseUrl,
        flow,
        clientMetadata,
        redirectPort: opts.redirectPort,
      });
      assembly = { sessions, commands };
    },

    get provides() {
      return assembly ? { namespaces: { [cmdNs]: assembly.commands } } : undefined;
    },

    async beforeCommand(ctx: CommandContext<State>): Promise<void> {
      const credentialArgs = (
        ctx as CommandContext<State> & { [credentialArgsKey]?: Record<string, unknown> }
      )[credentialArgsKey];
      await requireAssembly().sessions.authenticate(ctx, credentialArgs);
    },

    async beforeRequest(ctx: CommandContext<State>, request) {
      return requireAssembly().sessions.prepare(ctx, request);
    },

    async handleUnauthorized(ctx: CommandContext<State>) {
      return requireAssembly().sessions.handleUnauthorized(ctx);
    },
  };
}

// ============================================================================
// flow 选择 + auth 命令组构造
// ============================================================================

/**
 * 根据 flow 类型选 OAuth 2.1 策略(参数传入,非全局 registry)。
 * FlowType 是三值联合,switch 穷尽;新增流程必须在此补映射。
 */
function resolveFlow(type: FlowType): AuthFlow {
  switch (type) {
    case "device":
      return deviceFlow;
    case "authorization_code":
      return authCodeFlow;
    case "client_credentials":
      return clientCredentialsFlow;
  }
}

interface AuthCommandOpts {
  oauth: OAuthClientConfig;
  store: ConfigStore;
  credentialNamespace: string;
  commandNamespace: string;
  scope?: string;
  baseUrl: string;
  /** 鉴权流程策略。 */
  flow: AuthFlow;
  /** RFC 7591 client_metadata(register 用;已按 flow/scope 派生归一化)。 */
  clientMetadata: ClientMetadata;
  /** authorization_code flow 回调端口。 */
  redirectPort?: number;
}

function createAuthCommands(o: AuthCommandOpts): CommandGroup {
  const credNs = o.credentialNamespace;
  const cmdNs = o.commandNamespace;

  return {
    login: createLoginCommand({
      oauth: o.oauth,
      store: o.store,
      credentialNamespace: credNs,
      commandNamespace: cmdNs,
      scope: o.scope,
      flow: o.flow,
      redirectPort: o.redirectPort,
    }),
    status: createStatusCommand({
      oauth: o.oauth,
      store: o.store,
      credentialNamespace: credNs,
      commandNamespace: cmdNs,
    }),
    logout: createLogoutCommand({
      oauth: o.oauth,
      store: o.store,
      credentialNamespace: credNs,
    }),
    register: createRegisterCommand({
      baseUrl: o.baseUrl,
      store: o.store,
      credentialNamespace: credNs,
      commandNamespace: cmdNs,
      clientMetadata: o.clientMetadata,
    }),
  };
}
