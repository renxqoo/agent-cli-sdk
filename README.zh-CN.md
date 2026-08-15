# @renxqoo/agent-cli-sdk

[English](README.md) · [中文](README.zh-CN.md) · [Website](https://renxqoo.github.io/agent-cli-sdk)

> **一个面向 agent 的 CLI「skill 工厂」。** 装一个 skill,让 AI agent 把你的任何公司 API 变成一个 CLI *和* 一个 agent skill —— 鉴权、统一输出、类型化错误、渐进披露全包。作者只写「调哪个接口、字段怎么映射」。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![CI](https://github.com/renxqoo/agent-cli-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/renxqoo/agent-cli-sdk/actions/workflows/ci.yml)

---

## 这是什么

`agent-cli-sdk` 让你用**一份声明**把公司 API 同时暴露给人和 AI agent。它是一个 SDK(你用它构建 CLI),也是一个 **skill 工厂**:包自带 [`agent-cli-builder`](skills/agent-cli-builder/SKILL.md) skill,所以 AI agent 能根据 API 描述帮你生成整份 CLI。

一个 `defineCommand` 产出三份同步的产物:

```
defineCommand(name / description / zod / run)
        │
        ├── CLI          人 + unix 管道(acme orders list | jq)
        ├── SKILL.md     渐进披露(由 `skills gen` 生成)
        └── agent 目录   由 `skills sync` 同步(~/.claude、~/.codex …)
```

**单一真相,命令、文档、agent 读到的东西永不漂移。**

---

## 怎么让 agent 生成你的 CLI

最快的路径 —— 你连代码都不用写:

```bash
# 1. 安装(同时会装 agent-cli-builder skill)
npm i -g @renxqoo/agent-cli-sdk
```

```text
# 2. 把 API 描述给 agent
"用 agent-cli-builder skill 把 https://api.acme.com 的 /orders 接口
 包装成一个叫 'acme' 的 CLI。支持列出、查看、更新订单。走 OAuth device flow。"
```

agent 会按 SDK 契约(Zod schema、`ctx.get`、类型化错误、`errs.*`)生成 `src/commands/*.ts` 和 `src/index.ts`。然后:

```bash
# 3. 编译 + 生成 skill + 同步到所有 agent 目录
acme skills gen acme --init   # 生成带自动命令表的 SKILL.md
acme skills sync              # ~/.agents + 探测到的 ~/.claude/.codex/.cursor/...
```

完成。同事跑 `acme orders list`;他们的 agent 从 skill 描述里发现 `acme`,用同样的方式调用。生成的代码是**可编译、可测试的**,不是示例片段 —— 生成过程由 skill 强制约束 SDK 的不变量。

---

## 安装

要求 **Node.js >= 20**。本包是 ESM-only(`import` / 动态 `import()`;不支持 CommonJS `require()`)。

```bash
npm install @renxqoo/agent-cli-sdk
# 或
pnpm add @renxqoo/agent-cli-sdk
```

---

## 快速开始

一个完整的单命令 CLI,不到 30 行(无鉴权、公开数据):

```ts
#!/usr/bin/env node
import { defineCli, defineCommand } from "@renxqoo/agent-cli-sdk";
import * as z from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = defineCli({
  name: "myapp",
  description: "My data CLI",
  baseUrl: "https://api.example.com",
  commands: {
    list: defineCommand({
      name: "list",
      description: "查询列表",
      args: {
        schema: z.object({
          limit: z.coerce.number().min(1).max(100).default(20),
        }),
      },
      async run(ctx, args) {
        const res = await ctx.get<{ items: Array<{ id: string; title: string }> }>("/items", {
          limit: args.limit,
        });
        return { data: res.data.items, meta: { count: res.data.items.length } };
      },
    }),
  },
});

function isMainEntry(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isMainEntry()) app.run(process.argv.slice(2));
export default app;
```

加 OAuth 只要一行:

```ts
import { defineCliApp, defineAuth } from "@renxqoo/agent-cli-sdk";
import { homedir } from "node:os";
import { join } from "node:path";

export default await defineCliApp({
  name: "orders",
  // 唯一的目录决策点;装配器通过 apply(services) 分发给每个有状态插件
  dir: join(homedir(), ".orders"),
  plugins: [
    defineAuth({
      credentialNamespace: "orders", // → config/orders.json + credentials/orders.json
      baseUrl: "https://auth.example.com",
      scope: "orders.read offline_access", // 业务自定,无默认
    }),
  ],
  commands: {},
});
// → orders auth login / status / logout / register 自动注入
```

---

## Core API

### `defineCli(options)` —— 装配一个 CLI

```ts
defineCli({
  name: 'orders',                  // 必填:命名空间
  description: '...',              // 必填
  plugins: [authPlugin],           // 可选:插件(鉴权/日志/审计…)
  commands: { list, get },         // 必填:顶层命令 → orders list
  namespaces: { orders: {...} },   // 可选:子命名空间 → orders orders list
  baseUrl: 'https://api.x.com',    // 可选:ctx.get/post/… 的后端地址
  errorOnStatus: { 404: 'not_found', '5xx': 'server_error' },  // 可选
  defaultFormat: 'auto',           // 可选:'auto'(默认)| 'json' | 'human'
  skillsDir: './skills',           // 可选:启用内置 skills 命令
  skillsTargets: [...],            // 可选:同步目标(省略 = 默认 agent 目录)
})
```

### `defineCommand(spec)` —— 声明一个命令

```ts
import * as z from "zod";

defineCommand({
  name: "get",
  description: "查询单个订单",
  args: {
    schema: z.object({
      id: z.string().min(1).describe("订单 ID"),
      verbose: z.boolean().describe("是否详细输出").default(false),
    }),
    pos: ["id"],   // `id` 是位置参数,不是同名 flag
  },
  humanFormat: (data) => `订单: ${data.id}`, // 可选:--no-json 的自定义文本
  async run(ctx, args) {
    const res = await ctx.get(`/orders/${args.id}`);  // ctx.get/post/put/patch/delete
    return { data: res.data };
  },
});
```

`args` 可选(省略 = 无业务参数)。它的 Zod 对象是**唯一**的校验与类型来源。`args.type` 默认 `"argv"`;设为 `"json"` 表示通过 `--input` / `--input-file` / stdin 接收一份完整 JSON 文档(见 [`docs/07-structured-input.md`](docs/07-structured-input.md))。

### `defineAuth(opts)` —— OAuth 2.1 工厂

```ts
const auth = defineAuth({
  credentialNamespace: "crm",          // → config/crm.json + credentials/crm.json
  baseUrl: AUTH_BASE_URL,              // OAuth 中间层
  scope: "company.api offline_access", // 登录与注册共用一个 scope
  // flow: 'device',                   // 默认 'device' | 'authorization_code' | 'client_credentials'
  // commandNamespace: 'auth',         // 默认 'auth' → crm auth login
});
```

一个工厂覆盖三种 OAuth 2.1 流程:`device`(RFC 8628,默认)、`authorization_code` + PKCE、`client_credentials`。它返回一个 Plugin —— 放进 `defineCliApp({ plugins: [auth] })`,login/status/logout/register 命令自动挂载。

### 插件(钩子 + provides)

```ts
const myPlugin = {
  name: "audit",
  enforce: "pre", // 'pre' | 'post'(默认 normal)
  provides: {
    commands: { telemetry: telemetryCmd },          // 贡献命令
    namespaces: { admin: { users: userCmd } },
  },
  async beforeRequest(ctx, req) {
    return { ...req, headers: { ...req.headers, "x-client": "my-cli" } };
  },
  async transformOutput(ctx, data) { return data; },
  async handleUnauthorized(ctx, event) { return { action: "decline" }; },
};
```

插件通过 `provides` 贡献的命令,会自动豁免*它自己的* `beforeCommand`,但不会豁免别的插件。详见 [`docs/02-sdk-guide.md`](docs/02-sdk-guide.md)。

---

## 输出契约

**成功**(stdout):

```json
{"ok":true,"source":"orders","data":{"orders":[...]},"meta":{"count":2,"pagination":{"complete":true}}}
```

**错误**(stderr):

```json
{
  "ok": false,
  "error": {
    "type": "api",
    "subtype": "not_found",
    "message": "Order not found",
    "hint": "Check the ID"
  }
}
```

**退出码**(按错误类别自动设置,agent 据此分支):

| 码 | 类别 | 含义 |
| --- | --- | --- |
| 0 | — | 成功 |
| 1 | api | 服务端业务错误(404/500/429…) |
| 2 | validation | 参数不合法 |
| 3 | authentication / authorization / config | 需登录 / 缺权限 / 缺配置 |
| 4 | network | DNS / 超时 / 连接被拒 |
| 5 | internal | SDK 内部错误(极少发生) |
| 6 | policy | 风控拦截 |
| 10 | confirmation | 高风险写入需 `--yes` |

九类类型化错误 —— `ValidationError` / `AuthenticationError` / `PermissionError` / `ConfigError` / `NetworkError` / `APIError`(含 `NotFoundError`)/ `PolicyError` / `InternalError` / `ConfirmationRequiredError`。永远 `throw errs.*`;裸 `Error` 会被降级成 `internal/unknown`。

**输出模式**:默认 `auto`(TTY → 文本,管道/脚本 → JSON),可用 `--json` / `--no-json` 或 `defaultFormat` 覆盖。agent 和脚本应始终显式传 `--json`。

---

## skill 与渐进披露

- `<bin> skills gen <name> --init` —— 生成带自动命令表的 `SKILL.md` 骨架(AUTO-GEN 区)。
- `<bin> skills gen <name>` —— 只刷新自动生成块;手写语义保留。
- `<bin> skills sync` —— 复制 skill 到已装 agent 目录(`~/.agents` 始终写;`~/.claude`/`~/.codex`/`~/.cursor`/`~/.zcode`/`~/.openclaw`/`~/.pi` 存在时写)。
- `<bin> skills list` / `<bin> skills read <name>` —— 列出 / 读取内置 skill。

agent **懒加载** skill:启动时只看到 `name + description`,任务匹配时展开整份 `SKILL.md`,需要时才读 `references/` —— 没被用到的 API 不消耗 token。

---

## 文档

设计文档随包发布在 [`docs/`](docs):

| 文档 | 内容 |
| --- | --- |
| [`00-overview.md`](docs/00-overview.md) | 架构、分层、决策清单 |
| [`01-cli-usage.md`](docs/01-cli-usage.md) | 命令调用、管道、分页、退出码 |
| [`02-sdk-guide.md`](docs/02-sdk-guide.md) | SDK 用法、ctx 接口、钩子 |
| [`03-envelopes.md`](docs/03-envelopes.md) | 统一输出字段契约 |
| [`04-errors.md`](docs/04-errors.md) | 9 类错误、何时 throw |
| [`05-credentials.md`](docs/05-credentials.md) | 凭证链、自定义凭证 |
| [`06-skills.md`](docs/06-skills.md) | skill 系统、命令文档自动生成 |
| [`07-structured-input.md`](docs/07-structured-input.md) | 结构化输入、校验、写入策略 |

npm 包自带 [`agent-cli-builder`](skills/agent-cli-builder/SKILL.md) skill —— 教 agent 用本 SDK 构建 CLI —— 以及 11 份 references(core API、auth patterns、error catalog、plugin patterns、skill generation、testing 等)。

---

## 开发

```bash
pnpm install
pnpm build        # tsup → dist/
pnpm typecheck    # tsc(含 type-tests)
pnpm test         # vitest
pnpm test:package # npm tarball 冒烟测试
```

提交 PR 或问题前,请先读[贡献指南](CONTRIBUTING.md)、[安全策略](SECURITY.md)和[支持说明](SUPPORT.md)。

## License

[MIT](LICENSE) © [renxqoo](https://github.com/renxqoo)
