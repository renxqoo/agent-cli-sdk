# 插件进阶：钩子选择、enforce 顺序、自定义插件（中文）

> 鉴权只是插件的一个用途(最常见)。其他横切关注点(签名 / 审计 / 错误归一化 / 字段脱敏 / 固定参数)都用插件实现。

## 导航

1. 钩子与执行顺序
2. 常用插件模式
3. 插件提供命令与独立发布
4. 安全调试与常见错误

## 1. 钩子 + 何时用

| 钩子                 | 何时触发                 | 能改什么                                 | 典型用途               |
| -------------------- | ------------------------ | ---------------------------------------- | ---------------------- |
| `apply`              | 装配期(路由编译前)一次   | 解析 services、填 provides、建运行时状态 | 从 `services.localState.store` 装配 auth |
| `onAppRun`           | 每次 app.run 开始        | 只观察；失败被静默隔离                   | 启动打点               |
| `afterAppRun`        | 每次 app.run 结束        | 只观察；失败被静默隔离                   | 版本感知通知           |
| `beforeCommand`      | 命令 run 前              | `ctx.state`、可 throw 中止               | auth、参数预处理       |
| `observeInput`       | Zod 校验和脱敏之后       | 只读路由、来源元数据和脱敏副本           | 输入审计、metric       |
| `beforeRequest`      | 每个物理请求 attempt 前  | 返回新的请求对象                         | header、签名、tenant   |
| `observeRequest`     | 每个物理 attempt 完成后  | 只读事件；runtime 等待副作用             | 审计、metric、请求日志 |
| `handleUnauthorized` | 收到 401 后              | 显式 `retry` / `decline` / `reject` 决策 | 上下文隔离的凭证续期   |
| `transformOutput`    | run 返回后、序列化前     | 返回新的 StructuredData                  | 脱敏、删字段、改字段名 |
| `observeError`       | 错误规范化后             | 只观察，void 不具有恢复语义              | telemetry              |
| `handleError`        | error observers 执行之后 | 显式 `pass` / `replace` / `recover` 决策 | 错误归一化或明确恢复   |

---

## 2. enforce 三档:解决钩子执行顺序

```
pre 插件(注册序)    ← 基础设置(加基础 header、auth 注入 token)
  ↓
normal 插件(注册序) ← 业务相关
  ↓
post 插件(注册序)   ← 最终包装(HMAC 签名、收尾)
  ↓
(真正执行:发请求 / 序列化输出)
```

`enforce` 支持 `"pre"`、`"normal"`、`"post"`。省略时等价于 `"normal"`；通常省略即可。

`observeInput` 只收到命令路由、输入元数据和克隆后的 `redactedArgs`，拿不到原始 JSON。通过 Zod 根 schema metadata 的 `sensitive` JSON Pointer 配置脱敏字段；observer 只做 telemetry，失败只记 warning，不改变命令结果。

app 级钩子(`onAppRun` / `afterAppRun`)每次进程运行恰一次，覆盖 help、--version、未知命令与错误路径；异常会被静默吞掉，避免改变退出码或在机器可读结果之后追加含糊 warning。它只适合可丢失的运维感知；审计事件或任何要求可靠送达的副作用不得放在这里。每次运行一次的通知(如版本感知)应放 `afterAppRun`,不要借用每条命令的观察钩子。`apply` 不属于钩子:`defineCliApp` 在路由编译前按注册序执行每个插件的 apply,任一失败 = 启动失败。

> ```ts
> {
>   name: "tenant"; /* 省略 enforce = normal */
> }
> ```

**典型配对**:

- auth Plugin `enforce:'pre'` —— 先填 token
- tenant Plugin `enforce:'pre'` —— 加固定 query(在 token 注入后、其他所有修改前)
- HMAC 签名 Plugin `enforce:'post'` —— 等所有 header/body 定型再算签名

```ts
defineCli({
  plugins: [
    auth, // enforce:'pre'(auth Plugin 内部声明)
    {
      name: "tenant",
      enforce: "pre",
      async beforeRequest(ctx, req) {
        return { ...req, query: { ...req.query, tenantId: "acme" } };
      },
    },
    {
      name: "hmac-sign",
      enforce: "post",
      async beforeRequest(ctx, req) {
        return {
          ...req,
          headers: { ...req.headers, "X-Sig": sign(req.body, ctx.state.secretKey) },
        };
      },
    },
  ],
});
```

---

## 3. 4 个常见自定义插件

### 3.1 固定 header 注入

```ts
const headerPlugin = {
  name: "fixed-headers",
  enforce: "pre" as const,
  async beforeRequest(ctx, req) {
    return {
      ...req,
      headers: { ...req.headers, "X-Client": "my-cli", "X-Version": "1.0.0" },
    };
  },
};
```

### 3.2 审计 / metric

```ts
const auditPlugin = {
  name: "audit",
  async observeRequest(ctx, event) {
    if (event.outcome.kind === "response" && event.outcome.response.status >= 400) {
      // 上报 / 写日志(走 stderr,不污染 stdout)
      ctx.log.warn(`request failed: status=${event.outcome.response.status}`);
    }
  },
};
```

### 3.3 字段脱敏(transformOutput)

```ts
const redactPlugin = {
  name: "redact",
  enforce: "post" as const,
  async transformOutput(ctx, data) {
    if (Array.isArray(data)) return data.map(redactItem);
    if (data && typeof data === "object") return redactItem(data);
    return data;
  },
};
function redactItem(item: Record<string, unknown>) {
  const out = { ...item };
  if ("email" in out) out.email = maskEmail(String(out.email));
  if ("phone" in out) out.phone = maskPhone(String(out.phone));
  return out;
}
```

**`transformOutput` 必须返回 StructuredData**(object/array/null),**不能返回 string**——否则破坏管道契约。

### 3.4 错误归一化(handleError)

```ts
import { errs } from "@renxqoo/agent-cli-sdk";

const errorNormalizePlugin = {
  name: "error-normalize",
  async handleError(ctx, err) {
    if (!(err instanceof errs.CliError)) return { action: "pass" };

    // 脱敏:防止 token 漏到 message
    if (err.message) {
      err.message = err.message.replace(/Bearer [A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
    }
    // 网络错误补 hint
    if (err instanceof errs.NetworkError && !err.hint) {
      err.hint = "检查网络连接,或稍后重试";
    }
    return { action: "replace", error: err };
  },
};
```

`observeError` 只负责 telemetry，返回 void 绝不会吞掉错误。`handleError` 必须返回显式决策：`pass` 透传、`replace` 替换、`recover` 恢复；只有 `recover` 能把失败变成成功。handler 自己失败时只记 warning，不掩盖当前业务错误。`observeRequest` 遵循相同的观察性规则。

---

## 4. 插件提供命令(provides)

插件可以**贡献命令**,defineCli 自动注入到 namespace:

```ts
const myPlugin = {
  name: "audit",
  provides: {
    namespaces: {
      audit: {
        // → my-cli audit list
        list: defineCommand({
          name: "list",
          description: "查看最近审计日志",
          async run() {
            /* ... */
          },
        }),
      },
    },
  },
  async beforeCommand(ctx) {
    /* ... */
  },
};
```

**精确豁免**:plugin 自己贡献的命令**跳该 plugin 自身的 beforeCommand**,但**不跳别的 plugin**。ownership 由每个 App 在装配期独立计算，不会修改 plugin 对象；同一个 frozen plugin 或带私有字段的 class plugin 可安全复用于多个 App。业务显式覆盖同 route 后，该命令不再被视为 plugin 自有命令。

---

## 5. 插件发布:独立 npm

横切插件可独立发 npm,多个业务包复用:

```ts
// @my-org/rxcli-plugin-tenant(独立包)
export const tenantPlugin = (tenantId: string): Plugin => ({
  name: "tenant",
  enforce: "pre",
  async beforeRequest(ctx, req) {
    return { ...req, query: { ...req.query, tenantId } };
  },
});
```

```ts
// 任意业务包用它
import { tenantPlugin } from '@my-org/rxcli-plugin-tenant'
defineCli({ plugins: [tenantPlugin('acme')], ... })
```

---

## 6. 调试:看请求链路

框架不内置 `--verbose`。需要调试时用环境变量控制插件，并且只记录请求方法、路径、状态和 request ID；不要记录认证 header、query/body 或完整响应。

```ts
const debugPlugin = {
  name: "debug",
  enforce: "pre" as const,
  async beforeRequest(ctx, req) {
    if (process.env.MYCLI_DEBUG) {
      ctx.log.info(`→ ${req.method} ${req.path}`);
    }
    return { ...req, headers: { ...req.headers } };
  },
  async observeRequest(ctx, event) {
    if (process.env.MYCLI_DEBUG && event.outcome.kind === "response") {
      ctx.log.info(`← ${event.outcome.response.status}`);
    }
  },
};
```

---

## 7. 插件常见错

1. **enforce 选错** —— HMAC 签名插件用了 `pre` 档,签名算出来 header 还没全,签名错了。改 `post`。
2. **依赖注册顺序却没测试** —— 同一 `enforce` 档按注册顺序执行；为有先后依赖的插件写生命周期测试。
3. **`transformOutput` 返回 string** —— TS 编译会拦(StructuredData 类型排除 string),但运行时报错更糟。
4. **普通错误返回 `recover`** —— 只有已证明是正常分支时才能显式恢复，其余返回 `pass` 或 `replace`。
5. **plugin 之间共享 state 字段没声明** —— `defineCommands<State>`、`Plugin<State>` 和 `defineCli<State>` 必须使用同一个状态类型；未声明字段访问会编译失败。
6. **自行实现 route ownership** —— 使用 `provides`；ownership 是框架的 App-local 内部状态，不属于公开 Plugin 字段。
7. **调试日志输出请求或响应体** —— 可能泄露 token 和业务数据；只记录最小元数据并脱敏。
