# 错误完整目录 + errorOnStatus 推荐配置（中文）

> 在这里查询 9 个错误 Category、标准 subtype、退出码和 `errorOnStatus` 配置。

## 导航

1. Category、subtype 与退出码
2. `errorOnStatus` 配置
3. 类型化错误示例
4. 注册、包装、脱敏与 `BareError`

## 1. 全部 subtype 速查

### validation (exit 2)

| subtype            | 用法                              | example            |
| ------------------ | --------------------------------- | ------------------ |
| `invalid_argument` | flag/位置参数不合法(类型错、值错) | `--limit` 不是数字 |
| `missing_required` | 必填参数没传                      | 漏了 `<id>`        |
| `out_of_range`     | 值在范围外(数量超限、日期错)      | `--limit 9999`     |

### authentication (exit 3) — 没登录

| subtype            | 用法                                         |
| ------------------ | -------------------------------------------- |
| `no_token`         | 完全没凭证                                   |
| `token_expired`    | access token 过期且 refresh 失败(需重新登录) |
| `token_revoked`    | 主动吊销或服务端拒绝                         |
| `no_credentials`   | 没配置凭证(provider chain 全 null)           |
| `no_refresh_token` | OAuth 流程缺 refresh_token                   |

### authorization (exit 3) — 登录了但缺权限

| subtype                 | 用法           | 扩展字段                  |
| ----------------------- | -------------- | ------------------------- |
| `missing_scope`         | token 缺 scope | `missingScopes: string[]` |
| `app_permission_denied` | 应用级权限不足 | —                         |
| `forbidden`             | 通用 403       | —                         |

### config (exit 3)

| subtype          | 用法                          |
| ---------------- | ----------------------------- |
| `missing_config`    | 本地配置缺失(如 baseUrl 没设)   |
| `invalid_config`    | 配置值不合法                    |
| `unbound_env`       | 环境变量没绑定                  |
| `skill_sync_failed` | skills 同步失败(权限/磁盘/路径) |

### network (exit 4, 默认 `retryable:true`)

| subtype              | 用法         |
| -------------------- | ------------ |
| `timeout`            | 请求超时     |
| `connection_refused` | 连接拒绝     |
| `dns_failure`        | DNS 解析失败 |
| `ssl_error`          | TLS/SSL 错误 |

### api (exit 1)

| subtype          | 用法               | 备注                                  |
| ---------------- | ------------------ | ------------------------------------- |
| `not_found`      | 资源不存在(404)    | `NotFoundError(msg)` 快捷写法         |
| `already_exists` | 创建时冲突(409)    | 唯一索引冲突                          |
| `conflict`       | 业务冲突(状态机错) | —                                     |
| `rate_limited`   | 限流(429)          | `retryable:true` + `Retry-After` hint |
| `server_error`   | 5xx                | `retryable:true`(>=500)               |

### policy (exit 6)

| subtype              | 用法                 |
| -------------------- | -------------------- |
| `content_blocked`    | 内容触发风控         |
| `challenge_required` | 需要验证码 / MFA     |
| `access_denied`      | IP 黑名单 / 地理限制 |

### internal (exit 5) — SDK 不该发生

| subtype              | 用法                     |
| -------------------- | ------------------------ |
| `decode_failure`     | 响应 JSON 解析失败       |
| `unknown`            | 兜底(裸 Error 被包装)    |
| `contract_violation` | SDK 契约违反(框架内部用) |

### confirmation (exit 10)

| subtype           | 用法             | hint 模板           |
| ----------------- | ---------------- | ------------------- |
| `high_risk_write` | 高危写入需要确认 | `加 --yes 跳过确认` |

---

## 2. 推荐 errorOnStatus 配置

```ts
defineCli({
  errorOnStatus: {
    403: "forbidden",
    404: "not_found",
    409: "already_exists",
    429: "rate_limited",
    "5xx": "server_error",
  },
});
```

| status | subtype          | → Category               | → exit |
| ------ | ---------------- | ------------------------ | :----: |
| 403    | `forbidden`      | authorization            |   3    |
| 404    | `not_found`      | api                      |   1    |
| 409    | `already_exists` | api                      |   1    |
| 429    | `rate_limited`   | api(自动 retryable:true) |   1    |
| 5xx    | `server_error`   | api(自动 retryable:true) |   1    |

`errorOnStatus` 的值**只写 subtype 字符串**,不写构造器名。agent-cli-sdk 自动从 subtype 注册表查 Category 选构造器。

401 是请求层保留状态：框架会尝试一次 auth refresh/retry，最终仍为 401 时固定抛 `AuthenticationError(token_expired)`；不需要也不应依赖 `errorOnStatus` 配置 401。

---

## 3. 何时用 `errorOnStatus`,何时手写 if

**用 `errorOnStatus` 的场景**:

- 业务错误语义和 HTTP status 完全对齐(如 404 = 不存在)
- 多个命令都要同样处理(集中配)

**手写 if 的场景**:

- 同一 status 在不同命令下语义不同(如 404 在 `get` 是"资源不存在",在 `create` 是"父资源不存在")
- 想给特定 status 加业务专属 hint
- 想给特定 status 加扩展字段(如 `missingScopes`)

```ts
// 该 status 需要命令专属语义时，不要把它放进全局 errorOnStatus
get: defineCommand({
  async run(ctx, { id }) {
    const res = await ctx.get(`/orders/${id}`)
    // 特殊:404 在这里给业务专属 hint
    if (res.status === 404) {
      throw new errs.NotFoundError(`订单 ${id} 不存在,可能属于其他用户`)
    }
    return { data: res.data }
  },
}),
```

已配置进 `errorOnStatus` 的响应会在 `ctx.get/post/...` 返回前抛出，因此命令内同 status 的 `if` 分支不可达，不能用于覆盖全局映射。

---

## 4. 完整错误抛出示例

```ts
import { errs } from "@renxqoo/agent-cli-sdk";

// ① 参数错误
throw new errs.ValidationError({
  subtype: "invalid_argument",
  param: "--limit",
  message: "--limit 必须为 1-100 的正数",
  hint: "使用 --limit 30(默认) 或 --limit 1-100",
});

// ② 必填参数缺失
throw new errs.ValidationError({
  subtype: "missing_required",
  param: "id",
  message: "缺少订单 ID",
  hint: "用法:my-cli orders get <id>",
});

// ③ 权限不足(带 missingScopes 扩展字段)
throw new errs.PermissionError({
  subtype: "missing_scope",
  message: "缺少 orders:write 权限",
  hint: "联系管理员授权 orders:write；更新客户端 scope 后重新登录",
  missingScopes: ["orders:write"],
});

// ④ 网络超时(可重试)
throw new errs.NetworkError({
  subtype: "timeout",
  message: "请求超时(30s)",
  retryable: true,
  cause: originalError,
});

// ⑤ 限流(带 Retry-After)
throw new errs.APIError({
  subtype: "rate_limited",
  code: 429,
  message: "请求过于频繁",
  hint: "Retry-After: 60s",
  retryable: true,
});

// ⑥ 高危写入(需要 --yes)
throw new errs.ConfirmationRequiredError({
  subtype: "high_risk_write",
  message: "批量删除 100 条记录",
  hint: "加 --yes 跳过确认",
});

// ⑦ NotFoundError 快捷写法
throw new errs.NotFoundError(`订单 ${id} 不存在`);
// 等价于 new errs.APIError({ subtype:'not_found', code:404, message })
```

---

## 5. errorOnStatus 注册表校验

**`defineCli` 启动期会校验 `errorOnStatus` 的每个 subtype 是否已在 `SUBTYPE_REGISTRY` 登记**——拼错的 subtype 会**立刻 throw**(不进 `run`),避免请求时悄悄降级成 `internal`(exit 5)。

```ts
defineCli({
  errorOnStatus: { 404: "not_foundd" }, // ← 拼错
  // → defineCli 立刻 throw:subtype "not_foundd"(配在 status 404)未在 SUBTYPE_REGISTRY 登记
});

// 结构化写命令不要手工抛此错误；声明 operation.confirmation: "required"
```

写命令由运行时在 Zod 校验、dry-run 和幂等策略之后、进入业务 `run` 之前统一确认。argv 和 JSON 模式使用同一个 `policy`；不要在业务 `run` 中重复确认。

所以 `errorOnStatus` 的值必须和下表 §1 的标准 subtype **逐字一致**。新增自定义 subtype 时,先登记:

```ts
// 业务包入口登记自己的 subtype 到 SUBTYPE_REGISTRY
import { SUBTYPE_REGISTRY } from "@renxqoo/agent-cli-sdk";

SUBTYPE_REGISTRY["my_custom_subtype"] = { category: "api" };
```

> 直接修改全局注册表是反模式。**优先复用标准 subtype**;确需自定义时再用上述方式登记(后续 agent-cli-sdk 会提供声明式方式)。

---

## 6. 错误 wrap 规则

**re-wrap 已类型化的错误会丢失 category/subtype,等于降级。**

```ts
try {
  return await ctx.get("/orders");
} catch (err) {
  // 已类型化则透传
  if (err instanceof errs.CliError) throw err;
  // 非类型化才包装
  throw new errs.InternalError({ subtype: "unknown", message: "意外错误", cause: err });
}
```

**cause 字段保留底层错误**,让 `errors.is` / `errors.Unwrap` 仍能工作。

---

## 7. handleError 插件:错误归一化/脱敏

```ts
const errorNormalizePlugin = {
  name: "error-normalize",
  async handleError(ctx, err) {
    if (!(err instanceof errs.CliError)) return { action: "pass" };
    // 脱敏:防止 token 漏到 message
    if (err.message) {
      err.message = err.message.replace(/Bearer [A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
    }
    return { action: "replace", error: err };
  },
};
```

`observeError` 只观察，void 永远不会恢复错误。`handleError` 按 enforce(pre→normal→post)链式执行，并要求显式返回 `pass`、`replace` 或 `recover`；只有 `recover` 会把命令转为成功。

---

## 8. BareError 例外(谓词命令)

少数命令(`auth check`)stdout 已携带完整答案(yes/no),只需对应 exit code,不要 stderr 统一输出格式:

```ts
if (!loggedIn) throw new errs.BareError(3); // exit 3,stderr 不渲染统一输出
```

`BareError` 是**唯一**绕过错误输出的类型。普通命令禁用。
