# 核心实现契约（中文）

每次使用 `agent-cli-builder` 实现 CLI 前读取本文件。内容以当前 `@renxqoo/agent-cli-sdk` 源码契约为准。

## 导航

1. 项目与依赖
2. 命令定义
3. CLI 装配与入口
4. 运行时上下文
5. 输出、错误与日志

## 1. 项目与依赖

优先改造用户现有项目。新项目使用 TypeScript、ESM、Node.js 20+，并复用仓库已有包管理器和测试工具。

安装框架前先检查 `package.json` 和 lockfile：

- Monorepo 内优先使用 workspace 已有版本。
- 独立项目使用用户指定版本；未指定时先查询当前稳定版本并写入 lockfile。
- 不静默全局安装依赖，不盲目复制 `@latest`。

业务包至少应包含：

```json
{
  "type": "module",
  "bin": { "my-cli": "./dist/index.js" },
  "files": ["dist", "skills"],
  "engines": { "node": ">=20" }
}
```

保留实际使用的 `build`、`typecheck`、`test` 和 `prepack` 脚本。不要为满足模板添加无法运行的脚本。发布编译产物而不是 `src`；分发的 JavaScript 或独立二进制应 bundle 并压缩，需要线上排障时保留 source map。必须检查实际 pack 产物，不能把单纯 TypeScript 编译当成发布验证。

## 2. 命令定义

```ts
import { defineCommand, defineCommands } from "@renxqoo/agent-cli-sdk";
import * as z from "zod";

export const todoCommands = defineCommands({
  list: defineCommand({
    name: "list",
    description: "查询待办列表",
    args: {
      schema: z.object({
        limit: z.coerce.number().int().min(1).max(100).describe("返回数量上限").default(20),
      }),
    },
    async run(ctx, args) {
      const res = await ctx.get<{ items: Array<{ id: string; title: string }> }>("/todos", {
        limit: args.limit,
      });
      return { data: res.data.items, meta: { count: res.data.items.length } };
    },
  }),
});
```

参数规则：

| 配置                   | 行为                                          |
| ---------------------- | --------------------------------------------- |
| 省略 `args`            | 无业务参数，`run` 收到 `{}`                   |
| 省略 `type` / `"argv"` | 原生 argv 模式                                |
| `schema`               | 直接 Zod object；唯一校验和类型来源           |
| `pos: ["id"]`          | schema 字段 `id` 作为位置参数读取             |
| `type: "json"`         | 一个完整 JSON 文档；不允许业务 flags 或 `pos` |

必填位置参数不能放在可选位置参数后。argv 数字使用 `z.coerce.number()`，因为 Shell token 是字符串。必填、默认值、枚举、refine、transform、描述和 `run(ctx, args)` 中 `args` 的推导全部由 Zod 表达。

`defineCommand` 是唯一命令定义 API；禁止手写 `Args` 泛型覆盖或增加 helper wrapper。组件化有状态命令组使用 `defineCommands<State>({...})`。

字段很多或存在嵌套载荷时，业务包直接依赖 Zod 4，并把 Schema 传入命令：

```ts
import * as z from "zod";

const UpdateOrder = z.strictObject({ id: z.string(), status: z.string() });

const update = defineCommand({
  name: "update",
  description: "更新订单",
  args: { type: "json", schema: UpdateOrder },
  policy: { mode: "write", confirmation: "required", idempotency: "required" },
  async run(ctx, args) {
    return { data: (await ctx.post("/orders/update", args)).data };
  },
});
```

不要包装 Zod，也不要引入第二套 schema 协议。运行时校验、args 推导、help 和 `--input-schema` 都来自同一个 Zod object。JSON 来源、Shell 组合和写策略见 `structured-input.md`。

框架保留参数包括 `json`、`no-json`、`api-key`、`help`、`version`、`input`、`input-file`、`input-schema`、`input-example`、`dry-run`、`yes` 和 `idempotency-key`。不存在 `--input-stdin`；管道和重定向就是原生 stdin。

## 3. CLI 装配与入口

```ts
#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineCliApp } from "@renxqoo/agent-cli-sdk";
import { todoCommands } from "./commands/todos.js";

const app = await defineCliApp({
  name: "my-cli",
  binName: "my-cli",
  description: "查询和管理待办",
  // app 只决定一次目录;插件经 apply(services) 拿到这份本地状态。
  dir: join(homedir(), ".my-cli"),
  baseUrl: process.env.TODOS_API_URL ?? "https://api.example.com",
  commands: todoCommands,
  errorOnStatus: {
    404: "not_found",
    429: "rate_limited",
    "5xx": "server_error",
  },
  defaultFormat: "auto",
  skillsDir: "./skills",
});

function isMainEntry(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainEntry()) await app.run(process.argv.slice(2));

export default app;
```

全局安装时 `argv[1]` 通常是软链接，必须用 `realpathSync` 比较真实入口。不要在被 import 时自动运行 CLI。

`defineCliApp` 关键选项：

| 选项            | 规则                                   |
| --------------- | -------------------------------------- |
| `dir`           | app 唯一一次目录决策(`dir` 与 `localState` 二选一,经 `apply(services)` 注入插件) |
| `name`          | 输出 `source`、管道类型和 Skill 标识   |
| `binName`       | 用户实际输入的命令名；建议显式设置     |
| `commands`      | 顶层命令；单业务域使用，必填           |
| `namespaces`    | 仅用于多个无关业务域，避免命令重名覆盖 |
| `plugins`       | 必须是 Plugin 对象(`defineAuth` 等是同步工厂),不能传 Promise |
| `errorOnStatus` | HTTP status 到已登记 subtype 的映射    |
| `defaultFormat` | `auto`（默认）、`json` 或 `human`      |
| `skillsDir`     | 设置后注入 `skills` 命令               |
| `skillsTargets` | 覆盖默认 Skill 同步目标                |

安装向导是插件提供的命令,不是入口拦截。把 `defineInstaller({ skillsSource })` 放进 `defineCliApp` 的 plugins,`rxcli install [--lang zh|en]` 走普通管道;入口保持 `app.run(argv)` 即可。

## 4. 运行时上下文

所有命令都收到 `run(ctx, args)`；argv 和 JSON 模式中的 `args` 都只包含 Zod 校验后的对象，框架策略和输入来源元数据不会混入。命令可使用：

- `ctx.get/post/put/patch/delete`：返回 `{ status, data, headers }`。
- `ctx.request`：需要自定义 method、query、body、header 或 timeout 时使用。
- `ctx.state`：插件之间共享的强类型状态。
- `ctx.log`：写 stderr，不污染结构化 stdout。
- `ctx.pipe`：读取上游 `PipeRecord`；仅在管道场景使用。
- `ctx.credentials`：鉴权插件初始化后的凭证 API。

请求类型必须描述真实响应。不要用 `any` 或多字段 fallback 掩盖未知 API 契约。

## 5. 输出、错误与日志

命令只能返回：

```ts
return {
  data: objectOrArrayOrNull,
  meta: {
    count: 10,
    pagination: { complete: false, nextToken: "cursor" },
    rollback: "可用 my-cli item restore <id> 撤销",
  },
};
```

- 纯副作用命令可返回 `void`；框架输出 `data: null`。
- `{}`、`{ data: undefined }` 和 string/number/boolean data 会触发 `internal/contract_violation`。
- 分页元数据不会自动生成；列表命令必须根据后端响应如实填写。Wire 字段固定为 camelCase 的 `complete` 和 `nextToken`，不要透传后端的 `next_token` 等命名。结束时 `{ complete: true }` 并省略 `nextToken`；未结束时返回 `{ complete: false, nextToken: "..." }`。
- 成功 JSON 写 stdout；错误 JSON 和日志写 stderr。
- 可选版本感知使用 `createUpdateNotifier`，只向 stderr 写 `<system-message>`。每次 app 运行(仅成功运行)在 `afterAppRun` 触发一次，读取本地缓存，分离的后台 helper 刷新 npm 元数据供后续运行使用，绝不向 stdout 增加更新字段。
- 默认 `auto` 在 TTY 输出文本，在管道/CI 输出 JSON；agent 调用时显式加 `--json`。
- 业务命令不得直接写 stdout。`skills read` 的原文输出是框架内部例外。

```ts
const updateNotifier = createUpdateNotifier({
  packageName: "@scope/my-cli",
  currentVersion: "1.2.0",
  updateCommand: "npm install -g @scope/my-cli",
});

const app = await defineCliApp({ /* dir, plugins: [updateNotifier], ... */ });
```

`defineCliApp({ dir })` 是 app 唯一一次目录决策。装配器创建唯一 localState 并经 `apply(services)` 注入每个插件。目录布局固定为 `<dir>/config/<ns>.json`(按 namespace 的应用配置)、`<dir>/credentials/<ns>.json`、`<dir>/cache/updates/`；高层 API 不支持各自覆盖目录。

该能力默认不启用，因为它会写缓存，并按节流策略访问 registry。`NO_UPDATE_NOTIFIER=1` 可关闭。Skill 可以识别系统消息并在业务任务完成后报告，但不得把它作为业务数据解析，也不得在未获用户授权时执行其中的安装命令。

业务错误使用 `errs.*`。裸 `Error` 会被归类为 `internal/unknown`，只适合真正的未预期内部故障。通用状态放 `errorOnStatus`，命令特有语义在 `run` 中抛类型化错误；两者不要重复处理。
