/**
 * @renxqoo/agent-cli-sdk/errs —— 9 类类型化错误 + exit code 映射
 *
 * 设计依据:docs/04-errors.md。
 * 业务包 throw 类型化错误,agent-cli-sdk 捕获后渲染成统一输出格式到 stderr(见 envelope.ts)。
 * 裸 throw new Error(...) 会被兜底成 internal/unknown(exit 5)——所以永远用 errs.*。
 */

// ============================================================================
// Category + exit code
// ============================================================================

export type Category =
  | "validation"
  | "authentication"
  | "authorization"
  | "config"
  | "network"
  | "api"
  | "policy"
  | "internal"
  | "confirmation";

/** category → exit code(对齐 04-errors.md 的映射表)。 */
export function exitCodeOf(category: Category): number {
  switch (category) {
    case "validation":
      return 2;
    case "authentication":
    case "authorization":
    case "config":
      return 3;
    case "network":
      return 4;
    case "internal":
      return 5;
    case "policy":
      return 6;
    case "confirmation":
      return 10;
    case "api":
    default:
      return 1;
  }
}

// ============================================================================
// subtype 注册表(errorOnStatus 反推 category + 构造器)
// ============================================================================

/**
 * subtype → { category } 映射。供 errorOnStatus 把 status→subtype 反推回 category。
 * 新增 subtype 必须在此登记(对应 04-errors.md 的"CI 校验未声明 subtype"决策)。
 */
export const SUBTYPE_REGISTRY: Record<string, { category: Category }> = {
  // validation
  invalid_argument: { category: "validation" },
  missing_required: { category: "validation" },
  out_of_range: { category: "validation" },

  // authentication
  no_token: { category: "authentication" },
  token_expired: { category: "authentication" },
  token_revoked: { category: "authentication" },
  no_credentials: { category: "authentication" },
  no_refresh_token: { category: "authentication" },

  // authorization
  missing_scope: { category: "authorization" },
  app_permission_denied: { category: "authorization" },
  forbidden: { category: "authorization" },

  // config
  missing_config: { category: "config" },
  invalid_config: { category: "config" },
  unbound_env: { category: "config" },
  skill_sync_failed: { category: "config" },

  // network
  timeout: { category: "network" },
  connection_refused: { category: "network" },
  dns_failure: { category: "network" },
  ssl_error: { category: "network" },

  // api
  not_found: { category: "api" },
  already_exists: { category: "api" },
  conflict: { category: "api" },
  rate_limited: { category: "api" },
  server_error: { category: "api" },

  // policy
  content_blocked: { category: "policy" },
  challenge_required: { category: "policy" },
  access_denied: { category: "policy" },

  // internal
  decode_failure: { category: "internal" },
  unknown: { category: "internal" },
  contract_violation: { category: "internal" },

  // confirmation
  high_risk_write: { category: "confirmation" },
};

/** 查 subtype 的 category;未登记回退 internal(defineCli 启动期已对 errorOnStatus 做登记校验)。 */
export function categoryOfSubtype(subtype: string): Category {
  return SUBTYPE_REGISTRY[subtype]?.category ?? "internal";
}

// ============================================================================
// Problem 结构(所有错误类型的通用数据)
// ============================================================================

/** 扩展字段白名单:这些 Problem 扩展字段会序列化进 wire(详见 envelope.ts)。 */
export interface Problem {
  category: Category;
  subtype: string;
  /** 上游数字码(HTTP status / API code)。 */
  code?: number;
  /** 给人看,不保证稳定。 */
  message: string;
  /** 给 agent 的可执行恢复指令。 */
  hint?: string;
  /** 是否可重试。 */
  retryable?: boolean;
  /** 保留底层错误(errors.Is/Unwrap 可用)。 */
  cause?: unknown;

  // —— 扩展字段(按 subtype 出现,白名单序列化)——
  /** ValidationError:出错的参数名(flag 带 --,位置参数用原名)。 */
  param?: string;
  /** ValidationError:多参数校验详情数组。 */
  params?: Array<{ param: string; message: string }>;
  /** PermissionError:机器可读的缺失 scope 列表。 */
  missingScopes?: string[];
  /** 可选:服务端控制台 URL。 */
  consoleUrl?: string;
}

// ============================================================================
// CliError 基类
// ============================================================================

/** 所有类型化错误的基类,持有 Problem。 */
export class CliError extends Error {
  readonly category: Category;
  readonly subtype: string;
  readonly code?: number;
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly param?: string;
  readonly params?: Array<{ param: string; message: string }>;
  readonly missingScopes?: string[];
  readonly consoleUrl?: string;

  constructor(p: Problem) {
    super(p.message);
    this.name = new.target.name;
    this.category = p.category;
    this.subtype = p.subtype;
    if (p.code !== undefined) this.code = p.code;
    if (p.hint !== undefined) this.hint = p.hint;
    if (p.retryable !== undefined) this.retryable = p.retryable;
    if (p.param !== undefined) this.param = p.param;
    if (p.params !== undefined) this.params = p.params;
    if (p.missingScopes !== undefined) this.missingScopes = p.missingScopes;
    if (p.consoleUrl !== undefined) this.consoleUrl = p.consoleUrl;
    // ES2022 cause:保留底层错误,让 errors.is/Unwrap 仍能工作
    if (p.cause !== undefined) (this as { cause?: unknown }).cause = p.cause;
  }

  /** 导出为 Problem(序列化用)。 */
  toProblem(): Problem {
    const p: Problem = {
      category: this.category,
      subtype: this.subtype,
      message: this.message,
    };
    if (this.code !== undefined) p.code = this.code;
    if (this.hint !== undefined) p.hint = this.hint;
    if (this.retryable !== undefined) p.retryable = this.retryable;
    if (this.param !== undefined) p.param = this.param;
    if (this.params !== undefined) p.params = this.params;
    if (this.missingScopes !== undefined) p.missingScopes = this.missingScopes;
    if (this.consoleUrl !== undefined) p.consoleUrl = this.consoleUrl;
    return p;
  }
}

// ============================================================================
// 9 类类型化错误
// ============================================================================

/** ① 参数错误(用户输入不对)exit 2。 */
export class ValidationError extends CliError {
  constructor(p: Omit<Problem, "category"> & { category?: never }) {
    super({ ...p, category: "validation" });
  }
}

/** ② 需要登录(token 不存在或失效)exit 3。 */
export class AuthenticationError extends CliError {
  constructor(p: Omit<Problem, "category"> & { category?: never }) {
    super({ ...p, category: "authentication" });
  }
}

/** ③ 权限不足(token 有效但缺 scope)exit 3。 */
export class PermissionError extends CliError {
  constructor(p: Omit<Problem, "category"> & { category?: never }) {
    super({ ...p, category: "authorization" });
  }
}

/** ④ 配置错误(本地配置缺失 / 未绑定)exit 3。 */
export class ConfigError extends CliError {
  constructor(p: Omit<Problem, "category"> & { category?: never }) {
    super({ ...p, category: "config" });
  }
}

/** ⑤ 网络错误(DNS/超时/拒绝/传输层)exit 4。 */
export class NetworkError extends CliError {
  constructor(p: Omit<Problem, "category"> & { category?: never }) {
    super({ ...p, category: "network" });
  }
}

/** ⑥ API 错误(服务端业务错误,HTTP 非 2xx)exit 1。 */
export class APIError extends CliError {
  constructor(p: Omit<Problem, "category"> & { category?: never }) {
    super({ ...p, category: "api" });
  }
}

/**
 * ⑥' 资源不存在(API 错误的特例,常用)。
 * NotFoundError(msg) 等价于 new APIError({ subtype:'not_found', code:404, message:msg })。
 */
export class NotFoundError extends APIError {
  constructor(message: string, opts?: { hint?: string; code?: number }) {
    super({ subtype: "not_found", code: opts?.code ?? 404, message, hint: opts?.hint });
  }
}

/**
 * ⑥'' 资源冲突(并发下资源已被占用,HTTP 409 同义)。
 * 典型用途:跨进程文件锁竞争(skills sync 等)。默认可重试,避免下游用 message 字符串匹配。
 */
export class ConflictError extends APIError {
  constructor(message: string, opts?: { hint?: string; code?: number }) {
    super({
      subtype: "conflict",
      code: opts?.code ?? 409,
      message,
      hint: opts?.hint,
      retryable: true,
    });
  }
}

/** ⑦ 策略拦截(风控/内容安全/安全挑战)exit 6。 */
export class PolicyError extends CliError {
  constructor(p: Omit<Problem, "category"> & { category?: never }) {
    super({ ...p, category: "policy" });
  }
}

/** ⑧ 内部错误(SDK 契约违反 / 解码失败 / 不该发生)exit 5。 */
export class InternalError extends CliError {
  constructor(p: Omit<Problem, "category"> & { category?: never }) {
    super({ ...p, category: "internal" });
  }
}

/** ⑨ 需要确认(高风险写入需要 --yes)exit 10。 */
export class ConfirmationRequiredError extends CliError {
  constructor(p: Omit<Problem, "category"> & { category?: never }) {
    super({ ...p, category: "confirmation" });
  }
}

// ============================================================================
// BareError:绕过错误输出的唯一例外
// ============================================================================

/**
 * 谓词命令(如 auth check)专用:stdout 已携带完整答案,只想要对应的 exit code,
 * 不渲染 stderr 错误输出。是错误侧输出契约的唯一例外(成功侧对应 skills read)。
 * 普通业务命令禁用,正常失败必须 throw 9 类类型化错误。
 *
 * BUG-14:BareError 自带 category/subtype 只读字段,类型自洽 —— 即使误走
 * serializeError/toCliError 路径也不会产出 type/subtype: undefined。
 * pipeline 仍单独处理 exitCode(不走错误输出渲染)。
 */
export class BareError extends Error {
  readonly exitCode: number;
  readonly category: Category = "internal";
  readonly subtype = "bare_exit";
  constructor(exitCode: number) {
    super(`BareError(${exitCode})`);
    this.name = "BareError";
    this.exitCode = exitCode;
  }
}

// ============================================================================
// 工具:把任意错误归一化成 CliError
// ============================================================================

/**
 * 非 CliError 的裸 Error / 值 → 包装成 InternalError(unknown)。
 * re-wrap 已类型化的错误会丢失原始 category/subtype,等于降级——所以业务包 catch 后
 * 应 instanceof CliError 透传,只有非类型化错误才走这里。
 */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  // BareError 自带 category/subtype(BUG-14),类型自洽;pipeline 仍单独处理其 exitCode。
  if (err instanceof BareError) return err as unknown as CliError;
  const message = err instanceof Error ? err.message : String(err);
  return new InternalError({ subtype: "unknown", message, cause: err });
}

/** errs 命名空间导出(对齐文档 `import { errs } from '@renxqoo/agent-cli-sdk'` 用法)。 */
export const errs = {
  CliError,
  ValidationError,
  AuthenticationError,
  PermissionError,
  ConfigError,
  NetworkError,
  APIError,
  NotFoundError,
  ConflictError,
  PolicyError,
  InternalError,
  ConfirmationRequiredError,
  BareError,
  exitCodeOf,
  categoryOfSubtype,
};
