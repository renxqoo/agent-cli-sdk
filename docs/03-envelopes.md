# 03 · 输出契约

> 统一输出格式是 agent-cli-sdk 最核心的数据结构。所有 stdout 输出必须是成功输出,所有 stderr 错误必须是错误输出。本文档定义它们的精确字段、稳定性保证、stdout/stderr 分配规则。**agent 和实现者都必须遵守这个契约。**

---

## 为什么要有统一输出格式

没有统一输出格式的世界:每个命令随便吐 JSON,字段不统一,agent 没法稳定解析。有了统一输出格式:

- **agent 靠 `ok` 字段判断成败**,不用猜
- **wire-stable 字段**(`type`/`subtype`)让 agent 能写稳定的分支逻辑
- **分页/通知等元信息**有固定位置(`meta`),不污染业务数据(`data`)
- **stdout/stderr 分离**:成功走 stdout(管道可消费),错误走 stderr(不会污染管道)

设计借鉴 lark-cli 的 RFC 7807 对齐错误输出 + 成功输出模式。详见 `00-overview.md`。

---

## 命名约定:wire snake_case,代码 camelCase

**统一输出格式是 wire 格式(JSON on the wire),字段名一律 snake_case**:如 `next_token`、`missing_scopes`、`dry_run`。这符合 JSON/wire 惯例(lark-cli、多数 REST API 都如此),agent 和 shell 工具(jq)按 snake_case 取值。

**TS 代码用 camelCase**:`meta.pagination.nextToken`、`err.missingScopes`。agent-cli-sdk 在把命令 `run` 的返回值(`CommandResult`)序列化成统一输出格式时,**自动把 camelCase 转成 snake_case** 写入 wire,业务包写代码用 camelCase,不用手动转换。

> 即:本文档所有 JSON 示例里的字段名是 wire 形态(snake_case);`02-sdk-guide.md` 里 TS 代码的字段名是代码形态(camelCase)。两者一一对应,agent-cli-sdk 负责转换。`ok` / `data` / `meta` 等单词本身无连字符,两种形态一致。

---

## 成功输出(stdout)

命令成功时,`run` 返回 `{ data, meta }`(见 `02-sdk-guide.md`),框架把它包装成统一输出格式输出到 **stdout**:

```json
{
  "ok": true,
  "identity": "user",
  "source": "orders",
  "data": { ... },
  "meta": {
    "count": 30,
    "pagination": { "complete": false, "pages": 1, "items": 30, "next_token": "abc" }
  },
  "dry_run": false
}
```

### 字段说明

| 字段       | 是否必有 | 稳定性          | 说明                                                                   |
| ---------- | :------: | --------------- | ---------------------------------------------------------------------- |
| `ok`       | ✅ 必有  | **wire-stable** | 成功永远是 `true`。agent 靠它判断                                      |
| `identity` | ❌ 可选  | wire-stable     | 调用者身份:`user` / `bot`。未解析出身份时省略                          |
| `source`   | ✅ 必有  | wire-stable     | 来源业务 namespace；`defineCli` 执行时自动写入，供 pipe 稳定分流       |
| `data`     | ✅ 必有  | informational   | 业务数据。命令无数据输出时为 `null`                                    |
| `meta`     | ❌ 可选  | mixed           | 元信息,见下文                                                          |
| `dry_run`  | ❌ 可选  | wire-stable     | `true` 表示 dry-run 模式(只构造请求未发送)。出现时为 true,正常请求省略 |

### meta 字段

`meta` 携带"关于这次响应的元信息",不放业务数据:

| 子字段       | 类型   | 说明                                       |
| ------------ | ------ | ------------------------------------------ |
| `count`      | number | 本次返回的记录数(`data` 是数组时)          |
| `pagination` | object | 分页信息,见下文                            |
| `rollback`   | string | 可选:写入操作的回滚提示(如"可用 xxx 撤销") |

> **为什么分页放 meta 不放 data?** 因为"是否拉完"不是业务资源的一部分,而是 CLI 合成的状态。写进 data 既污染 payload,又强迫调用者区分"API 字段"和"CLI 字段"。

### pagination 子结构(关键)

```json
"pagination": {
  "complete": false,
  "pages": 1,
  "items": 30,
  "next_token": "abc123"
}
```

| 字段         | 是否必有 | 说明                                                                   |
| ------------ | :------: | ---------------------------------------------------------------------- |
| `complete`   |    ✅    | **true 表示后端数据已拉完**;false 表示还有更多。agent 靠它判断是否续拉 |
| `pages`      |    ❌    | 本次响应包含的 API 页数(通常 1)                                        |
| `items`      |    ❌    | 本次响应包含的记录数(经过命令层过滤后)                                 |
| `next_token` |    ❌    | 续拉游标。`complete:false` 时通常有;`complete:true` 时省略             |

**业务命令必须如实填 `complete` 和 `next_token`**(决策清单 #9)。详见 `02-sdk-guide.md` 的"分页实现"。

---

## 错误输出(stderr)

命令失败时,输出到 **stderr**(注意:不是 stdout!):

```json
{
  "ok": false,
  "identity": "user",
  "error": {
    "type": "authorization",
    "subtype": "missing_scope",
    "code": 99991679,
    "message": "missing scope `orders:read`",
    "hint": "run `rxcli auth login --scope orders:read` 重新登录获取权限",
    "retryable": false,
    "param": null,
    "missing_scopes": ["orders:read"]
  }
}
```

### 错误怎么产生:throw → observeError/handleError 链 → 渲染

命令或插件 `throw` 类型化错误(`errs.*`)后,错误先进 **observeError/handleError 链**(每个插件跑一遍,可归一化/脱敏),链结束后渲染成错误输出到 stderr:

```
run / 钩子 throw err
  ↓
err 是 errs.* 类型? → 是:直接进 observeError/handleError 链
  ↓ 否(裸 Error 等):agent-cli-sdk 包装成 InternalError(unknown)进 observeError/handleError 链
observeError/handleError 链(pre→normal→post 插件,每个都跑;不处理返回原 err,处理返回新 err)
  ↓
最终 err → 按 Category 渲染错误输出 → stderr + 对应 exit code
```

**关键:throw 必须用 `errs.*` 类型化错误。** 裸 `throw new Error('...')` 会被兜底成 `internal/unknown`(exit 5),agent 会误解成 agent-cli-sdk bug。详见 `04-errors.md`。

### 顶层字段(与成功输出一致)

| 字段       | 是否必有 | 稳定性          | 说明                                                  |
| ---------- | :------: | --------------- | ----------------------------------------------------- |
| `ok`       |    ✅    | **wire-stable** | 错误永远是 `false`                                    |
| `identity` |    ❌    | wire-stable     | 调用者身份(`user`/`bot`),未解析出时省略。与成功输出同 |
| `error`    |    ✅    | mixed           | 错误详情对象,见下表                                   |

### error 子字段说明

| 字段            | 是否必有 | 稳定性             | 说明                                                                                      |
| --------------- | :------: | ------------------ | ----------------------------------------------------------------------------------------- |
| `type`          |    ✅    | **wire-stable**    | 9 个 Category 之一(见 `04-errors.md`),agent 可分支                                        |
| `subtype`       |    ✅    | **wire-stable**    | 稳定的小写下划线标识符,agent 可分支                                                       |
| `code`          |    ❌    | wire-stable        | 上游数字码(如 HTTP status、API code)。零时省略                                            |
| `message`       |    ✅    | **informational**  | 给人看的描述,**不保证稳定**,agent 不要靠它分支                                            |
| `hint`          |    ❌    | informational      | **给 agent 的可执行恢复指令**(详见 `04-errors.md`)                                        |
| `retryable`     |    ❌    | wire-stable        | 出现且为 true 时表示可重试;false 时省略                                                   |
| `param`         |    ❌    | per-subtype-stable | 出错的参数名(`ValidationError` 用),如 `"--limit"`                                         |
| `params`        |    ❌    | per-subtype-stable | 多参数校验详情数组(`ValidationError` 用)                                                  |
| 按 subtype 扩展 |    ❌    | per-subtype-stable | 如 `missing_scopes`(数组,机器可读)、`console_url`;只在对应 subtype 出现,该 subtype 内稳定 |

### wire-stable vs informational(关键区分)

| 类型                   | 含义                   | agent 能不能靠它分支  |
| ---------------------- | ---------------------- | :-------------------: |
| **wire-stable**        | 跨版本不变的契约字段   |        ✅ 可以        |
| **informational**      | 给人看/提示性的,可能变 |      ❌ 不要分支      |
| **per-subtype-stable** | 在同一 subtype 内稳定  | ✅ 可以(限定 subtype) |

**铁律:agent 的分支逻辑只能基于 wire-stable 字段(`ok`、`error.type`、`error.subtype`、`error.code`、`retryable`)。** `message` 只用来展示给人,可能随版本改写。

---

## stdout / stderr 分配规则

这是管道能组合的根,**铁律不可违反**:

| 内容                       | 流         | 谁写                      |
| -------------------------- | ---------- | ------------------------- |
| 成功输出(`{ok:true,...}`)  | **stdout** | 框架从 `run` 返回值序列化 |
| 错误输出(`{ok:false,...}`) | **stderr** | agent-cli-sdk 错误渲染层        |
| 日志(info/warn/error)      | **stderr** | `ctx.log.*()`             |
| 进度条 / spinner           | **stderr** | agent-cli-sdk 进度层            |
| 提示(空结果、引导)         | **stderr** | agent-cli-sdk 提示层            |
| 系统通知(例如版本更新)     | **stderr** | `createUpdateNotifier`    |

**业务命令永远不能直接往 stdout 写非统一输出格式内容。** 一切非数据输出走 `ctx.log`(stderr)。否则 `rxcli-orders list | jq` 混进一行"加载中..."整个管道就废了。

### 版本更新通知

版本提醒是运行环境信息，不是业务数据。业务包可显式注册 `createUpdateNotifier`：

```ts
import { createUpdateNotifier, defineCliApp } from "@renxqoo/agent-cli-sdk";

const app = await defineCliApp({
  dir: appStateDir,
  plugins: [
    createUpdateNotifier({
      packageName: "@scope/my-cli",
      currentVersion: "1.2.0",
      updateCommand: "npm install -g @scope/my-cli",
    }),
  ],
  // ...
});
```

检查采用缓存优先的双阶段模型：每次 app 运行(仅成功运行)读本地缓存；缓存过期时，由分离的后台 helper 查询 npm `latest`，供后续运行使用。默认 24 小时检查一次、同一更新最多 24 小时提醒一次；网络或缓存失败静默，不改变业务结果、exit code 或错误输出。可用 `NO_UPDATE_NOTIFIER=1` 关闭。

仅当业务命令成功后，提醒才写入 stderr：

```xml
<system-message type="update-available">
  <package>my-cli</package>
  <current-version>1.2.0</current-version>
  <latest-version>1.3.0</latest-version>
  <action>npm install -g my-cli</action>
  <scope>Operational notice only; it is not business output.</scope>
</system-message>
```

失败命令不会追加系统通知，因此 stderr 仍可作为单个错误 JSON 解析。更新命令只是建议：Agent 应先完成当前业务任务，再向用户报告；除非用户已明确授权，否则不得自动安装或升级。旧版 `_notice` 序列化入口仅为底层兼容能力，运行时版本通知不得写入 stdout。

> **明示例外:`skills read`。** 它直接吐 SKILL.md 原文到 stdout(非统一输出格式),供 agent 直读/管道拼接。这是输出契约**唯一**的成功侧例外(错误侧对应 `BareError`)。普通业务命令不得效仿,仍必须 return 统一输出格式。详见 `01-cli-usage.md` / `06-skills.md`。

### 为什么错误也走 stderr(而不是 stdout)

因为 `cmd | jq` 时,jq 只读 stdout。如果错误输出走 stdout:

- jq 会收到错误 JSON,把它当数据处理 → agent 误判
- 错误输出的结构和成功输出不一样,jq 表达式会崩

错误走 stderr + 非 0 exit code,agent 靠 exit code 判断失败,再读 stderr 拿细节。这样管道里错误不会污染数据流。

---

## BareError 例外(谓词命令)

少数"谓词命令"(如 `auth check` 检查是否登录)的 stdout 已经携带完整答案(yes/no JSON),只需要对应的 exit code,不需要 stderr 统一输出格式。这种用 `BareError`:

```ts
// 谓词命令:stdout 已有答案,只想要 exit code,不渲染 stderr 统一输出格式
if (!loggedIn) throw new errs.BareError(3); // exit 3,stderr 不输出统一格式
```

`BareError` 是**唯一**绕过输出契约的类型,只用于"stdout 已是完整答案"的谓词场景。普通命令不要用。

---

## 空结果怎么处理

查询返回 0 条记录时:

```json
// stdout —— 合法的空数组,不是错误
{ "ok": true, "data": [], "meta": { "count": 0, "pagination": { "complete": true } } }
```

**空结果 ≠ 错误。** exit code 0,stdout 是空数组统一输出格式。不要把空结果当错误抛(那样 agent 会误以为出问题了)。

可选:agent-cli-sdk 在 stderr 提示一行"(0 条记录)"给人类,但 stdout 保持纯净。

---

## 管道记录(PipeRecord):管道里传什么

命令作为管道上游时,`run` 返回值(经框架序列化)在 stdin 里被下游读到的每条记录是 **PipeRecord**:

```json
{
  "type": "orders",
  "id": "o_1001",
  "data": { "total": 199, "status": "paid" },
  "meta": { "source": "rxcli-orders list" }
}
```

| 字段   | 是否必有 | 说明                                                                                                                          |
| ------ | :------: | ----------------------------------------------------------------------------------------------------------------------------- |
| `type` |    ✅    | 来源业务包命名空间(如 `orders`),下游按它分流(`if rec.type !== 'orders' continue`)。框架序列化时自动填入的 `defineCli.name`    |
| `id`   |    ❌    | 稳定标识。**管道传引用+ID 的核心**(决策清单 #11):链中传脱敏值+ID,下游用 ID 关联,不依赖具体字段值。命令输出数组时每条建议带 id |
| `data` |    ❌    | payload(已过 `transformOutput` 转换)                                                                                          |
| `meta` |    ❌    | 可选元数据(来源命令、时间戳)                                                                                                  |

> **注意:PipeRecord 是下游 `ctx.pipe.in()` 读到的形态,不是 stdout 统一输出格式本身。** stdout 仍是一个完整统一输出格式 `{ok, data, meta}`;当 data 是数组时,agent-cli-sdk 把每条记录包成 PipeRecord 供下游逐条消费。单对象命令(data 不是数组)管道时,下游收到的是单条 `{type, id, data}`。

详见 `02-sdk-guide.md` 的"管道:作为下游命令"。

---

## 为什么用统一输出模型

传统 CLI 常见做法是同步 `console.log(JSON.stringify(body, null, 2))`,没有统一输出格式概念。本框架改成统一输出模型:

|              | 传统 console.log                   | 统一输出模型(`run` 返回值 → 框架序列化) |
| ------------ | ---------------------------------- | --------------------------------------- |
| 输出         | 裸 JSON body,美化打印              | 统一输出格式 `{ok, data, meta}`         |
| 错误         | exitCode=1 + console.error message | stderr 错误输出 + 类型化 exit code      |
| 分页         | 无                                 | `meta.pagination`                       |
| stdout 纯净  | ❌(美化打印有空格,管道易混)        | ✅(紧凑 JSON)                           |
| agent 可分支 | ❌(只有 message 字符串)            | ✅(wire-stable type/subtype)            |

---

## 输出契约的稳定性承诺

- `ok`、`error.type`、`error.subtype`、`error.code`、`error.retryable` 是 **wire-stable**,跨大版本不变。改名是 breaking change。
- `data` 和 `meta.pagination` 的形状由业务命令决定,agent-cli-sdk 只保证 `ok`/`data`/`meta` 这三个顶层 key 稳定。
- `message` / `hint` 文案可能改进,agent 不要基于具体文字分支。
- 新增顶层字段(如未来的 `_deprecation`)用下划线前缀,表示非业务字段,老 consumer 忽略它不会出错。

---

## agent 解析统一输出格式的标准流程

```python
# 伪代码:agent 处理 CLI 输出
result = run("rxcli-orders list")
if result.exit_code == 0:
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is True
    data = envelope["data"]            # 业务数据
    pagination = envelope.get("meta", {}).get("pagination", {})
    if not pagination.get("complete", True):
        # 还有更多数据,可续拉
        next_token = pagination.get("next_token")
else:
    error_envelope = json.loads(result.stderr)
    assert error_envelope["ok"] is False
    err = error_envelope["error"]
    # 靠 type/subtype 分支,不靠 message
    if err["type"] == "authentication":
        run(err["hint"])               # hint 是可执行指令
    elif err["type"] == "authorization" and err["subtype"] == "missing_scope":
        scopes = err["missing_scopes"]
        # 引导用户重新登录拿 scope
```
