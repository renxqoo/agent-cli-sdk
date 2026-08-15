/**
 * @renxqoo/agent-cli-sdk/credentials —— 凭证与 provider chain 类型
 *
 * 设计依据:docs/05-credentials.md。
 * 两层 API 对照(方法名故意不同,避免混用):
 *   - 业务运行时:ctx.credentials.get/save/clear(走 provider chain;由业务包自写的 auth Plugin 填充)
 *   - provider 实现:configStore.loadCredentials/saveCredentials/...(直读文件)
 */

import type { FlowType } from "../flows/types.js";

// ============================================================================
// 凭证存储(ConfigStore:provider 实现者用,直读磁盘)
// ============================================================================

/**
 * 配置/凭证存储抽象。由 fileStore / memoryStore 实现;业务包自写的 auth Plugin 持有一个实例。
 * provider 内部用它直读写磁盘(不走 provider chain);命令运行时用 ctx.credentials(走 chain)。
 */
export interface ConfigStore {
  /** 读命名空间的凭证文件;null = 文件不存在。 */
  loadCredentials(namespace: string): Promise<Record<string, unknown> | null>;
  /** 写命名空间的凭证文件(权限 0600)。 */
  saveCredentials(namespace: string, data: Record<string, unknown>): Promise<void>;
  /** 清命名空间的凭证。 */
  clearCredentials(namespace: string): Promise<void>;
  /** 读命名空间的配置文件;不存在 = 空对象。配置与凭证同 namespace 隔离。 */
  loadConfig(namespace: string): Promise<Record<string, unknown>>;
  /** 写命名空间的配置文件(整体替换,权限 0600)。 */
  saveConfig(namespace: string, data: Record<string, unknown>): Promise<void>;
  /**
   * 在持有命名空间独占锁的情况下执行 `fn`。保护凭证的读-改-写事务
   * (如 OAuth refresh),避免跨进程并发互相覆盖丢失更新。
   * fileStore 用进程间文件锁实现,memoryStore 用进程内互斥。
   */
  withLock<T>(namespace: string, fn: () => Promise<T>): Promise<T>;
}

// ============================================================================
// Token 结果(provider 返回)
// ============================================================================

export interface TokenResult {
  token: string;
  type: "api-key" | "bearer" | "basic" | "custom";
  scopes?: string[];
  /** 来源描述(如 'env:ORDERS_API_KEY')。 */
  source: string;
  /** 过期时间戳(ms)。 */
  expiresAt?: number;
  /** OAuth 的刷新 token。 */
  refreshToken?: string;
  /** 401 时是否允许 auth plugin 使用其 refresh 策略切换 token。默认 false。 */
  refreshable?: boolean;
}

export interface IdentityHint {
  /** user / bot。 */
  identity: "user" | "bot";
  userId?: string;
  name?: string;
}

// ============================================================================
// Provider 接口 + chain 上下文
// ============================================================================

export interface ProviderContext {
  /** 命名空间。 */
  namespace: string;
  /** agent-cli-sdk 的配置存储(provider 内部直接读写文件,不走 chain)。 */
  configStore: ConfigStore;
  /** 命令参数(读 --api-key 等)。 */
  args: Record<string, unknown>;
  /** 环境变量。 */
  env: NodeJS.ProcessEnv;
}

/**
 * 凭证 provider:从某处取 token(flag/env/file/oauth)。
 * chain 按 priority 从小到大逐个调用,命中即停(返回非 null)。
 */
export interface CredentialProvider {
  /** provider 名(日志/溯源)。 */
  name(): string;
  /** 优先级,小值先试,默认 10。 */
  priority?(): number;
  /** null = 没有,chain 继续;非 null = 命中,用它的 token。 */
  resolveToken(pctx: ProviderContext): Promise<TokenResult | null>;
  /** 可选:推断 identity(user/bot)填统一输出格式顶层。 */
  resolveIdentity?(pctx: ProviderContext): Promise<IdentityHint | null>;
}

// ============================================================================
// 凭证文件结构(OAuth 场景)
// ============================================================================

/** OAuth 场景存盘的凭证形态(对齐 v1 StoredCredentials,字段转 camelCase)。 */
export interface StoredOAuthCredentials {
  token: string;
  refreshToken: string;
  /** Expiry ms epoch; undefined when the server omitted expires_in (RFC 6749 optional). */
  expiresAt?: number;
  scopes: string[];
  user?: { userId: string; name: string };
  storedAt: number;
  authMethod: FlowType;
}
