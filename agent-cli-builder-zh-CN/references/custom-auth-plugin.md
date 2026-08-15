# 自定义鉴权：手写 auth Plugin、provider chain（中文）

> 标准 OAuth、Bearer、API key 和 Basic 使用 `defineAuth`（见 `auth-patterns.md`）。仅在 `defineAuth` 无法表达时手写 auth Plugin。
>
> 何时需要:HMAC 签名、mTLS(客户端证书)、复合鉴权(签名 + header)、自定义 provider。

## 导航

1. 自定义 auth Plugin 骨架
2. Plugin 自有登录命令
3. Provider chain 与自定义 Provider
4. HMAC 签名
5. 401 自动续期

自定义实现依赖更多底层 API。固定框架版本，并为 provider 优先级、凭证落盘、401 重试和日志脱敏写端到端测试；标准场景不要复制本骨架。

## 0. auth Plugin 是什么

auth Plugin 就是一个普通的 `Plugin` 对象,用 agent-cli-sdk 导出的基础块组装。3 个出口的职责:

| 出口                 | 做什么                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `beforeCommand`      | 跑 provider chain 取 token → 包装 store 成 `ctx.credentials` → 建立上下文隔离会话 |
| `beforeRequest`      | 用 `injectAuthHeader(req, token, authStyle)` 按 style 注入 header                  |
| `handleUnauthorized` | 公开 hook；401 时 singleflight refresh、更新上下文会话并重试一次                  |

---

## 1. 手写 auth Plugin 骨架

```ts
// src/auth.ts
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

export function createMyAuth<State extends { user?: unknown }>(opts: {
  namespace: string;
  authStyle?: "bearer" | "x-api-key" | "basic";
  oauth?: { baseUrl: string; clientId: string; clientSecret: string };
}): Plugin<State> {
  const authStyle = opts.authStyle ?? "bearer";
  const sessions = new WeakMap<CommandContext<State>, { token: string; refreshable: boolean }>();

  // 装配期状态:apply 里从 services.localState.store 解析后填入(工厂不收目录/store 参数)。
  let ready!: {
    store: ConfigStore;
    providers: ReturnType<typeof defaultProviders>;
    refresh?: () => Promise<Record<string, unknown> | null>;
  };

  return {
    name: `auth:${opts.namespace}`,
    enforce: "pre", // 鉴权必须 pre,先填 token 再发请求

    async apply(services) {
      const store = services.localState.store;
      ready = {
        store,
        providers: defaultProviders(),
        refresh: opts.oauth
          ? createOn401Hook({ cfg: opts.oauth, store, namespace: opts.namespace })
          : undefined,
      };
    },

    async beforeCommand(ctx: CommandContext<State>) {
      const { store, providers } = ready;
      const pctx: ProviderContext = {
        namespace: opts.namespace,
        configStore: store,
        args: {},
        env: process.env,
      };
      const resolved = await resolveWithChain(providers, pctx);
      if (!resolved) {
        throw new AuthenticationError({
          subtype: "no_credentials",
          message: `${opts.namespace} 未配置凭证`,
          hint: `设置 \${opts.namespace.toUpperCase()}_API_KEY 环境变量或运行 \`my-cli auth login\``,
        });
      }

      // 把 store 包装成 ctx.credentials(命令运行时 API)
      (ctx as { credentials: typeof ctx.credentials }).credentials = {
        get: async (ns) => (await store.loadCredentials(ns)) as Record<string, string> | null,
        save: (ns, d) => store.saveCredentials(ns, d),
        clear: (ns) => store.clearCredentials(ns),
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
      if (!ready.refresh || !session?.refreshable) return { action: "decline" };
      const token = await ready.refresh();
      if (!token) {
        return {
          action: "reject",
          error: new AuthenticationError({
            subtype: "token_expired",
            code: 401,
            message: "认证已过期且刷新失败",
            hint: "请重新登录",
          }),
        };
      }
      sessions.set(ctx, { ...session, token });
      return { action: "retry" };
    },
  };
}
```

用法(`defineCliApp` 自动执行 apply):

```ts
// src/index.ts
import { createMyAuth } from './auth.js'
const app = await defineCliApp({
  dir: appStateDir,
  plugins: [
    createMyAuth({
      namespace: 'my-cli',
      authStyle: 'bearer',
      oauth: { baseUrl: process.env.AUTH_BASE_URL!, clientId: process.env.CLIENT_ID!, clientSecret: process.env.CLIENT_SECRET! },
    }),
  ],
  ...
})
```

### provides 的 login/logout 命令:直接用 `store`,不用 `ctx.credentials`

上面的骨架在 `beforeCommand` 里把 `store` 包装成了 `ctx.credentials`。但若通过 `provides` 贡献 login/logout 命令,这些命令会被框架精确豁免自身 beforeCommand——豁免后 `ctx.credentials` 是框架默认的 no-op(`save`/`clear` 空跑),login 调 `ctx.credentials.save()` 不会写入任何内容。

**正确写法**:login/logout 直接用闭包里的 `store`(和 `defineAuth` 工厂内部一致),不经过 `ctx.credentials`:

```ts
// 正确:login/logout 直接用 store 落盘
const authCommands = defineCommands({
  login: defineCommand({
    name: "login",
    description: "从受控环境变量保存 API key",
    async run() {
      const apiKey = process.env.MY_CLI_API_KEY;
      if (!apiKey) {
        throw new errs.ConfigError({
          subtype: "unbound_env",
          message: "缺少 MY_CLI_API_KEY",
          hint: "在当前进程环境中设置 MY_CLI_API_KEY 后重试",
        });
      }
      await store.saveCredentials(opts.namespace, { apiKey });
      return { data: { saved: true } };
    },
  }),
  logout: defineCommand({
    name: "logout",
    async run(_ctx, _args) {
      await store.clearCredentials(opts.namespace);
      return { data: { cleared: true } };
    },
  }),
});

// plugin 里 provides 这组命令
return {
  name: `auth:${opts.namespace}`,
  enforce: "pre",
  provides: { namespaces: { auth: authCommands } },
  async beforeCommand(ctx) {
    /* ... 见上面骨架 ... */
  },
  async beforeRequest(ctx, req) {
    return { ...req, headers: { ...req.headers } };
  },
};

// 错误:login 里用 ctx.credentials.save()
//   login 被 provides 豁免 beforeCommand → ctx.credentials 是 no-op → 不落盘
//   async run(ctx, args) { await ctx.credentials.save(...) }  // ← bug
```

> 判断规则:**`provides` 贡献的命令里,凭证读写一律用 `store`(闭包),不用 `ctx.credentials`**。`ctx.credentials` 只在业务命令(非 plugin provides)里可靠——此时 beforeCommand 已跑过,包装已生效。

不要把长期密钥设计成 `login --secret <value>`；命令行参数可能出现在 shell 历史和进程列表。使用受控环境变量或自行实现的交互式遮罩输入，且成功输出只返回保存状态，不返回密钥。

---

## 2. provider chain 怎么工作

```ts
resolveWithChain(providers, pctx) 按 priority 升序逐个尝试:
  flagProvider       (priority 1)  → defineAuth 可接收 --api-key <key> 全局 flag(临时覆盖)
  envProvider        (priority 5)  → $NS_API_KEY 环境变量
  envBearerProvider  (priority 6)  → $NS_BEARER_TOKEN 环境变量(sandbox/CI 注入的 JWT)
  fileProvider       (priority 10) → ~/.rxcli/credentials/<ns>.json 的 apiKey/token
  oauthProvider      (priority 20) → 同一文件里的 OAuth token(含 refresh_token)
```

**命中即停**:第一个返回非 null 的 provider 用它的 token;全 null → auth Plugin 抛 `AuthenticationError`。

上面的手写骨架把 `ProviderContext.args` 设为空对象，因此不支持框架级 `--api-key`；该参数通过内部通道仅交给 `defineAuth`。自定义插件使用环境变量、文件或自定义 provider，不要宣称支持未接入的 flag。

`defaultProviders()` 默认装好这 5 个(含 envBearerProvider)。**业务包通常不用关心**——只有自定义鉴权(HMAC/mTLS)时才自己 `providers = [...defaultProviders(), customProvider]`。

> **sandbox/CI 场景**:admin 通过 `POST /admin/web/issue-token` 签发 JWT → 注入环境变量 `NS_BEARER_TOKEN`(如 `CRM_BEARER_TOKEN`)→ envBearerProvider 自动命中,agent 直接用,不需要 device flow 登录。也可用 `defineAuth({ credentialNamespace, baseUrl, bearerToken: process.env.CRM_BEARER_TOKEN, ... })` 显式注入(priority 0,优先级最高)。

### provider 接口(写自定义 Provider 时用)

```ts
export interface CredentialProvider {
  name(): string; // provider 名(日志/溯源)
  priority?(): number; // 优先级,小值先试,默认 10
  resolveToken(pctx: ProviderContext): Promise<TokenResult | null>; // null = 没有,chain 继续
  resolveIdentity?(pctx: ProviderContext): Promise<IdentityHint | null>; // 可选:填统一输出格式顶层的 user/bot
}

export interface ProviderContext {
  namespace: string; // 命名空间
  configStore: ConfigStore; // 直接读写文件(不走 chain)
  args: Record<string, unknown>; // 命令参数(读 --api-key 等)
  env: NodeJS.ProcessEnv; // 环境变量
}

export interface TokenResult {
  token: string;
  type: "api-key" | "bearer" | "basic" | "custom";
  scopes?: string[];
  source: string; // 来源描述
  expiresAt?: number;
  refreshToken?: string;
}
```

**注意区分两个 API**:

- `ctx.credentials.get/save/clear` —— 业务运行时用(走 provider chain)
- `configStore.loadCredentials/saveCredentials` —— provider 内部用(直读文件,不走 chain)

---

## 3. 自定义 Provider(HMAC 例子)

```ts
// src/hmac-provider.ts
import type { CredentialProvider, ProviderContext, TokenResult } from "@renxqoo/agent-cli-sdk";

export class HmacProvider implements CredentialProvider {
  constructor(private opts: { namespace: string; accessKeyId?: string }) {}
  name() {
    return "hmac";
  }
  priority() {
    return 15;
  } // 在 file(10)之后、oauth(20)之前

  async resolveToken(pctx: ProviderContext): Promise<TokenResult | null> {
    const creds = await pctx.configStore.loadCredentials(this.opts.namespace);
    if (!creds?.accessKey || !creds?.secretKey) return null;
    return { token: creds.accessKey as string, type: "custom", source: "hmac" };
  }
}
```

签名单独写一个 `enforce:'post'` 插件(post 档 = 等所有 header 定型后再签名):

```ts
// src/hmac-sign-plugin.ts
import { createHmac } from "node:crypto";
import type { Plugin } from "@renxqoo/agent-cli-sdk";

export function hmacSignPlugin(namespace: string): Plugin {
  return {
    name: "hmac-sign",
    enforce: "post",
    async beforeRequest(ctx, req) {
      const creds = await ctx.credentials.get(namespace);
      if (!creds?.secretKey) return { ...req, headers: { ...req.headers } };
      const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? "");
      const sig = createHmac("sha256", creds.secretKey as string)
        .update(`${req.method}\n${req.path}\n${body}`)
        .digest("hex");
      return { ...req, headers: { ...req.headers, "X-Signature": sig } };
    },
  };
}
```

用法:

```ts
defineCli({
  plugins: [
    createMyAuth({ namespace: "my-cli", authStyle: "x-api-key" }),
    hmacSignPlugin("my-cli"),
  ],
});
```

---

## 4. 401 自动续期(singleflight)

**业务包不处理 401**,agent-cli-sdk 请求层自动:

1. 收到 401 → 调公开的 `handleUnauthorized` hook
2. hook 用 `createOn401Hook({ cfg, store, namespace })` 创建,内部:
   - 读当前凭证拿 refreshToken
   - 用 singleflight(同一 refreshToken 复用同一个 refresh Promise,避免并发重复 refresh)
   - 续期成功后**落盘**
3. 拿到新 token → 重试一次原请求
4. 重试仍 401 → 抛 `AuthenticationError(token_expired)`,触发用户重新登录

**前提**:auth Plugin 必须实现 `handleUnauthorized`。没实现的 auth Plugin 不支持 401 自动续期。token 必须放在 `CommandContext` 绑定的 auth session，禁止用插件闭包保存；同一个插件实例会服务并发的 `App.run()`。

重试会先替换现有认证 header(大小写不敏感),并重新执行全部 `beforeRequest` hook,因此 Bearer / X-Api-Key / Basic 以及 HMAC nonce、时间戳、签名都会按新 token 重算。任何最终 401 都是认证错误,不会因为遗漏 `errorOnStatus` 而被当成成功响应。

`--api-key <key>` 是框架级一次性凭证,只定向提供给 auth provider chain,不会混入业务命令 args 或暴露给其他 telemetry/plugin hook;裸 `--api-key` 会在命令运行前得到 validation 错误。
