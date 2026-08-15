# 01 · 命令使用手册

> 给**终端用户和 AI agent** 看。讲清楚怎么调用命令、管道怎么组合、分页怎么处理、错误怎么读。本文档是 agent 使用 CLI 时的主要参考。

---

## 安装

业务包是独立 npm 包,按需安装:

```bash
# 装一个业务包(它会自动带上对 agent-cli-sdk 的依赖)
npm i -g @org/rxcli-orders

# 装多个
npm i -g @org/rxcli-orders @org/rxcli-invoices
```

装完后有两种调用方式(同一套代码,详见 `02-sdk-guide.md`):

```bash
rxcli-orders list              # 独立 bin(管道里更短,推荐)
rxcli orders list              # 装进 rxcli 主包后(需额外装 @renxqoo/cli)
```

---

## 单命令用法(从简单到复杂)

### Level 1 — 最简单的查询

默认输出是 **JSON 统一输出**,给 agent 读:

```bash
$ rxcli-orders list
{"ok":true,"data":[{"id":"o_1001","total":199,"status":"paid"},...],"meta":{"count":2}}
```

成功永远是 `{ok:true, data:..., meta:...}` 结构,详见 `03-envelopes.md`。

### Level 2 — 服务端查询参数透传

业务命令声明的参数(如 `--limit`、`--status`)直接透传给后端:

```bash
rxcli-orders list --limit 5 --offset 10      # 分页(透传后端的分页参数)
rxcli-orders list --status unpaid            # 业务参数(由命令自己声明)
rxcli-orders get o_1001                      # 详情
```

> ⚠️ `--limit/--offset` 是服务端分页参数,不是本地截断。它们影响后端查多少数据。

### Level 3 — 输出给人看 vs 给 agent 看

默认给 agent(JSON)。人自己看,用 `--no-json` 切表格:

```bash
$ rxcli-orders list --no-json
ID       总额    状态
o_1001   ¥199   已支付
o_1002   ¥89    已发货
```

**`--json` 是默认行为**(`--no-json` 关掉)。判断逻辑:`stdout` 是 TTY 时人看,默认表格;被管道/重定向时(agent 场景),默认 JSON。可被 `--json`/`--no-json` 显式覆盖。

---

## 本地过滤、选字段、排序 —— 全交给 jq

agent-cli-sdk **不提供** `--filter` / `--fields` / `--sort` 这类本地过滤 flag。原因是 `jq` / `sort` / `uniq` 已经做得很好,agent 不用学新语法。

```bash
# 过滤行:jq select
rxcli-orders list | jq '.data[] | select(.status=="paid")'

# 选字段
rxcli-orders list | jq '.data[] | {id, total}'

# 只要某个字段的值
rxcli-orders list | jq -r '.data[].total'

# 过滤 + 提取 + 排序 + 去重(完整 unix 工具链)
rxcli-orders list \
  | jq -r '.data[] | select(.status=="paid") | .total' \
  | sort -n \
  | uniq
```

**原则:左边 `rxcli` 只管出数据(透传后端 + 统一输出格式),右边的过滤/提取/排序全是 unix 工具。** 这是 unix 管道哲学,也是 agent 最熟悉的组合方式。

> 什么 flag agent-cli-sdk 做、什么交给 jq?判断标准见 `00-overview.md` 的决策清单 #12、#13。
>
> - **服务端参数**(影响后端查询):`--limit`/`--offset`/`--status` 等 → agent-cli-sdk 做,因为本地触达不到后端
> - **本地数据操作**(改 stdout 内容):过滤/选字段/排序 → 交给 jq
> - **输出格式**(统一输出序列化):JSON/table → agent-cli-sdk 做,因为它和输出契约绑定

---

## 管道用法

### 基本管道(2 级)

下游命令**自动检测**是否在管道里(通过判断 stdin 是否 TTY):被管道调用时从 stdin 读上游记录,否则走参数模式。无需声明任何 flag:

```bash
# 列出未支付订单 → invoices generate 自动检测到 stdin 有数据,逐条消费
rxcli-orders list --status unpaid | rxcli-invoices generate
```

### 管道传引用+ID(关键机制)

**管道里传的是"脱敏后的引用 + 稳定 ID",不是完整真实数据。** 这是 agent 流里"上下文卫生"与"管道可组合"的平衡点:

```bash
$ rxcli-orders list --status unpaid | rxcli-invoices generate
# 上游 stdout(agent 可见):每条记录的 ID + 脱敏字段
# {"ok":true,"data":{"id":"o_1001","customer":"[M:c1a2]","total":199},...}
#                                            ^^^^^^^^^^^ 脱敏,但 id 可用
# 下游用 id 关联,不需要客户真名
```

下游命令代码(开发者写):

```ts
async run(ctx, args) {
  for await (const rec of ctx.pipe.in()) {       // 异步迭代上游记录
    await ctx.post('/invoices', { orderId: rec.id })
  }
}
```

### 多级管道(链式)

```bash
# 一个业务流:大客户未付订单 → 查客户 → 通知
rxcli-orders list --status unpaid \
  | jq '.data[] | select(.total > 1000)' \
  | rxcli-customers get \
  | rxcli-notifications send --template overdue
```

中间任何一级都可以插 `jq` 做本地处理。**跨业务包也能组合**(orders → customers → notifications),只要它们都遵守输出契约。

### 管道的纪律(为什么不会断)

管道能可靠组合的根是 **stdout 纯净**:

| 流         | 内容                                                             | 谁写                            |
| ---------- | ---------------------------------------------------------------- | ------------------------------- |
| **stdout** | **只有**统一输出 JSON(成功 `{ok,data,meta}`,空数组也是合法 JSON) | agent-cli-sdk 从 `run` 返回值序列化   |
| **stderr** | 日志、进度、提示、警告、错误输出                                 | agent-cli-sdk 的 `ctx.log` + 错误渲染 |

**铁律:业务命令永远不能直接往 stdout 写非统一输出格式内容。** 一切非数据输出走 `ctx.log`(stderr)。否则 `rxcli-orders list | jq` 混进一行"加载中..."整个管道就废了。

详见 `03-envelopes.md` 的"stdout/stderr 分配规则"。

---

## 分页:agent 自决续拉

后端数据可能很多,agent-cli-sdk 默认只取一页,但在统一输出格式 `meta` 里告诉你**完整性**和**续拉游标**:

```bash
$ rxcli-orders list --limit 30
{
  "ok": true,
  "data": [ /* 30 条 */ ],
  "meta": {
    "count": 30,
    "pagination": {
      "complete": false,        # ← false 表示还没拉完
      "pages": 1,               # 已拉页数
      "items": 30,              # 已拉记录数
      "next_token": "abc123"    # ← 续拉游标
    }
  }
}
```

**agent 看到 `complete:false` 就知道还有数据**,可以续拉:

```bash
# 续拉下一页(具体 flag 名由业务命令定义,通常是 --page-token 或 --cursor)
rxcli-orders list --limit 30 --page-token abc123
```

**为什么不是自动全拉?** 因为有些查询不该自动拉 1 万条(慢、占上下文)。agent-cli-sdk 给 agent 足够信息(`complete` + `next_token`),让 agent 按场景决定续不续。比"强制流式全拉"更现实。

> 业务命令如何实现分页协议(告诉 agent-cli-sdk 怎么翻页)?见 `02-sdk-guide.md` 的"分页实现"。

---

## skill 自服务发现

agent 不知道有哪些命令?直接问 CLI:

```bash
# 列出所有 skill(每个业务包自带),返回标准成功输出
$ rxcli skills list
{
  "ok": true,
  "data": [
    { "name": "orders", "description": "查询订单列表/详情", "version": "1.0.0" },
    { "name": "invoices", "description": "发票管理", "version": "1.0.0" }
  ],
  "meta": { "count": 2 }
}

# 读某个 skill 的内容(教 agent 何时用、怎么用)
$ rxcli skills read orders
# 直接吐 SKILL.md 原文到 stdout 给 agent 读
```

> **`skills read` 是输出契约的明示例外。** 其它所有成功输出都是 `{ok,data,meta}` 统一输出格式,唯独 `skills read` 直接吐 Markdown 原文到 stdout——因为消费方是 agent,直读/管道拼接(类似 `cat`)更自然,无需反序列化。类比错误输出侧的 `BareError` 例外(见 `03-envelopes.md`)。**普通业务命令不得效仿**,仍必须 return 统一输出格式。

skill 是给 agent 读的 Markdown 指令文档。其中"命令表"部分由 `defineCommands` 自动生成,"何时用/错误处理"由业务专家手写。详见 `06-skills.md`。

---

## exit code 表

agent 靠 exit code 判断命令成败,不用解析 JSON:

| Code | 含义                                             | agent 该怎么办                      |
| ---- | ------------------------------------------------ | ----------------------------------- |
| 0    | 成功                                             | 读 stdout 拿数据                    |
| 1    | 服务端通用错误(API 返回非 2xx)                   | 读 stderr 的 error.message,可能重试 |
| 2    | 参数错误(用户输入不对)                           | 修正 flag,重试                      |
| 3    | 认证/授权/配置错误(没登录 / 没 scope / 配置缺失) | 引导用户登录或补配置,见 error.hint  |
| 4    | 网络错误(DNS/超时/拒绝)                          | 稍后重试                            |
| 5    | SDK 内部错误(不该发生)                           | 报 bug                              |
| 6    | 策略拦截(风控/内容安全)                          | 读 error.hint                       |
| 10   | 需要确认(高风险写入要 --yes)                     | 加 --yes 或让用户确认               |

**关键:错误输出在 stderr,不在 stdout。** 所以 `cmd | jq` 即使命令失败,jq 也不会收到错误 JSON(避免 agent 误把错误当数据处理)。详见 `03-envelopes.md` 和 `04-errors.md`。

---

## 错误怎么读

命令失败时,stderr 输出结构化错误输出,exit code 非 0:

```bash
$ rxcli-orders get o_notexist
# stderr(不是 stdout):
{
  "ok": false,
  "error": {
    "type": "api",                    # ← wire-stable,agent 可分支
    "subtype": "not_found",           # ← wire-stable,agent 可分支
    "code": 404,                      # ← 上游 HTTP code
    "message": "订单 o_notexist 不存在",  # ← 给人看,不保证稳定
    "hint": "用 rxcli-orders list 查看有效订单 ID"  # ← 给 agent 的可执行恢复指令
  }
}
# exit code: 1
```

**agent 的处理流程:**

1. 看 exit code(快速分类)
2. 必要时读 stderr 的 `error.type` / `error.subtype` 做精确分支
3. 读 `error.hint` 获取下一步动作(往往是直接可执行的命令)

`hint` 字段是 agent 友好的关键 —— 它不是给人看的解释,而是**给 agent 的可执行指令**(如"运行 xxx 重新登录")。详见 `04-errors.md`。

---

## 常见组合速查

```bash
# 查 + 过滤 + 统计
rxcli-orders list | jq '[.data[] | select(.status=="paid")] | length'

# 查 + 跨包关联
rxcli-orders get o_1001 | jq '.data.customerId' | xargs rxcli-customers get

# 批量操作(管道 + 下游命令)
rxcli-orders list --status new | rxcli-orders tag --tag vip

# 续拉全量(分页拼接)
for token in "" "abc" "def"; do
  rxcli-orders list --page-token "$token" | jq '.data[]'
done

# 调试:看完整请求响应
rxcli-orders list --verbose 2>&1 | head
```

---

## 给 agent 的使用建议

1. **永远先 `rxcli skills list`** 了解有哪些能力,再 `rxcli skills read <name>` 学用法。
2. **拿数据看 stdout 的 `data` 字段**;判断完整性看 `meta.pagination.complete`。
3. **判断成败看 exit code**;失败细节看 stderr 的 `error.type` + `error.hint`。
4. **本地过滤用 jq**,不要试图让命令支持 `--filter`。
5. **管道组合用 ID 关联**,不要依赖具体字段值(可能脱敏)。
6. **写入操作前先 dry-run**(如果命令支持 `--dry-run`),看请求体再确认。
