# 06 · skill 系统与命令文档自动生成

> skill 是给 AI agent 读的 Markdown 指令文档,教 agent"何时用、怎么用"某个业务包的命令。本文档定义:skill reader(list/read/sync)、SKILL.md 结构、命令文档自动生成机制、签名生成规则。**核心:机械信息(命令签名/参数)自动生成,语义信息(何时用/错误处理)人工写,两者用标记块隔离。**

---

## 两种信息,分开产出

| 信息类型     | 例子                                                   | 谁产出                        |
| ------------ | ------------------------------------------------------ | ----------------------------- |
| **机械信息** | 命令签名、参数列表、类型、必填、默认值、scope          | `defineCommands` **自动生成** |
| **语义信息** | description(何时用/触发)、错误处理、references 详情、边界 | 人写                          |

**为什么要分开**:如果命令表手写,加一个参数要同步改两处(SKILL.md + 代码),必然漂移。机械信息从代码生成,保证永远同步;语义信息人写,因为只有业务专家知道"用户说'查订单'该映射到哪个命令"。

---

## skill reader:list / read / sync

agent-cli-sdk 提供 skill 内容读取器(沿用前版设计,对齐 lark-cli 的 `skillcontent/reader.go`,带路径穿越校验)。agent 用这些命令自服务发现能力:

### `skills list` — 列出所有 skill

```bash
$ rxcli skills list
{
  "ok": true,
  "data": [
    { "name": "orders", "description": "查询订单列表/详情", "version": "1.0.0" },
    { "name": "invoices", "description": "发票管理", "version": "1.0.0" }
  ],
  "meta": { "count": 2 }
}
```

扫描所有已装业务包自带的 `skills/` 目录,聚合返回。

### `skills read <name>` — 读 skill 内容

```bash
$ rxcli skills read orders
# 直接吐 SKILL.md 原文到 stdout(agent 读)
```

> **`skills read` 是输出契约的明示例外。** stdout 直接吐 Markdown 原文(**非** `{ok,data,meta}` 统一输出格式),因为消费方是 agent,直读/管道拼接(类似 `cat`)最自然。这是成功侧输出契约的**唯一**例外(错误侧对应 `BareError`),普通业务命令不得效仿。详见 `03-envelopes.md`。

支持读子文件:`rxcli skills read orders/references/orders-list.md`。带路径穿越校验(拒绝 `..`、绝对路径),对齐 lark-cli 的 `cleanSubPath`。

### `skills sync` — 同步到已装的 agent 扫描目录(探测模式)

```bash
$ rxcli skills sync
Synced 5 skill(s) to 2 target(s):
  ✓ agents     /home/u/.agents/skills
  ✓ claude     /home/u/.claude/skills
  · codex      (not installed, skipped)
  · cursor     (not installed, skipped)
  · zcode      (not installed, skipped)
  · openclaw   (not installed, skipped)
  · pi         (not installed, skipped)
```

**探测模式(默认)**:`skills sync` 只往**用户实际安装了的** agent 工具目录写,避免给只装 1-2 个工具的用户创建一堆空目录:

- **`~/.agents/skills` 始终写**(Agent Skills 标准路径,任何兼容工具都能发现,作为兜底)
- **其余工具**(`~/.claude`、`~/.codex` 等)只在其父目录已存在(=用户装了该工具)时才写
- 未安装的工具记 `skipped`,不创建目录、不算失败

用户后续装了新工具后,重新跑一次 `skills sync` 即可补装。单个 target 写入失败(权限/磁盘)不中断其余,最后汇总。这是离线兜底;在线推荐用 `@renxqoo/cli` meta 包的 install 向导(覆盖 30+ agent 工具)。

#### 内置默认 target 列表(`DEFAULT_SKILL_TARGETS`)

| key        | 目录                 | 工具                      |
| ---------- | -------------------- | ------------------------- |
| `agents`   | `~/.agents/skills`   | Agent Skills 标准(始终写) |
| `claude`   | `~/.claude/skills`   | Claude Code               |
| `codex`    | `~/.codex/skills`    | OpenAI Codex              |
| `cursor`   | `~/.cursor/skills`   | Cursor                    |
| `zcode`    | `~/.zcode/skills`    | ZCode                     |
| `openclaw` | `~/.openclaw/skills` | OpenClaw                  |
| `pi`       | `~/.pi/agent/skills` | Pi Coding Agent           |

业务包可通过 `defineCli({ skillsTargets })` 覆盖这份列表——**配了 skillsTargets 时强制全写指定目录,不走探测**(业务包显式指定 = 强制)。见下文"自定义同步目标"。

---

## SKILL.md 结构

每个 skill 一个目录,`SKILL.md` 是入口:

```
skills/orders/
├── SKILL.md                    入口(命令表自动生成 + 语义手写)
└── references/                 深度文档(可选,手写)
    ├── orders-list.md
    └── orders-get.md
```

### SKILL.md 模板(skill-tpl)

```markdown
---
name: orders
description: 查询订单列表/详情/更新。当用户需要查订单、看订单列表、查某个订单详情时使用。
version: 1.0.0
metadata:
  requires:
    bins: ["rxcli-orders"]
  category: business
---

# orders

订单查询与管理。支持列表、详情、更新状态。

<!-- AUTO-GEN:START commands -->
<!-- 本区块由 `rxcli skills gen` 自动生成,不要手改 -->

## 命令

| 操作         | 命令                                                                           | 权限         |
| ------------ | ------------------------------------------------------------------------------ | ------------ |
| 查询订单列表 | `rxcli-orders list [--limit <number>] [--offset <number>] [--status <string>]` | —            |
| 查询订单详情 | `rxcli-orders get <id>`                                                        | —            |
| 更新订单状态 | `rxcli-orders update <id> [--status <string>]`                                 | orders:write |

### 参数说明

**list**

| 参数       | 类型   | 必填 | 默认 | 说明                          |
| ---------- | ------ | :--: | ---- | ----------------------------- |
| `--limit`  | number |  否  | 30   | 返回数量上限                  |
| `--offset` | number |  否  | 0    | 偏移量                        |
| `--status` | string |  否  | —    | 状态过滤: unpaid/paid/shipped |

**get**

| 参数   | 类型   | 必填 |
| ------ | ------ | :--: |
| `<id>` | string |  是  |

**update**

| 参数       | 类型   | 必填 |
| ---------- | ------ | :--: |
| `<id>`     | string |  是  |
| `--status` | string |  否  |

<!-- AUTO-GEN:END -->

## 错误处理

| 错误                     | 处理                                  |
| ------------------------ | ------------------------------------- |
| `not_found` / exit 1     | 订单不存在,用 `orders list` 查有效 ID |
| exit 3 + `missing_scope` | 重新登录获取 scope,见 error.hint      |
| exit 4 网络错误          | 稍后重试                              |
```

### 关键设计:AUTO-GEN 标记块(preserved regions)

```
<!-- AUTO-GEN:START commands -->
... 自动生成的内容 ...
<!-- AUTO-GEN:END -->
```

- **标记块内**:自动生成,每次 `gen` 覆盖,**人不要手改**
- **标记块外**:人写的语义内容,`gen` **永不触碰**

这样你可以反复跑生成(命令加了一个参数,重新 gen),人工写的"错误处理"等语义内容永远不丢。这是 swagger/openapi-codegen 的成熟做法。

---

## 自动文档生成

### 生成器输入:`defineCommands` 的结构化信息

生成器从命令定义里提取这些机械信息:

| 字段              | 来源                      | 进文档哪里                   |
| ----------------- | ------------------------- | ---------------------------- |
| `name`            | defineCommand.name        | 命令表的"操作"列             |
| `description`     | defineCommand.description | 命令表的描述                 |
| `args.*.type`     | 参数类型                  | 参数表的"类型"列             |
| `args.*.required` | 是否必填                  | 参数表的"必填"列             |
| `args.*.default`  | 默认值                    | 参数表的"默认"列             |
| `args.*.desc`     | **可选**描述              | 参数表的"说明"列(不填则是 —) |
| `requiresScope`   | 所需 scope                | 命令表的"权限"列             |

### 生成命令

两种入口都能跑(业务包 bin 或 rxcli 主包):

```bash
# 首次:用 skill-tpl 生成整份 SKILL.md(带 {{FILL}} 占位符)
rxcli-orders skills gen orders --init      # 业务包 bin
rxcli skills gen orders --init             # 或走 rxcli 主包

# 后续:只刷新 AUTO-GEN 标记块,保留人工内容
rxcli-orders skills gen orders

# --lang 控制骨架语言(默认英文;中文项目用 zh)
rxcli-orders skills gen orders --init --lang zh
```

### 生成策略 A + B(都用,决策清单 #15)

| 策略                | 行为                                                   | 命令                |
| ------------------- | ------------------------------------------------------ | ------------------- |
| **A. 命令文档片段** | 只生成 `## 命令` + `### 参数说明` 两节,塞进标记块      | `gen <name>`(增量)  |
| **B. 完整骨架**     | 首次吐整份 SKILL.md(带 `{{FILL}}` 占位),后续只刷标记块 | `gen <name> --init` |

首次 `--init` 用 B,后续维护用 A。两者共享同一套标记块机制。

## 命令签名生成规则

自动生成的签名要稳定、可预测,否则 agent 容易读错。规则(commander/git/jq 通用约定,决策清单):

| 参数特征              | 签名写法             | 例子                  |
| --------------------- | -------------------- | --------------------- |
| required + positional | `<name>`             | `get <id>`            |
| optional + positional | `[<name>]`           | `[<offset>]`          |
| required + flag       | `--name <type>`      | `--status <string>`   |
| optional + flag       | `[--name <type>]`    | `[--limit <number>]`  |
| boolean flag          | `[--flag]`           | `[--json]`            |
| array flag(可多次)    | `[--name <type>...]` | `[--tag <string>...]` |

### 生成示例

```ts
// 命令定义
list: defineCommand({
  args: {
    schema: z.object({
      limit: z.coerce.number().default(30),
      offset: z.coerce.number().default(0),
      status: z.string().optional(),
    }),
  },
})

// 生成的签名
rxcli-orders list [--limit <number>] [--offset <number>] [--status <string>]
```

```ts
get: defineCommand({
  args: { schema: z.object({ id: z.string() }), pos: ['id'] },
})

// 生成的签名
rxcli-orders get <id>
```

所有自动签名风格一致,agent 和人都能盲读。

---

## Zod 的 `.describe()`（提升文档质量）

直接在 Zod 字段上调用 `.describe()`；描述会进入生成文档，未填写时显示 `—`：

```ts
args: {
  schema: z.object({
    limit: z.coerce.number().min(1).max(100).default(30).describe("返回数量上限（1-100）"),
    status: z.enum(["unpaid", "paid", "shipped", "cancelled"])
      .describe("订单状态")
      .optional(),
    force: z.boolean().default(false).describe("跳过确认"),
  }),
},
```

建议为每个业务参数填写 `.describe()`，这是自动生成 help 和 Skill 参数文档的文字来源。

---

## skill 同步机制

业务包自带的 `skills/` 目录,通过两种方式让 agent 发现:

### 方式 1:`skills sync`(离线兜底,探测式多 target)

```bash
rxcli skills sync
# 把所有已装业务包的 skills/ 拷贝到用户已装的 agent 工具发现目录:
#   ~/.agents/skills(始终写)+ 探测到的已装工具目录
#   (没装的工具不创建空目录)
```

**探测逻辑**:`~/.agents/skills` 始终写(标准兜底);其余 target(`~/.claude`、`~/.codex` 等)只在其父目录已存在(=用户装了该工具)时才写。这样只装了 Claude Code 的用户只会写 `~/.agents/skills` + `~/.claude/skills`,不会污染其余目录。

#### 自定义同步目标(`defineCli({ skillsTargets })`)

框架内置 7 个默认 target(见上表 `DEFAULT_SKILL_TARGETS`),默认走探测。业务包可完全覆盖:

```ts
import { defineCli } from "@renxqoo/agent-cli-sdk";

defineCli({
  // …
  // 只同步到 Claude Code 和 ZCode(覆盖默认 7 个)
  // 注意:配了 skillsTargets 后【强制全写指定目录,不走探测】
  skillsTargets: [
    { key: "claude", dir: "~/.claude/skills" },
    { key: "zcode", dir: "~/.zcode/skills" },
  ],
  // [] 空数组 → 关闭多 target(仅 install 向导的 npx 路径生效)
});
```

`dir` 支持 `~/` 前缀(自动展开为家目录),也支持绝对路径。

> **探测 vs 强制**:省略 `skillsTargets` → 探测模式(只写已装工具);配了 `skillsTargets` → 强制模式(列表里的目录全写,不探测)。业务包显式指定列表 = 表达"我知道我要装这些,别帮我探测"。

### 方式 2:`@renxqoo/cli` install 向导(在线,覆盖 30+ agent 工具)

```bash
npx @renxqoo/cli install
# 一键装到 Claude Code / Cursor / Codex / ZCode 等 30+ 工具的标准发现路径
```

详见 `@renxqoo/cli` meta 包文档(后续阶段)。

---

## skill frontmatter 规范

```yaml
---
name: orders # skill 名(必须,与目录名一致)
description: 一句话描述何时用 # 必须,agent 靠它语义匹配用户意图
version: 1.0.0 # 可选
metadata: # 可选
  requires:
    bins: ["rxcli-orders"] # 依赖的 bin
  category: business # 分类
  cliHelp: "rxcli-orders --help"
---
```

`description` 是 agent 触发 skill 的关键——agent 启动时按 description 语义匹配用户意图。所以要写清楚**何时用**,不只是**是什么**。

✅ 好 description:

```
"查询订单列表/详情/更新。当用户需要查订单、看订单列表、查某个订单详情时使用。"
```

❌ 坏 description(太抽象,agent 难匹配):

```
"订单管理工具"
```

---

## skill reader 的路径穿越校验(安全)

`skills read <name>/<path>` 拒绝路径穿越(对齐 lark-cli `cleanSubPath`):

```bash
$ rxcli skills read orders/../../../etc/passwd
# error: invalid path: must be a relative path without '..'
```

校验规则:

- 拒绝绝对路径(`/etc/...`)和 Windows 绝对路径(`C:\...`)
- 拒绝含 `..` 的路径(归一化后检查)
- 只允许相对路径,限定在 skill 目录内

CLI 参数来自不可信的 agent,所有文件 IO 前必须校验路径(对齐 lark-cli 的 AGENTS.md 安全规范)。

---

## 完整工作流:开发一个 skill

```bash
# 1. 写命令(defineCommands,args 填 desc)
# src/commands/orders.ts 已定义好

# 2. 首次生成 SKILL.md 骨架
rxcli-orders skills gen orders --init
# → 生成 skills/orders/SKILL.md,带 AUTO-GEN 块(已填)+ {{FILL}} 占位
# 中文项目加 --lang zh:
# rxcli-orders skills gen orders --init --lang zh

# 3. 编辑 SKILL.md,填语义部分(description 触发语、错误处理)
vi skills/orders/SKILL.md

# 4. 后续命令有改动(加参数/改 scope),重新生成(只刷 AUTO-GEN 块)
rxcli-orders skills gen orders
# → 语义部分不动,机械部分更新

# 5. 可选:加深度文档
mkdir skills/orders/references
vi skills/orders/references/orders-list.md   # 手写,gen 不碰

# 6. 发布:skills/ 随包发布(package.json 的 files 含 "skills")
```

---

## skill 与 lark-cli 的关系

本框架的 `skills/reader.ts` 和 lark-cli 的 `skillcontent/reader.go` 几乎逐行一致(都是 list/read + 路径校验 + frontmatter 解析)。直接沿用这套(已验证),只增加:

- **命令文档自动生成**(框架新增,lark-cli 用别的方式)
- **跨包 skill 聚合**(业务包负责,lark-cli 是单仓)
