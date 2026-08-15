/**
 * @renxqoo/agent-cli-sdk —— 统一输出序列化
 *
 * 设计依据:docs/03-envelopes.md。
 * 关键决策(case 转换边界):**只转统一输出骨架字段 camelCase→snake_case,data 原样不动**。
 * 实现策略:手写骨架字段映射表(非通用递归转换)——杜绝误伤 data 里的业务字段。
 *   业务包 run 返回 { data: { userId: 'u1' } } → wire 里仍是 userId(不变成 user_id)。
 *   只有 meta.pagination.nextToken、dryRun、missingScopes 等骨架字段转 snake。
 */

import type { Meta } from "./types.js";
import { CliError } from "./errs/index.js";

export type Identity = "user" | "bot";

export interface SerializeSuccessOptions {
  /** 来源业务 namespace；pipe reader 用它构造稳定的 PipeRecord.type。 */
  source: string;
  identity?: Identity;
  /** D4: dry-run 模式标记(03-envelopes.md)。出现时为 true,正常请求省略。 */
  dryRun?: boolean;
  /** D4: 系统级提示(版本更新/skill 漂移)。下划线前缀表示非业务字段。 */
  notice?: Record<string, unknown>;
}

export interface SerializeErrorOptions {
  identity?: Identity;
}

// ============================================================================
// 骨架字段映射表(只这些 key 转 snake_case;data 内字段不动)
// ============================================================================

/**
 * 转换 meta 对象:骨架层 camelCase→snake_case。
 * 骨架字段(count/pagination/rollback)显式处理 + snake 转换;
 * 其余字段是业务自定义 meta(Meta 类型 [key:string]:unknown 允许),原样透传。
 */
function transformMeta(meta: Meta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (meta.count !== undefined) out.count = meta.count;
  if (meta.rollback !== undefined) out.rollback = meta.rollback;
  if (meta.pagination !== undefined && meta.pagination !== null) {
    const p = meta.pagination;
    const pg: Record<string, unknown> = { complete: p.complete };
    if (p.pages !== undefined) pg.pages = p.pages;
    if (p.items !== undefined) pg.items = p.items;
    if (p.nextToken !== undefined) pg.next_token = p.nextToken; // ← 骨架转 snake
    out.pagination = pg;
  }
  // 其余业务 meta 字段原样透传；运行时能力不再借用 meta key 表达。
  for (const [k, v] of Object.entries(meta)) {
    if (k === "count" || k === "rollback" || k === "pagination") continue; // 骨架已处理
    out[k] = v;
  }
  return out;
}

// ============================================================================
// 成功输出
// ============================================================================

/**
 * 序列化成功输出到紧凑 JSON 字符串(stdout)。
 * 结构:{ ok:true, [identity], [source], data, meta, [dry_run], [_notice] }
 * data 原样输出(不转 case);meta 骨架转 snake。
 */
export function serializeSuccess(
  data: unknown,
  meta: Meta | undefined,
  opts: SerializeSuccessOptions,
): string {
  const env: Record<string, unknown> = { ok: true };
  if (opts.identity) env.identity = opts.identity;
  env.source = opts.source;
  env.data = data;
  if (meta) env.meta = transformMeta(meta);
  // D4:dry_run 出现时为 true;_notice 是信息性字段(下划线前缀=非业务字段)
  if (opts.dryRun) env.dry_run = true;
  if (opts.notice) env._notice = opts.notice;
  return JSON.stringify(env);
}

// ============================================================================
// 错误输出
// ============================================================================

/**
 * 把 CliError 的扩展字段序列化进 wire(per-subtype-stable 白名单)。
 * 字段名转 snake_case:missingScopes→missing_scopes、consoleUrl→console_url。
 * param/params 这类本身就是参数名形态(param 值可能是 --limit / id),原样保留。
 */
function transformErrorExtensions(err: CliError): Record<string, unknown> {
  const ext: Record<string, unknown> = {};
  if (err.missingScopes !== undefined) ext.missing_scopes = err.missingScopes;
  if (err.consoleUrl !== undefined) ext.console_url = err.consoleUrl;
  if (err.param !== undefined) ext.param = err.param;
  if (err.params !== undefined) ext.params = err.params;
  return ext;
}

/**
 * 序列化错误输出到紧凑 JSON 字符串(stderr)。
 * 结构:{ ok:false, [identity], error:{ type, subtype, [code], message, [hint], [retryable], [扩展...] } }
 */
export function serializeError(err: CliError, opts: SerializeErrorOptions = {}): string {
  const errorObj: Record<string, unknown> = {
    type: err.category,
    subtype: err.subtype,
    message: err.message,
  };
  if (err.code !== undefined) errorObj.code = err.code;
  if (err.hint !== undefined) errorObj.hint = err.hint;
  if (err.retryable !== undefined) errorObj.retryable = err.retryable;
  Object.assign(errorObj, transformErrorExtensions(err));

  const env: Record<string, unknown> = { ok: false };
  if (opts.identity) env.identity = opts.identity;
  env.error = errorObj;
  return JSON.stringify(env);
}
