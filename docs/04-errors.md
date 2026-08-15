# 04 · 错误分类与 exit code

> agent-cli-sdk 用 9 类类型化错误 + exit code 映射,把"命令失败"变成 agent 可精确分支的结构化信号。业务包 throw 类型化错误,agent-cli-sdk 统一渲染成错误输出到 stderr。本文档定义 9 个 Category、构造器签名、hint 规范、何时 throw。

---

## 设计原则

1. **业务包只 throw 类型化错误**,不 throw 裸 `Error`。agent-cli-sdk 捕获后渲染成统一输出格式(见 `03-envelopes.md`)。**裸 `throw new Error(...)` 会被兜底成 `internal/unknown`(exit 5)**,agent 会误解成 agent-cli-sdk bug——所以永远用 `errs.*`。
2. **exit code 由 Category 决定**,业务包不用自己设 exit code。
3. **hint 字段是给 agent 的可执行指令**,不是给人看的解释。
4. **错误 wrap 不可降级**:下层已返回类型化错误时,透传不 re-wrap。
5. **throw 后进 observeError/handleError 链**(见下文),链结束才渲染到 stderr。

借鉴 lark-cli 的 RFC 7807 对齐错误分类(详见 `00-overview.md`)。

---

## 9 个 Category

| Category         | 何时用                                 | Exit Code | 类型化构造器                              |
| ---------------- | -------------------------------------- | :-------: | ----------------------------------------- |
| `validation`     | 用户输入的参数/flag 不合法             |     2     | `errs.ValidationError`                    |
| `authentication` | 没有有效 token / 需要登录              |     3     | `errs.AuthenticationError`                |
| `authorization`  | token 有效但缺 scope / 权限不足        |     3     | `errs.PermissionError`                    |
| `config`         | 本地配置缺失 / 未绑定                  |     3     | `errs.ConfigError`                        |
| `network`        | DNS / 连接拒绝 / 超时 / 传输层         |     4     | `errs.NetworkError`                       |
| `api`            | 服务端业务错误(HTTP 非 2xx,无特定分类) |     1     | `errs.APIError` / `errs.NotFoundError` / `errs.ConflictError` 等 |
| `policy`         | 风控 / 内容安全 / 安全挑战             |     6     | `errs.PolicyError`                        |
| `internal`       | SDK 契约违反 / 解码失败 / 不该发生     |     5     | `errs.InternalError`                      |
| `confirmation`   | 高风险写入需要 `--yes` 确认            |    10     | `errs.ConfirmationRequiredError`          |

> **`authentication` vs `authorization`**:前者是"没登录"(没 token),后者是"登录了但没权限"(token 有效但缺 scope)。这是 gRPC/Google APIs 的标准区分(`Unauthenticated` vs `PermissionDenied`)。

---

## 构造器签名

所有错误类型都继承自 `errs.CliError`(嵌入 `Problem`),位于 `@renxqoo/agent-cli-sdk/errs`。

### 通用 Problem 结构

```ts
interface Problem {
  category: Category; // 9 类之一
  subtype: string; // 稳定标识符(见下文 subtype 表)
  code?: number; // 上游数字码(HTTP status / API code)
  message: string; // 给人看,不保证稳定
  hint?: string; // 给 agent 的可执行指令
  retryable?: boolean; // 是否可重试
  cause?: unknown; // 保留底层错误(errors.Is/Unwrap 可用)
}
```

### 各构造器用法

```ts
import { errs } from "@renxqoo/agent-cli-sdk";

// ① 参数错误(用户输入不对)
throw new errs.ValidationError({
  subtype: "invalid_argument",
  param: "--limit", // 出错的参数名
  message: "--limit 必须为正数",
  hint: "使用 --limit 30 指定返回数量",
});

// ② 需要登录(token 不存在或失效)
throw new errs.AuthenticationError({
  subtype: "no_token",
  message: "未登录",
  hint: "run `rxcli auth login` 登录",
});

// ③ 权限不足(token 有效但缺 scope)
throw new errs.PermissionError({
  subtype: "missing_scope",
  message: "缺少 orders:read 权限",
  hint: "run `rxcli auth login --scope orders:read` 重新登录获取权限",
  missingScopes: ["orders:read"], // 扩展字段(机器可读)
});

// ④ 配置错误(本地配置缺失)
throw new errs.ConfigError({
  subtype: "missing_config",
  param: "baseUrl",
  message: "未配置后端地址",
  hint: "run `rxcli config set baseUrl https://...`",
});

// ⑤ 网络错误(DNS/超时/拒绝)
throw new errs.NetworkError({
  subtype: "timeout",
  message: "请求超时",
  retryable: true, // ← 可重试
  cause: originalError, // 保留底层
});

// ⑥ API 错误(服务端业务错误)
throw new errs.APIError({
  subtype: "server_error",
  code: 500,
  message: "服务端内部错误",
  retryable: true,
});

// ⑥' 资源不存在(API 错误的特例,常用)
throw new errs.NotFoundError("订单 o_1001 不存在");
// 等价于 new errs.APIError({ subtype: 'not_found', code: 404, message })

// ⑥'' 资源冲突(并发下资源已被占用,HTTP 409 同义,默认可重试)
throw new errs.ConflictError("skill sync already in progress");
// 等价于 new errs.APIError({ subtype: 'conflict', code: 409, message, retryable: true })

// ⑦ 策略拦截(风控/内容安全)
throw new errs.PolicyError({
  subtype: "content_blocked",
  message: "内容触发安全策略",
  hint: "修改内容后重试,或联系管理员",
});

// ⑧ 内部错误(SDK 不该出现的情况)
throw new errs.InternalError({
  subtype: "decode_failure",
  message: "响应解析失败",
  cause: parseError,
});

// ⑨ 需要确认(高风险写入)
throw new errs.ConfirmationRequiredError({
  subtype: "high_risk_write",
  message: "批量删除需要确认",
  hint: "加 --yes 跳过确认",
});
```

---

## param 字段规范(参数名的写法)

`ValidationError` 的 `param` / `params` 字段指明出错的参数。**规则:param 值 = 用户在命令行实际输入的形态:**

| 参数种类  | param 写法          | 例子                      |
| --------- | ------------------- | ------------------------- |
| flag 参数 | 带 `--` 前缀        | `'--limit'`、`'--status'` |
| 位置参数  | 用原名,**不带**前缀 | `'id'`、`'orderId'`       |

```ts
// flag 参数错误:param 带 --
throw new errs.ValidationError({
  subtype: "invalid_argument",
  param: "--limit",
  message: "--limit 必须为正数",
});

// 位置参数错误:param 用原名,不带 --
throw new errs.ValidationError({
  subtype: "missing_required",
  param: "id",
  message: "缺少订单 ID",
});
```

这样 agent / 人看到 `param` 就知道是命令行里的哪个 token,可直接对应到该改什么。多个参数出错用 `params` 数组。

---

## subtype 标识符规范

`subtype` 是 **wire-stable** 的稳定标识符,agent 靠它分支。规范:

- **小写 + 下划线**:`missing_scope`、`invalid_argument`、`not_found`
- **语义化,不绑实现**:`timeout`(不说 `fetch_timeout`,实现可能换)
- **已声明的 subtype 在 CI 里校验**(未声明的会 fail,避免拼写错误悄悄上线)

### 常用 subtype 参考(非穷举)

| Category       | 常用 subtype                                                              |
| -------------- | ------------------------------------------------------------------------- |
| validation     | `invalid_argument`, `missing_required`, `out_of_range`                    |
| authentication | `no_token`, `token_expired`, `token_revoked`                              |
| authorization  | `missing_scope`, `app_permission_denied`, `forbidden`                     |
| config         | `missing_config`, `invalid_config`, `unbound_env`, `skill_sync_failed`    |
| network        | `timeout`, `connection_refused`, `dns_failure`, `ssl_error`               |
| api            | `not_found`, `already_exists`, `conflict`, `rate_limited`, `server_error` |
| policy         | `content_blocked`, `challenge_required`, `access_denied`                  |
| internal       | `decode_failure`, `unknown`, `contract_violation`                         |
| confirmation   | `high_risk_write`                                                         |

业务包可定义自己的 subtype,但必须在业务包的 subtype 声明文件里登记(后续 agent-cli-sdk 提供 lint 校验)。

---

## hint 字段规范(给 agent 的指令)

`hint` 不是给人看的解释,是**给 agent 的可执行恢复指令**。规范:

✅ **好的 hint**(agent 能直接执行):

```
"run `rxcli auth login` 登录"
"run `rxcli auth login --scope orders:read` 重新获取权限"
"使用 --limit 30 指定返回数量(1-100)"
"加 --yes 跳过批量操作确认"
```

❌ **坏的 hint**(agent 不知道干啥):

```
"请检查你的配置"           ← 检查什么?怎么检查?
"出错了,稍后重试"          ← 重试什么?什么时候?
"权限不足"                  ← 怎么获取权限?
```

**判断标准:agent 读到 hint 后,能否立即知道下一步执行什么命令或操作。** 能,就是好 hint;不能,重写。

---

## 何时 throw、何时用 status 判断

业务命令 `run` 里调 `ctx.get`/`ctx.post` 等(返回 `TransportResponse`,含 `status`)。两种处理模式:

> **关于 401 自动续期**:业务包通常不处理 401——agent-cli-sdk 请求层内部检测到 401 会自动触发 token refresh(singleflight 复用),refresh 的执行能力由 oauthProvider 提供(见 `05-credentials.md`)。两者协作:请求层管"检测 + 单次复用",provider 管"怎么换 token"。业务包无感,只管 `ctx.get`。下面两种模式针对的是**非鉴权类**的业务 status(404/403/5xx 等)。

### 模式 A:命令自己判断 status,throw 类型化错误

```ts
async run(ctx, { id }) {
  const res = await ctx.get(`/orders/${id}`)
  if (res.status === 404) throw new errs.NotFoundError(`订单 ${id} 不存在`)
  if (res.status === 403) throw new errs.PermissionError({ subtype: 'forbidden', message: '无权访问该订单' })
  if (res.status >= 500) throw new errs.APIError({ subtype: 'server_error', code: res.status, message: '服务端错误', retryable: true })
  return { data: res.data }
}
```

**适用:业务包想给特定 status 赋予业务语义**(如 404 = "订单不存在")。

### 模式 B:开启自动 throw(agent-cli-sdk 按规则转换 status)

```ts
// 在 defineCli 里配置:哪些 status 自动 throw
export default defineCli({
  // ...
  errorOnStatus: {
    // 可选:status → subtype 映射
    404: "not_found",
    403: "forbidden",
    "5xx": "server_error",
  },
});
```

`errorOnStatus` 的**值是 subtype 字符串**(不是构造器名)。**subtype 隐含 category**(见上面的"常用 subtype 参考"表,每个 subtype 归属固定 category),agent-cli-sdk 据此自动选对应的类型化构造器 + exit code,业务包不用手写 if。上面示例对应的内置映射:

| status | subtype        | → category    | → 构造器                           | → exit |
| ------ | -------------- | ------------- | ---------------------------------- | :----: |
| `404`  | `not_found`    | api           | `APIError`(NotFoundError 是其别名) |   1    |
| `403`  | `forbidden`    | authorization | `PermissionError`                  |   3    |
| `5xx`  | `server_error` | api           | `APIError`                         |   1    |

> 若配置了一个未在 subtype 注册表登记的 subtype,agent-cli-sdk 在启动时校验失败(CI 里也会 fail,避免拼写错误悄悄上线)。

开启后,client.request 对匹配的 status 自动 throw 对应类型化错误,业务包不用手写 if。**默认不开启**(决策:业务错误透传 status,不自动 throw——但允许业务包 opt-in)。

---

## 错误透传与 wrap 规则

### 下层已返回类型化错误 → 透传

```ts
async run(ctx, args) {
  try {
    const res = await ctx.get('/orders')
    return { data: res.data }
  } catch (err) {
    // ✅ 下层(client)已抛类型化错误(如 NetworkError),透传
    if (err instanceof errs.CliError) throw err
    // ❌ 不要 re-wrap:throw new errs.APIError({ cause: err }) —— 这会降级分类
    // 只有"非类型化错误"才需要包装
    throw new errs.InternalError({ subtype: 'unknown', message: '意外错误', cause: err })
  }
}
```

**re-wrap 已类型化的错误会丢失原始 category/subtype,等于降级。** 用 `instanceof errs.CliError` 判断,是就透传。

### 保留 cause

wrap 时用 `cause` 字段保留底层错误,让 `errors.is` / `errors.Unwrap` 仍能工作:

```ts
throw new errs.NetworkError({
  subtype: "timeout",
  message: "请求超时",
  cause: originalFetchError, // ← 保留
});
```

---

## retryable 字段

`retryable: true` 告诉 agent "这个错误重试可能成功"。典型场景:

- 网络超时、429 限流、5xx 服务端临时错误 → `retryable: true`
- 参数错误、未登录、权限不足、404 → `retryable: false`(省略字段)

agent 看到 `retryable: true` 可以自动重试(带退避)。

---

## observeError / handleError:观察与显式恢复

错误先被规范化为 `CliError`，再依次经过两个不同职责的边界：`observeError` 只做上报或审计，返回 `void` 永远不会吞掉错误；`handleError` 必须返回显式决策 `pass`、`replace` 或 `recover`。hook 自己抛错时框架记录 warning 并保留最近一次有效业务错误。

错误插件可用来:

- 把后端特有的错误码归一化成标准 subtype
- 脱敏错误消息里的敏感信息(如 token 泄露到 message)
- 给特定错误加 hint
- 特定错误重试(如 502/503)

```ts
// 错误归一化插件
const errorNormalizePlugin = {
  name: 'error-normalize',
  async observeError(ctx, err) {
    await telemetry.capture(err)
  },
  async handleError(ctx, err) {
    // 脱敏:message 里可能有 token
    if (err instanceof errs.CliError && err.message) {
      err.message = err.message.replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    }
    // 给网络错误加 hint
    if (err instanceof errs.NetworkError && !err.hint) {
      err.hint = '检查网络连接,或稍后重试'
    }
    return { action: 'replace', error: err }
  },
}

defineCli({ plugins: [auth, errorNormalizePlugin], ... })
```

`replace` 的新错误会传给后续 handler；`recover` 是唯一成功出口，并可携带一个正式 `CommandResult`。`undefined` 只会被当作 `pass` 并记录契约 warning。

---

## BareError:绕过错误输出的唯一例外

`errs.BareError` **不属于** 9 个 Category,是特殊类型,用于"谓词命令"场景(见 `03-envelopes.md` 的"BareError 例外"):

```ts
// 谓词命令:stdout 已有完整答案(如 auth check 的 yes/no JSON),只想要对应的 exit code
if (!loggedIn) throw new errs.BareError(3); // exit 3,stderr 不渲染错误输出
```

- **只设 exit code,不渲染 stderr 错误输出**——因为 stdout 已经携带了答案
- 是错误侧输出契约的**唯一**例外(成功侧例外是 `skills read`,见 `03-envelopes.md`)
- **普通业务命令禁用**:正常失败必须 throw 9 类类型化错误,让 agent-cli-sdk 渲染统一输出

---

## exit code 映射表

agent-cli-sdk 根据 Category 自动设 exit code,业务包不用管:

| Category                                      | Exit Code |
| --------------------------------------------- | :-------: |
| (成功)                                        |     0     |
| `api`                                         |     1     |
| `validation`                                  |     2     |
| `authentication` / `authorization` / `config` |     3     |
| `network`                                     |     4     |
| `internal`                                    |     5     |
| `policy`                                      |     6     |
| `confirmation`                                |    10     |

> 注意:1(api)和 5(internal)在 lark-cli 里是分开的——api 是"服务端业务错误",internal 是"SDK 契约违反",后者更严重。我们沿用这个区分。

---

## 常见错误场景对照

| 场景                           | 该 throw 什么                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| 用户传了 `--limit abc`(非数字) | `ValidationError` subtype `invalid_argument` param `--limit`                              |
| 用户没登录就调业务命令         | client 内部抛 `AuthenticationError`(业务包不用管)                                         |
| 登录了但没 orders:read scope   | client 或命令抛 `PermissionError` subtype `missing_scope` missingScopes `['orders:read']` |
| 调 `/orders/x` 返回 404        | `NotFoundError`                                                                           |
| 网络断开                       | client 抛 `NetworkError` subtype `connection_refused` retryable                           |
| 后端返回 500                   | `APIError` subtype `server_error` retryable                                               |
| 后端返回 429                   | `APIError` subtype `rate_limited` retryable + `Retry-After` hint                          |
| 批量删除没加 --yes             | `ConfirmationRequiredError` hint "加 --yes"                                               |
| 响应 JSON 解析失败             | `InternalError` subtype `decode_failure`                                                  |
