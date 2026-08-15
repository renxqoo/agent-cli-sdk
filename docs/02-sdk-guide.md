# 02 · SDK 开发指南

> 给**业务包开发者**看。讲清楚怎么用 `@renxqoo/agent-cli-sdk` 写一个业务包:目录结构、ctx、命令、插件、auth、分页、测试。这是开发者最常翻的文档。

---

## 快速开始:一个最小业务包

### 1. 创建项目

```bash
mkdir rxcli-orders && cd rxcli-orders
pnpm init
pnpm add @renxqoo/agent-cli-sdk
```

### 2. 目录结构

```
rxcli-orders/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          ← 入口:defineCli 装配(plugins + commands)
│   └── commands/
│       ├── orders.ts     ← 命令组(可拆多个文件)
│       └── invoices.ts
└── skills/
    └── orders/
        └── SKILL.md      ← 教 agent 怎么用(命令表自动生成)
```

> 注意:没有 `client.ts`。agent-cli-sdk 取消了 client 概念,请求方法直接挂在 `ctx` 上。标准 OAuth、Bearer、API key 和 Basic 鉴权优先使用 `defineAuth`;只有 HMAC、mTLS 等特殊协议才手写 Plugin。

### 3. package.json

```jsonc
{
  "name": "@org/rxcli-orders",
  "version": "1.0.0",
  "type": "module",
  "bin": { "rxcli-orders": "./dist/index.js" }, // 独立 bin
  "main": "./dist/index.js",
  "files": ["dist", "skills"], // skills 随包发布
  "scripts": {
    "build": "tsc",
    "test": "vitest",
  },
  "dependencies": { "@renxqoo/agent-cli-sdk": "^1.2.0" },
}
```

`@renxqoo/agent-cli-sdk` 仅提供 ESM。业务包必须使用 `"type": "module"` 和 ESM `import`;不支持 CommonJS `require()`。

### 4. 入口 src/index.ts

```ts
#!/usr/bin/env node
import { defineCliApp, defineAuth } from "@renxqoo/agent-cli-sdk";
import { ordersCommands } from "./commands/orders.js";
import { homedir } from "node:os";
import { join } from "node:path";

type OrdersState = {
  user: { userId: string } | null;
};

export default await defineCliApp<OrdersState>({
  name: "orders",
  description: "订单查询与管理",
  dir: join(homedir(), ".orders"), // 唯一一次目录决策
  plugins: [
    defineAuth({
      credentialNamespace: "orders", // → config/orders.json + credentials/orders.json
      baseUrl: "https://auth.example.com",
      scope: "orders.read offline_access",
    }),
  ],
  commands: ordersCommands,
  skillsDir: "./skills",
});
```

> `defineAuth` 是同步工厂,返回普通 `Plugin` 并自动贡献 login/status/logout/register 命令;`defineCliApp` 在路由编译前执行插件 `apply(services)` 完成装配。需要特殊协议时，再使用 provider chain、context-keyed session 和 `handleUnauthorized` 等公开基础块手写 Plugin；见 `05-credentials.md`。

**就这些。** 下面逐块讲 `ctx`、`defineCommand`、插件系统、auth。

---

## 编程风格:function,不是 class

agent-cli-sdk 采用 **function 风格 + 配置对象声明**(决策清单 #3)。理由:

- **组合 > 继承**:框架场景要组合(管道)、要 tree-shaking(发 npm)、要好测(mock 参数)。class 继承在这三方面都劣于 function。
- **依赖注入而非隐式 this**:命令 `run(ctx, args)` 通过 `ctx` 拿到框架注入的能力(`ctx.get`、`ctx.log` 等),不靠 class 继承链的隐式 `this`。agent 读代码时无歧义。

对比:

```ts
// ❌ class 风格(不用):强耦合、隐式 this、难组合
class Orders extends Client {
  async list() { return this.request(...) }   // this 哪来的?测试要 mock 整个继承链?
}

// ✅ function 风格(采用):命令 run 内通过 ctx 拿能力,纯函数好测
async run(ctx, args) {
  const res = await ctx.get('/orders', args)        // ctx.get 直接挂 ctx
  return { data: res.data.items }                   // return 数据,框架调序列化
}
```

**两种 function 写法**:命令的 `run` 内直接用 `ctx.get`(注入);若把"调后端"逻辑抽成独立纯函数(便于单测复用),则显式传一个能请求的对象:

```ts
// 抽成独立函数:显式传能请求的对象,纯函数,脱离 ctx 也能测
async function listOrders(requester: { get: (...)=>... }, params: Record<string, unknown>) {
  const res = await requester.get('/orders', params)
  return res.data.items
}

// run 里调用它(把 ctx 传进去,ctx 本身就有 get 方法)
async run(ctx, args) {
  const items = await listOrders(ctx, args)   // ctx 有 get,直接传
  return { data: items }
}
```

**约定:简单命令直接用 `ctx.get`;复杂/复用逻辑抽独立函数并显式传 `ctx`(或能请求的对象)。** 两种都是 function 风格。不存在 class 继承,也不存在 client 对象。

---

## TS 类型规范(用类型卡死约束)

agent-cli-sdk 用 TS 类型系统强制规范结构约束。下表是"能用 TS 卡住的"和"卡不住需运行时补"的区分:

| 约束                             | 卡住方式                                          | TS 还是运行时            |
| -------------------------------- | ------------------------------------------------- | ------------------------ |
| `name`/`description`/`run` 必填  | CommandSpec 必填字段                              | TS 编译报错              |
| `args.type` 只能 4 种            | ArgType 联合字面量                                | TS                       |
| `args` 解析后强类型              | ParsedArgs 推导 **或** interface 显式声明         | TS                       |
| `ctx.state` 强类型(防乱塞)       | `defineCli<State>` 泛型,未声明访问报错            | TS                       |
| `commands`/`namespaces` 类型分离 | 顶层命令 vs 子命名空间组用独立字段,无联合类型歧义 | TS                       |
| `ctx.get<T>()` 响应类型          | 请求泛型(可选)                                    | TS                       |
| `transformOutput` 不返回 string  | 返回 StructuredData                               | TS                       |
| `run` 输出数据                   | return CommandResult                              | TS(漏 return 运行时警告) |
| 禁 console.log 到 stdout         | —                                                 | 运行时/lint(TS 管不了)   |

### 命令三泛型 `<Args, Result>` + 业务包级 `<State>`

这是类型规范的核心。**一个命令把它的参数类型、返回类型都声明清楚**(类似 axios 声明请求/响应类型);**state 类型业务包级声明一次**:

```ts
// 业务包先定义类型
interface OrdersState {
  user: { userId: string } | null
}

interface OrderListArgs {
  limit?: number
  status?: 'paid' | 'unpaid' | 'shipped'   // 联合字面量,spec 推导不出来
}

interface OrderItem { id: string; total: number; status: string }
interface OrderListPayload { items: OrderItem[]; hasMore: boolean; nextCursor?: string }

// 命令:<Args, Result>(State 在 defineCli 声明)
// Result 是 run 返回 data 字段的类型。list 命令 data 放数组 → Result = OrderItem[]
list: defineCommand<OrderListArgs, OrderItem[]>({
  name: 'list',
  description: '查询订单列表',
  args: { limit: { type: 'number', default: 30 }, status: { type: 'string' } },
  async run(ctx, args) {
    // args: OrderListArgs(强类型,有补全;args.foo 报错)
    // ctx.state.user: { userId } | null(从 defineCli<State> 推导)
    const res = await ctx.get<OrderListPayload>('/orders', args)   // 泛型是响应 body 类型
    return {
      data: res.data.items,                                         // ← data 放数组(OrderItem[])
      meta: { pagination: { complete: !res.data.hasMore, nextToken: res.data.nextCursor } },
    }
  },
})

// 业务包:<State>(声明 ctx.state 形状)
defineCli<OrdersState>({ ... })
```

| 类型     | 声明位置                         | 职责                                      |
| -------- | -------------------------------- | ----------------------------------------- |
| `State`  | `defineCli<State>`               | `ctx.state` 的类型,业务包级(所有命令共享) |
| `Args`   | `args.schema` 的 Zod output      | `run(ctx, args)` 中 `args` 的唯一类型来源 |
| `Result` | `run` 返回的 `{ data }` 自动推导 | 命令输出类型                              |

**一个入口,一个类型来源。** `defineCommand({...})` 只从 `args.schema` 的 Zod object 推导并校验参数；不接受手写 `Args` 泛型覆盖，不存在适配器或第二套 schema。

### args:Zod 参数规范

```ts
type CommandArgs =
  | { type?: "argv"; schema: ZodObject; pos?: string[] }
  | { type: "json"; schema: ZodObject; pos?: never };
```

- 省略 `args`:无业务参数,`run` 收到 `{}`。
- 省略 `type`:默认 `argv`;`pos` 按顺序列出只能裸传的位置参数字段,不同时接受同名长 flag;其余字段映射为 kebab-case 长 flags。
- `type: "json"`:整个参数对象来自一个 JSON 文档,不允许业务 flags 或位置参数混入。
- required、default、enum、coerce、refine、描述和类型推导全部直接使用 Zod 标准能力。

### CommandSpec:命令结构必填

```ts
interface CommandSpec<Args, Result = unknown, State = unknown> {
  name: string; // 必填,缺了编译报错
  description: string; // 必填
  args?: CommandArgs;
  policy?: CommandPolicy<Args, State>;
  run: (ctx: CommandContext<State>, args: Args) => Promise<CommandResult<Result> | void>;
}
```

### CommandResult + StructuredData

```ts
interface CommandResult<T = unknown> {
  data: T; // 结构化数据
  meta?: Meta; // 可选(分页等)
}
// run 返回 CommandResult 或 void(纯副作用命令)

type StructuredData = Record<string, unknown> | unknown[] | null;
// transformOutput 返回 StructuredData,string 不匹配 → 编译报错
// 注意:不能用 object(object 在 strict 下太宽,拦不住 string)
```

### defineCli 泛型:ctx.state 的强类型来源

```ts
const ordersCommands = defineCommands<OrdersState>({
  list: defineCommand({
    name: "list",
    description: "查询订单",
    args: {},
    async run(ctx, _args) {
      return { data: { userId: ctx.state.user?.userId } };
    },
  }),
});

defineCli<OrdersState>({ commands: ordersCommands, ... });
```

组件化命令组使用 `defineCommands<State>({...})` 获得上下文类型；单独导出的命令可使用 `defineCommand<Args, Result, State>`。未声明 State 时是 `unknown`,不能静默访问任意字段；状态不兼容的命令组也不能挂到 `defineCli<State>`。

---

## ctx:请求与上下文

`ctx` 是 agent-cli-sdk 注入给每个 `run(ctx, args)` 的上下文。**请求方法直接挂在 ctx 上(无 client 层);鉴权由 auth 插件 + agent-cli-sdk 内部处理,业务包无感。**

```ts
interface CommandContext<State = {}> {
  // —— 请求方法(直接挂 ctx,无 client 层)——
  // T 是响应 body 类型,可选(不写则 data 是 unknown)
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<TransportResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<TransportResponse<T>>;
  put<T = unknown>(path: string, body?: unknown): Promise<TransportResponse<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<TransportResponse<T>>;
  delete<T = unknown>(path: string): Promise<TransportResponse<T>>;
  request<T = unknown>(opts: RequestOptions): Promise<TransportResponse<T>>; // 低层兜底

  // —— state:插件间共享数据,强类型(defineCli<State> 声明)——
  state: State;

  // —— 日志:强制 stderr(绝不污染 stdout/管道)——
  log: { info(msg: unknown): void; warn(msg: unknown): void; error(msg: unknown): void };

  // —— 管道:作为下游时读上游记录 ——
  pipe: { in(): AsyncIterable<PipeRecord>; isInPipe(): boolean };

  // —— 凭证(运行时读写,见 05-credentials.md)——
  credentials: {
    get(namespace: string): Promise<Record<string, string> | null>;
    save(namespace: string, creds: Record<string, unknown>): Promise<void>;
    clear(namespace: string): Promise<void>;
  };

  // —— 鉴权状态 ——
  auth: { status(): AuthStatus; requireScope(scope: string): void };
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
}

interface TransportResponse<T> {
  status: number;
  data: T; // T 默认 unknown
  headers: Record<string, string>;
}
```

### 请求泛型(可选,axios 式)

`ctx.get<T>()` 的 T 是响应 body 的类型。**写不写都行**:

- **写了**:`res.data` 是你声明的类型,有补全、拼错报错
- **不写**:退化为 `unknown`,业务包自己断言

```ts
// 写泛型:res.data 强类型
const res = await ctx.get<OrderListResult>("/orders", { limit: 30 });
res.data.items; // ✅ 有补全

// 不写泛型:res.data 是 unknown
const res = await ctx.get("/orders", { limit: 30 });
res.data; // unknown
```

**泛型纯增强,不强制。**

### 鉴权:由 auth 插件 + agent-cli-sdk 请求层处理

业务包**不接触**鉴权细节(token/refresh/header 注入)。这些由两部分自动完成:

1. **auth 插件**(业务包自己写,用 agent-cli-sdk 基础块组装):beforeCommand 填 `ctx.state.user`、缓存 token,beforeRequest 注入 token header
2. **agent-cli-sdk 请求层**:401 自动 refresh(singleflight)——前提是 auth 插件实现公开的 `handleUnauthorized` hook

业务包只管 `ctx.get(...)` 发请求,token/header 自动带上。详见 `05-credentials.md`。

### state:插件间共享数据(强类型)

`ctx.state` 是**插件之间、插件与命令之间共享运行时数据**的渠道。强类型——`defineCli<State>` 声明什么,才能读写什么:

```ts
defineCli<{ user: { userId: string } | null }>({ ... })

// auth 插件(生产者):beforeCommand 时填 state.user
async beforeCommand(ctx) {
  ctx.state.user = { userId: 'u1' }   // ✅ 类型对
}
```

> 实际项目里 auth 插件会用 provider chain 取 token 再填 state.user,见 `05-credentials.md`。

// 命令 run(消费者):读 state.user
async run(ctx, args) {
ctx.state.user?.userId // ✅ 强类型
ctx.state.foo // ❌ 报错,没声明
}

````

**读写纪律**:生产者插件(如 auth)声明并写自己负责的字段;消费者(其它插件、命令 run)只读。靠命名约定 + 文档(如 auth 插件写 `user` 字段),TS 不强制读写区分。

> 为什么 state 要保留:插件 A(认证)算出的数据(user),插件 B(审计)或命令 run 要用,必须有共享渠道。没有 state 只能靠全局变量(更糟)。state 强类型化后,不再是"开放 bag 乱塞"——未声明访问直接编译报错。

### 输出机制:run 返回数据,框架调序列化

**命令通过 `return` 输出数据,不调用任何 out 方法。** run 返回 `CommandResult`,框架负责包装成统一输出格式 + 序列化到 stdout。

```ts
async run(ctx, args): Promise<CommandResult | void> {
  const res = await ctx.get<OrderListResult>('/orders', args)
  return {
    data: res.data.items,
    meta: { pagination: { complete: !res.data.hasMore, nextToken: res.data.nextCursor } },
  }
}
````

框架内部执行顺序:

```
1. 跑插件 beforeCommand(填 state)
2. 跑命令 run(ctx, args),拿返回值
3. 若有返回值:跑插件 transformOutput(transform data)
4. 框架包装成统一输出格式 + 序列化到 stdout
```

**关键纪律:**

- 业务命令**永远不能直接往 stdout 写**。要输出就 `return { data, meta }`,要日志就 `ctx.log`(stderr)。
- 纯副作用命令(如管道下游边读边写)可不 return(void 合法),但建议 return 个汇总。

---

## 命令:defineCommand

每个命令用 `defineCommand` 声明。命令可以单独定义,也可以组装成命令组对象。

### 单个命令(带三泛型)

```ts
import { defineCommand, errs } from "@renxqoo/agent-cli-sdk";
import * as z from "zod";
interface Order {
  id: string;
  total: number;
  status: string;
}

export const getOrder = defineCommand({
  name: "get",
  description: "查询订单详情",
  args: {
    schema: z.object({ id: z.string().describe("订单 ID") }),
    pos: ["id"],
  },
  async run(ctx, { id }) {
    const res = await ctx.get<Order>(`/orders/${id}`);
    if (res.status === 404) throw new errs.NotFoundError(`订单 ${id} 不存在`);
    return { data: res.data };
  },
});
```

### 命令组(组装多个命令)

```ts
// src/commands/orders.ts
import { defineCommands, defineCommand, errs } from "@renxqoo/agent-cli-sdk";
import * as z from "zod";
interface OrderListResult {
  items: Order[];
  hasMore: boolean;
  nextCursor?: string;
}

export const ordersCommands = defineCommands({
  list: defineCommand({
    name: "list",
    description: "查询订单列表",
    args: {
      schema: z.object({
        limit: z.coerce.number().describe("返回数量上限").default(30),
        offset: z.coerce.number().describe("偏移量").default(0),
        status: z.enum(["unpaid", "paid", "shipped"]).optional(),
      }),
    },
    async run(ctx, args) {
      const res = await ctx.get<OrderListResult>("/orders", {
        limit: args.limit,
        offset: args.offset,
        ...(args.status && { status: args.status }),
      });
      return {
        data: res.data.items,
        meta: {
          count: res.data.items.length,
          pagination: {
            complete: !res.data.hasMore,
            nextToken: res.data.nextCursor,
          },
        },
      };
    },
  }),

  get: defineCommand({
    name: "get",
    description: "查询订单详情",
    args: { schema: z.object({ id: z.string() }), pos: ["id"] },
    async run(ctx, { id }) {
      const res = await ctx.get<Order>(`/orders/${id}`);
      if (res.status === 404) throw new errs.NotFoundError(`订单 ${id} 不存在`);
      return { data: res.data };
    },
  }),

  update: defineCommand({
    name: "update",
    description: "更新订单",
    args: {
      schema: z.object({ id: z.string(), status: z.enum(["paid", "shipped"]) }),
      pos: ["id"],
    },
    async run(ctx, { id, status }) {
      const res = await ctx.patch(`/orders/${id}`, { status });
      return { data: res.data };
    },
  }),
});
```

### args 字段规范

| 字段     | 类型               | 说明                                      |
| -------- | ------------------ | ----------------------------------------- |
| `type`   | `"argv" \| "json"` | 省略默认 argv；json 与 flags/位置参数互斥 |
| `schema` | Zod object         | 唯一校验、默认值、描述和类型来源          |
| `pos`    | schema 字段名数组  | 仅 argv 可用；按顺序映射原生位置参数      |

SDK 只负责 Shell token 到对象的确定性映射和 Zod 校验,不参与业务参数语义。后端要 `page/pageSize` 还是 `cursor`,业务包在 `run` 里翻译。

### 权限检查:声明式 `requiresScope` vs 命令式 `ctx.auth.requireScope()`

| 方式                              | 用法       | 适合                           |
| --------------------------------- | ---------- | ------------------------------ |
| `requiresScope`(声明式)           | 命令配置项 | **默认用它**。scope 固定、静态 |
| `ctx.auth.requireScope()`(命令式) | run 内调用 | scope 取决于运行时条件         |

两者等价抛 `PermissionError`(exit 3)。声明式更清晰、进文档"权限"列,优先用。

---

## 插件系统(vite 式)

横切关注点(认证/格式/固定参数/错误处理/审计)通过**插件**实现。插件是带 name 的独立对象,可组合、可复用、可分发(独立 npm)。**钩子是插件的接口,不是 defineCli 的内联配置。**

### Plugin 接口

```ts
interface Plugin<State = {}> {
  name: string; // 必填:插件名(日志/溯源)
  enforce?: "pre" | "normal" | "post";
  apply?(services: Readonly<AppServices>): void | Promise<void>; // 装配期一次(defineCliApp 自动调)
  onAppRun?(event: Readonly<AppRunEvent>): void | Promise<void>; // 每次 app.run 一次
  afterAppRun?(event: Readonly<AppExitEvent>): void | Promise<void>; // 每次 app.run 结束一次
  beforeCommand?(ctx: CommandContext<State>): Promise<void>;
  beforeRequest?(
    ctx: CommandContext<State>,
    req: Readonly<RequestOptions>,
  ): Promise<RequestOptions>;
  observeRequest?(ctx: CommandContext<State>, event: Readonly<RequestAttemptEvent>): Promise<void>;
  handleUnauthorized?(
    ctx: CommandContext<State>,
    event: Readonly<RequestAttemptEvent>,
  ): Promise<UnauthorizedDecision | undefined>;
  transformOutput?(
    ctx: CommandContext<State>,
    data: Readonly<StructuredData>,
  ): Promise<StructuredData>;
  observeError?(ctx: CommandContext<State>, err: unknown): Promise<void>;
  handleError?(ctx: CommandContext<State>, err: unknown): Promise<ErrorDecision | undefined>;
}
```

### 钩子的职责

| 钩子                 | 何时触发             | 能改什么                               | 典型用途                                |
| -------------------- | -------------------- | -------------------------------------- | --------------------------------------- |
| `apply`              | 装配期(路由编译前)   | 解析 services、填 provides、建运行时状态 | 从 `services.localState.store` 装配 auth |
| `onAppRun`           | 每次 app.run 开始    | 只观察；失败被静默隔离                 | 启动打点                                |
| `afterAppRun`        | 每次 app.run 结束    | 只观察；失败被静默隔离                 | 版本感知通知(update-notifier)          |
| `beforeCommand`      | 命令 run 前          | `ctx.state`(填数据)                    | auth 填 user、参数预处理                |
| `beforeRequest`      | 每次 attempt 前      | 返回新的请求对象                       | 加固定 header、HMAC 签名、注入 tenantId |
| `observeRequest`     | 每次 attempt 后      | 只读事件(`response` / `network-error`) | 审计、metric、请求日志                  |
| `handleUnauthorized` | 首次 401 后          | 显式 `retry` / `decline` / `reject`    | 上下文隔离的凭证续期                    |
| `transformOutput`    | run 返回后、序列化前 | 返回新 `data`(StructuredData)          | 转换、脱敏、删内部字段、自定义格式      |
| `observeError`       | 错误规范化后         | 只观察，void 不改变结果                | 上报、审计                              |
| `handleError`        | 错误渲染前           | 显式 `pass` / `replace` / `recover`    | 归一化或恢复                            |

### 执行顺序:enforce 三档

每个钩子内,插件按 `enforce` 三档执行:

```
pre 插件(注册序)    ← 基础设置(加基础 header、auth 注入 token)
  ↓
normal 插件(注册序) ← 业务相关
  ↓
post 插件(注册序)   ← 最终包装(签名、收尾)
  ↓
(真正执行:发请求 / 序列化输出)
```

观察 hook (`observeRequest` / `observeError`) 的失败只记录 warning；控制流只能由显式 handle 决策改变。

app 级钩子 (`onAppRun` / `afterAppRun`) 是每次进程运行恰一次的观察器:覆盖 help、--version、未知命令与错误路径,异常被静默隔离,不能改变退出码或任何输出。它们只适合无需可靠交付的运维提示;需要保证完成的审计、写入或 telemetry 不得放在这里。`apply` 属于装配(失败 = 启动失败),由 `defineCliApp` 在路由编译前按注册序执行。

### beforeRequest:统一处理请求参数

beforeRequest 收到不可变的完整请求描述，必须返回新的请求对象:

```ts
// 插件:给所有接口的 query 加固定参数
const tenantPlugin = {
  name: "tenant",
  enforce: "pre",
  async beforeRequest(ctx, req) {
    return { ...req, query: { ...req.query, tenantId: "acme" } };
  },
};

// 插件:给所有接口的 header 加固定值
const headerPlugin = {
  name: "fixed-headers",
  enforce: "pre",
  async beforeRequest(ctx, req) {
    return {
      ...req,
      headers: { ...req.headers, "X-Client": "rxcli", "X-Trace-Id": ctx.state.traceId },
    };
  },
};

// 插件:HMAC 签名(post:等所有 header/body 定型后算)
const hmacPlugin = {
  name: "hmac",
  enforce: "post",
  async beforeRequest(ctx, req) {
    return { ...req, headers: { ...req.headers, "X-Sig": sign(req.headers, req.body) } };
  },
};
```

beforeRequest 还能返回新的 path(重写请求)或 throw 中断。改 path 是高风险操作。

### 用法:在 defineCli 注册插件

```ts
defineCli<{
  user: { userId: string } | null;
  traceId: string;
}>({
  name: "orders",
  plugins: [
    auth, // 业务包自写的 auth 插件(createCrmAuth,enforce:'pre')
    tenantPlugin, // 加固定 query
    headerPlugin, // 加固定 header
    hmacPlugin, // 签名(post)
    auditPlugin, // observeRequest 审计
  ],
  commands: ordersCommands,
});
```

**所有扩展统一成插件——defineCli 没有 `beforeRequest` 等内联钩子字段,只有 `plugins` 数组。** 业务包想内联一个简单逻辑,写匿名插件:

```ts
plugins: [
  {
    name: "inline",
    enforce: "pre",
    async beforeRequest(ctx, req) {
      return { ...req, headers: { ...req.headers, "X-Foo": "bar" } };
    },
  },
];
```

### 插件是独立可复用模块

插件可以发成独立 npm 包,多个业务包复用:

```ts
// @org/rxcli-plugin-tenant(独立 npm)
export const tenantPlugin = (tenantId: string): Plugin => ({
  name: 'tenant',
  enforce: 'pre',
  async beforeRequest(ctx, req) { return { ...req, query: { ...req.query, tenantId } } },
})

// 任意业务包用它
import { tenantPlugin } from '@org/rxcli-plugin-tenant'
defineCli({ plugins: [tenantPlugin('acme')], ... })
```

### 认证插件:标准场景用 defineAuth,特殊协议再组合基础块

`defineAuth` 是标准认证工厂，返回的仍是普通 `Plugin`。OAuth、Bearer、API key 和 Basic 场景直接使用它；HMAC、mTLS 或复合认证才用下列基础块手写 `beforeCommand`、`beforeRequest` 与 `handleUnauthorized`。

agent-cli-sdk 出的基础块(从主包 `@renxqoo/agent-cli-sdk` import):

| 基础块                                                                                                              | 作用                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `defineCliApp({ dir, plugins })` / `defineCli({ plugins })`                                                         | app 装配器(唯一目录决策,自动 apply 插件)/ 低层同步组装器               |
| `createLocalState({ dir })` / `createMemoryLocalState()`                                                            | 本地状态(含 ConfigStore;dir 与 localState 二选一注入 defineCliApp)     |
| `defaultProviders()` / `flagProvider` / `envProvider` / `fileProvider` / `oauthProvider`                            | provider chain 的默认 provider                                        |
| `resolveWithChain(providers, pctx)` / `resolveIdentityWithChain(providers, pctx)`                                   | 跑 chain 取 token / identity                                          |
| `injectAuthHeader(req, token, style)`                                                                               | 按 authStyle(bearer/x-api-key/basic)注入 header                       |
| `createOn401Hook({cfg, store, namespace})`                                                                          | 401 singleflight refresh 原语(由 Plugin 的 `handleUnauthorized` 调用) |
| `deviceAuthorization` / `pollDeviceToken` / `getUserInfo` / `revokeToken` / `registerClient` | OAuth 2.1 端点原语(device 设备授权 + 用户信息/吊销/注册) |

#### 如何写 auth Plugin(参考 `apps/crm/src/auth.ts` 的 `createCrmAuth`)

下面是一个完整的 auth Plugin 工厂示例。业务包照着这个骨架写,可换 provider、换 header 注入、换 identity 来源。目录/store 不在工厂入参:经 `apply(services)` 从装配器取(defineCliApp 自动执行):

```ts
import {
  type Plugin,
  type CommandContext,
  type ProviderContext,
  type ConfigStore,
  defaultProviders,
  resolveWithChain,
  injectAuthHeader,
  createOn401Hook,
  AuthenticationError,
} from "@renxqoo/agent-cli-sdk";

export function createCrmAuth<State extends { user?: unknown }>(opts: {
  namespace: string;
  authStyle?: "bearer" | "x-api-key" | "basic";
  oauth?: { baseUrl: string; clientId: string; clientSecret: string };
}): Plugin<State> {
  // 装配期状态:apply 里从 services.localState.store 解析后填入
  let ready!: { store: ConfigStore; providers: ReturnType<typeof defaultProviders>; on401?: () => Promise<any> };
  const authStyle = opts.authStyle ?? "bearer";
  const sessions = new WeakMap<CommandContext<State>, { token: string; refreshable: boolean }>();

  return {
    name: `auth:${opts.namespace}`,
    enforce: "pre",

    async apply(services) {
      const store = services.localState.store;
      const providers = defaultProviders();
      // 401 singleflight refresh hook(有 oauth 配置才创建)
      const on401 = opts.oauth
        ? createOn401Hook({ cfg: opts.oauth, store, namespace: opts.namespace })
        : undefined;
      ready = { store, providers, on401 };
    },

    async beforeCommand(ctx) {
      const { store, providers } = ready;
      // ① provider chain 取 token(命中即停)
      const pctx: ProviderContext = {
        namespace: opts.namespace,
        configStore: store,
        args: {},
        env: process.env,
      };
      const resolved = await resolveWithChain(providers, pctx);
      if (!resolved)
        throw new AuthenticationError({
          subtype: "no_credentials",
          message: "未配置凭证",
          hint: "设置 XXX_API_KEY 环境变量",
        });

      // ② 把 store 包装成 ctx.credentials(命令运行时 API)
      (ctx as any).credentials = {
        get: async (ns: string) => store.loadCredentials(ns),
        save: (ns: string, d: Record<string, unknown>) => store.saveCredentials(ns, d),
        clear: (ns: string) => store.clearCredentials(ns),
      };

      sessions.set(ctx, {
        token: resolved.token.token,
        refreshable: resolved.token.refreshable === true,
      });
    },

    async beforeRequest(ctx, req) {
      const prepared = { ...req, headers: { ...req.headers } };
      const session = sessions.get(ctx);
      if (session) injectAuthHeader(prepared, session.token, authStyle);
      return prepared;
    },

    async handleUnauthorized(ctx) {
      const session = sessions.get(ctx);
      if (!ready.on401 || !session?.refreshable) return { action: "decline" };
      const token = await ready.on401();
      if (!token)
        return {
          action: "reject",
          error: new AuthenticationError({ subtype: "token_expired", message: "refresh failed" }),
        };
      sessions.set(ctx, { ...session, token });
      return { action: "retry" };
    },
  };
}
```

**三个钩子的职责:**

| 出口                 | 在 auth Plugin 里做什么                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `beforeCommand`      | 跑 provider chain 取 token;包装 `store` 成 `ctx.credentials`;从命中的 provider 取 identity;建立 context-keyed session                      |
| `beforeRequest`      | 用 `injectAuthHeader(req, token, authStyle)` 按 authStyle 注入 `Authorization: Bearer xxx` / `X-Api-Key: xxx` / `Authorization: Basic xxx` |
| `handleUnauthorized` | 调 `createOn401Hook(...)`;更新 context-keyed session 后显式返回 `retry`                                                                    |

**关键纪律:**

- 认证用 `beforeCommand` + `beforeRequest` 两个标准钩子,不发明新机制。
- token 必须按 `CommandContext` 隔离(例如 `WeakMap<CommandContext, Session>`)，禁止用单个闭包变量共享。
- 401 refresh 是请求层(框架)的能力,但**执行能力**(怎么 refresh、怎么落盘)由 auth Plugin 通过公开 `handleUnauthorized` 提供。
- 业务包可以完全不参考 `createCrmAuth` 骨架,自己写——只要遵守 `Plugin` 接口和上面的契约。

详见 `05-credentials.md`。

### transform vs format 的分层

`transformOutput`(transform)和输出格式化(format)是**两层,不能合并**:

```
run() 返回结构化数据
  ↓ transformOutput 插件(业务包定义)→ 改 payload,但仍是结构化(StructuredData)
  ↓ agent-cli-sdk 包装成统一输出格式 + 序列化(format:JSON/table)
  ↓ stdout
```

| 层                            | 谁定义     | 输入→输出             | 例子                         |
| ----------------------------- | ---------- | --------------------- | ---------------------------- |
| transform (`transformOutput`) | 业务包插件 | 结构化→StructuredData | 删字段、改字段名、(以后)脱敏 |
| format                        | agent-cli-sdk    | 结构化→字节流         | `{...}`→JSON 文本 或 表格    |

**transform 永远不能返回 string**(StructuredData 类型排除),否则破坏管道契约。

### 生命周期总图

```
插件 beforeCommand(pre→normal→post)    填 state、改 args
  ↓
命令 run(ctx, args)                     业务逻辑,ctx.get 发请求,return {data,meta}
  ├ 每次 ctx.get/post:
  │    插件 beforeRequest(pre→normal→post)  改 req(加 header/签名/改 path)
  │    → 真正发请求(agent-cli-sdk 内部,带鉴权)
  │    插件 observeRequest(pre→normal→post)   审计/日志(只读 res)
  ↓
插件 transformOutput(pre→normal→post)      transform data(返回 StructuredData)
  ↓
框架序列化 → stdout                       统一输出格式(框架调,业务包不调)

任意阶段抛错 → 插件 observeError/handleError 链(每个都跑)→ 渲染错误输出到 stderr + exit code
```

---

## 分页实现

业务命令在 `run` 里手动驱动,`meta.pagination` 自己填(决策清单 #9:agent 自决续拉,不强制流式)。

### 简单分页(透传后端的 page/pageSize)

```ts
list: defineCommand({
  name: "list",
  description: "查询订单列表",
  args: {
    schema: z.object({
      limit: z.coerce.number().default(30),
      offset: z.coerce.number().default(0),
    }),
  },
  async run(ctx, args) {
    const res = await ctx.get("/orders", { limit: args.limit, offset: args.offset });
    return {
      data: res.data.items,
      meta: {
        count: res.data.items.length,
        pagination: {
          complete: !res.data.hasMore,
          pages: 1,
          items: res.data.items.length,
          nextToken: res.data.hasMore ? String(args.offset + args.limit) : undefined,
        },
      },
    };
  },
});
```

### 游标分页(GraphQL/现代 API)

```ts
list: defineCommand({
  name: "list",
  description: "查询订单列表",
  args: {
    schema: z.object({
      cursor: z.string().describe("分页游标(从 nextToken 取)").optional(),
    }),
  },
  async run(ctx, args) {
    const res = await ctx.get("/orders", { cursor: args.cursor });
    return {
      data: res.data.edges.map((e) => e.node),
      meta: {
        pagination: {
          complete: !res.data.pageInfo.hasNextPage,
          nextToken: res.data.pageInfo.endCursor,
        },
      },
    };
  },
});
```

**关键:`complete` 和 `nextToken` 必须如实填。** agent 靠它们判断是否续拉。详见 `03-envelopes.md`。

---

## 上百接口怎么办:拆文件组装

接口多时,按业务域拆文件,在入口组装(决策清单 #19:不做 resource 生成器)。组装规则用**显式 `namespaces` 字段**:

- **顶层命令**放 `commands`(其 key 就是命令名)→ `rxcli-crm <cmd>`
- **子命名空间组**放 `namespaces`(其 key 即子命名空间)→ `rxcli-crm <ns> <cmd>`

```ts
// src/commands/orders.ts
export const ordersCommands = defineCommands({ list: ..., get: ..., update: ... })

// src/commands/invoices.ts
export const invoicesCommands = defineCommands({ list: ..., generate: ... })

// src/index.ts —— 入口组装
export default defineCli<...>({
  name: 'crm',
  plugins: [auth],
  commands: {
    health: healthCmd,           // 顶层命令(可选)→ rxcli-crm health
  },
  namespaces: {
    orders:   ordersCommands,    // 子命名空间 → rxcli-crm orders list
    invoices: invoicesCommands,  // 子命名空间 → rxcli-crm invoices generate
  },
})
```

> **为什么用显式 `namespaces` 而非 spread/nested-duck-typing:** spread(`...ordersCommands`)会把 `list`/`get` 拍平,多业务域同名的 `list`/`get` 会键名冲突互相覆盖,且丢失子命名空间层级;duck-typing(value 有没有 `run` 来猜命令还是命名空间)则引入 TS 联合类型歧义。显式字段让 `commands` 和 `namespaces` 类型清晰分离,无歧义、无冲突。

**单业务域(独立 bin)无需 namespaces**:`defineCli({ name: 'orders', commands: ordersCommands })`,命名空间是 `name`(PipeRecord.type 兜底);终端命令名 `binName` 从 package.json 的 bin 自动探测,无需手写。

### defineCli 完整配置项参考

```ts
defineCli<State>({
  name: 'orders',                  // 必填:命名空间(PipeRecord.type 兜底、skill 标识用)
  binName?: 'rxcli-orders',        // 可选:终端 bin 名(help/SKILL.md 签名);自动从 package.json 探测,一般不用写
  description: '...',              // 必填
  plugins: Plugin[],               // 必填:所有扩展(含 auth,见下)
  commands: { ... },               // 必填:顶层命令组(key=命令名)→ rxcli-<name> <cmd>
  namespaces?: { ... },            // 可选:子命名空间组(key=子命名空间)→ rxcli-<name> <ns> <cmd>;单业务域不填
  skillsDir?: './skills',          // 可选:skill 目录(默认 ./skills)
  errorOnStatus?: Record<number | `${number}xx`, string>,  // 可选:status→错误自动 throw
  messages?: { ... },              // 可选:引导文案 i18n
})
```

**认证**:`defineAuth({...})` 是同步工厂,返回值直接放进 `defineCliApp` 的 `plugins`(装配器自动执行 `apply`);特殊协议才手写 Plugin(见 `05-credentials.md`)。

---

## 装载方式(同一套代码,两种用法)

### 方式 A:独立 bin(默认)

业务包 `package.json` 的 `bin` 字段决定 bin 名:

```json
{ "bin": { "rxcli-orders": "./dist/index.js" } }
```

装包后:`rxcli-orders list`。

### 方式 B:装进 rxcli 主包(成为子命令)

加 `"rxcli": {"plugin": true}` 标记,`@renxqoo/cli` meta 包启动时自动发现并注册为子命令:

```bash
npm i -g @org/rxcli-orders
rxcli orders list             # ← 自动注册(命名空间 = defineCli.name)
```

**业务包代码不变。**

### 方式 C:管道里组合

```bash
rxcli-orders list --status unpaid | rxcli-invoices generate
rxcli-orders list | rxcli-customers get
```

下游命令自动检测 stdin 是否管道调用(`ctx.pipe.isInPipe()`),无需声明 flag。

---

## 管道:作为下游命令

下游命令用 `ctx.pipe.in()` 读上游记录:

```ts
generate: defineCommand({
  name: 'generate', description: '生成发票',
  args: { orderId: { type: 'string' } },
  async run(ctx, args) {
    if (ctx.pipe.isInPipe()) {
      let count = 0
      for await (const rec of ctx.pipe.in()) {     // 异步迭代上游记录(PipeRecord)
        if (rec.type && rec.type !== 'orders') continue   // 按来源过滤(可选)
        await ctx.post('/invoices', { orderId: rec.id })
        count++
      }
      return { data: { generated: count } }
    }
    if (!args.orderId) throw new errs.ValidationError({ param: 'orderId', message: '需要 orderId 或管道输入' })
    const res = await ctx.post('/invoices', { orderId: args.orderId })
    return { data: res.data }
  },
}),
```

**管道传引用+ID**(决策清单 #11):链中传脱敏值 + 稳定 ID,下游用 ID 关联。详见 `01-cli-usage.md`。

---

## 测试:vitest + createTestCtx

agent-cli-sdk 提供 `createTestCtx`,业务包用它 mock ctx 测 run 逻辑:

```ts
// src/commands/orders.test.ts
import { describe, it, expect } from "vitest";
import { createTestCtx, errs } from "@renxqoo/agent-cli-sdk";
import { ordersCommands } from "./orders";

describe("orders list", () => {
  it("返回订单列表", async () => {
    // ① 造 mock ctx:mock request 方法(高层 get/post 都走 request,mock 它即可覆盖)
    const ctx = createTestCtx({
      request: async (opts) => {
        if (opts.path === "/orders") {
          return { status: 200, data: { items: [{ id: "o_1", total: 100 }] }, headers: {} };
        }
        throw new Error(`unexpected ${opts.path}`);
      },
      state: {}, // 初始 state
    });
    // ② 直接调 run(ctx, args),拿返回值断言
    const result = await ordersCommands.list.run(ctx, { limit: 30, offset: 0 });
    expect(result.data).toEqual([{ id: "o_1", total: 100 }]);
  });

  it("404 抛 NotFoundError", async () => {
    const ctx = createTestCtx({ request: async () => ({ status: 404, data: {}, headers: {} }) });
    await expect(ordersCommands.get.run(ctx, { id: "x" })).rejects.toBeInstanceOf(
      errs.NotFoundError,
    );
  });
});
```

**纯函数测试**:`run(ctx, args)` 是普通函数,ctx 是注入的,mock `request` 就能测全部业务逻辑,不需要起真实 server。`createTestCtx` 还可注入 mock 的 `log`/`pipe` 等。

---

## 完整业务包示例(orders)

```ts
// src/commands/orders.ts
import { defineCommands, defineCommand, errs } from '@renxqoo/agent-cli-sdk'
import * as z from 'zod'

interface Order { id: string; total: number; status: string }
interface OrderListResult { items: Order[]; hasMore: boolean; nextCursor?: string }

export const ordersCommands = defineCommands({
  list: defineCommand({
    name: 'list', description: '查询订单列表',
    args: { schema: z.object({ limit: z.coerce.number().default(30), status: z.string().optional() }) },
    async run(ctx, args) {
      const res = await ctx.get<OrderListResult>('/orders', { limit: args.limit, ...(args.status && { status: args.status }) })
      return {
        data: res.data.items,
        meta: { pagination: { complete: !res.data.hasMore, nextToken: res.data.nextCursor } },
      }
    },
  }),
  get: defineCommand({
    name: 'get', description: '查询订单详情',
    args: { schema: z.object({ id: z.string() }), pos: ['id'] },
    async run(ctx, { id }) {
      const res = await ctx.get<Order>(`/orders/${id}`)
      if (res.status === 404) throw new errs.NotFoundError(`订单 ${id} 不存在`)
      return { data: res.data }
    },
  }),
})

// src/index.ts
#!/usr/bin/env node
import { defineCli } from '@renxqoo/agent-cli-sdk'
import { ordersCommands } from './commands/orders'
import { createCrmAuth } from './auth'

const auth = createCrmAuth<{ user: { userId: string } | null }>({
  namespace: 'orders',
  authStyle: 'bearer',
})

export default defineCli<{
  user: { userId: string } | null
}>({
  name: 'orders',
  description: '订单查询与管理',
  plugins: [auth],
  commands: ordersCommands,
  skillsDir: './skills',
})
```

---

## 开发者常犯的错(避坑)

1. **直接 `console.log` 到 stdout** → ❌ 破坏管道。用 `ctx.log`(stderr)记日志;要输出数据就 `return { data, meta }`。
2. **在 run 里处理鉴权** → ❌ 鉴权是 auth 插件的事。标准场景用 `defineAuth`，特殊协议才组合公开基础块；命令只调用 `ctx.get`。
3. **`transformOutput` 返回字符串** → ❌ 破坏管道契约。返回 StructuredData(object/array/null)。
4. **不填 `pagination.complete`** → ❌ agent 会误以为拉完了。如实填。
5. **throw 裸 Error** → ❌ 用 `errs.*` 类型化错误。裸 Error 会被兜底成 `internal/unknown`,exit code 错、agent 会误解。throw 后会进 observeError/handleError 链(插件可拦截),再渲染 stderr。
6. **把运行时状态乱塞 ctx** → ❌ ctx 没有开放扩展点(state 强类型,未声明访问报错)。运行时状态(user/traceId)由 auth 插件填到 `ctx.state`(声明过的字段),业务数据走 args 和返回值。
7. **手写 SKILL.md 命令表** → ❌ 用 `rxcli skills gen` 自动生成(见 `06-skills.md`),只手写语义部分。
8. **defineCli 写内联钩子** → ❌ 所有扩展统一成插件。内联需求写匿名插件塞 `plugins`。
