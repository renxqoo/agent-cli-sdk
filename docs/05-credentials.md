# 05 · 凭证与认证(auth 是 Plugin)

> 标准 OAuth、Bearer、API key 和 Basic 认证优先使用 `defineAuth`。只有 HMAC、mTLS 或复合协议才手写 Plugin；自定义实现必须按 `CommandContext` 隔离 session，并通过显式 `handleUnauthorized` 决策重试。

---

## 认证的两层分工

| 层                 | 干什么                                   | 谁负责                                                |
| ------------------ | ---------------------------------------- | ----------------------------------------------------- |
| **拿 token**(凭证) | 从哪取 key/token(flag/env/file/keychain) | provider chain(由 auth Plugin 调 `resolveWithChain`)  |
| **用 token**(注入) | 把 token 塞进请求 header(bearer/api-key) | auth Plugin 的 `beforeRequest` 调 `injectAuthHeader` |

**这两层都由 auth Plugin 编排**。标准场景由 `defineAuth` 创建完整插件；特殊协议可使用下列基础块自行组合。插件通过 beforeCommand 解析凭证、通过 beforeRequest 返回新请求，并用 context-keyed session 隔离并发请求。

---

## agent-cli-sdk 出的基础块

从主包 `@renxqoo/agent-cli-sdk` import,无需子路径:

| 基础块                                                                                                                                                        | 作用                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `createLocalState({ dir })` / `createMemoryLocalState()`                                                                                                      | app 统一的本地状态(含 `ConfigStore`)                                 |
| `defaultProviders()` / `flagProvider` / `envProvider` / `envBearerProvider` / `fileProvider` / `oauthProvider`                                                | provider chain 的默认 provider(默认 5 个)                            |
| `resolveWithChain(providers, pctx)`                                                                                                                           | 跑 chain 取 `TokenResult`(命中即停)                                  |
| `resolveIdentityWithChain(providers, pctx)`                                                                                                                   | 跑 chain 取 `IdentityHint`(统一输出格式顶层 user/bot)                |
| `injectAuthHeader(req, token, style)`                                                                                                                         | 按 authStyle(`bearer`/`x-api-key`/`basic`)注入 header                |
| `createOn401Hook({cfg, store, namespace})`                                                                                                                    | 401 singleflight refresh 原语(由公开 `handleUnauthorized` hook 调用) |
| `deviceAuthorization` / `pollDeviceToken` / `getUserInfo` / `revokeToken` / `registerClient`                                                                    | OAuth 2.1 端点原语(device 设备授权 + 用户信息/吊销/注册)             |
| 类型:`Plugin` / `CredentialsApi` / `CommandContext` / `ProviderContext` / `TokenResult` / `IdentityHint` / `ConfigStore` / `CredentialProvider` / `AuthStyle` | —                                                                    |

**优先使用 `defineAuth`。** 下列基础块用于 HMAC、mTLS、复合认证或自定义 provider，不应在普通 OAuth 场景重复造轮子。

---

## 如何写 auth Plugin

参考实现见 `apps/crm/src/auth.ts` 的 `createCrmAuth`。下面是骨架(完整可运行版见 `02-sdk-guide.md` 的"如何写 auth Plugin"):

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
  const authStyle = opts.authStyle ?? "bearer";
  const sessions = new WeakMap<CommandContext<State>, { token: string; refreshable: boolean }>();

  // 装配期状态:apply 里从 services.localState.store 解析后填入(工厂不收目录/store 参数)。
  let ready!: {
    store: ConfigStore;
    providers: ReturnType<typeof defaultProviders>;
    on401?: () => Promise<Record<string, unknown> | null>;
  };

  return {
    name: `auth:${opts.namespace}`,
    enforce: "pre",

    async apply(services) {
      const store = services.localState.store;
      ready = {
        store,
        providers: defaultProviders(),
        on401: opts.oauth
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
      const resolved = await resolveWithChain(providers, pctx); // ① provider chain 取 token
      if (!resolved)
        throw new AuthenticationError({
          subtype: "no_credentials",
          message: "未配置凭证",
          hint: "设置 XXX_API_KEY 环境变量",
        });
      // ② 包装 store 成 ctx.credentials;③ 注入 scopes;④ 取 identity 填 state.user
      // ⑤ 缓存 token 供 beforeRequest 用
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

| 出口                 | 在 auth Plugin 里做什么                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `beforeCommand`      | 跑 provider chain 取 token;包装 `store` 成 `ctx.credentials`;建立 context-keyed session |
| `beforeRequest`      | 用 `injectAuthHeader(req, token, authStyle)` 按 authStyle 注入 header                   |
| `handleUnauthorized` | 调 `createOn401Hook(...)`;成功后更新 session 并返回 `{ action: "retry" }`               |

**关键纪律:**

- 认证用 `beforeCommand` + `beforeRequest` 两个标准钩子,不发明新机制。
- token 使用 `WeakMap<CommandContext, Session>` 等 context-keyed 结构隔离，避免并发命令间串。
- 401 refresh 是请求层(框架)的能力,但**执行能力**(怎么 refresh、怎么落盘)由 auth Plugin 通过 `on401` 提供。没挂 `on401` 的 auth Plugin 不支持 401 自动续期。
- 业务包可完全不参考 `createCrmAuth` 骨架自己写——只要遵守 `Plugin` 接口和上面的契约。

完整带注释版本(含 credentials 包装、scopes、identity)见 `02-sdk-guide.md` 的"如何写 auth Plugin"小节和 `apps/crm/src/auth.ts`。

---

## provider chain 的内部机制

> 这一节讲 `resolveWithChain` 内部怎么取 token。**业务包写 auth Plugin 时通常用 `defaultProviders()` 就够**——只有要自定义鉴权(HMAC/mTLS 等)时才需要理解 provider 接口、自己加 provider。

### chain 设计:按 priority 逐个尝试

```
resolveWithChain(providers, pctx) 按 priority 从小到大依次调用 provider:
  provider[0] (priority=1, flag)       → 命中?用它的 token
  provider[1] (priority=5, env api-key) → 命中?用
  provider[2] (priority=6, env bearer) → 命中?用
  provider[3] (priority=10, file)      → 命中?用
  provider[4] (priority=20, oauth)     → 命中?用
  全都没命中 → 返回 null(auth Plugin 据此抛 AuthenticationError,触发首次引导)
```

**命中即停**:一旦某个 provider 返回有效 token,后续 provider 不再调用。priority 值小的先试(对齐 lark-cli:小值优先,默认 10)。

### 默认 provider(`defaultProviders()` 自带 5 个)

`defaultProviders()` 返回这 5 个:

| Provider            | priority | 从哪取                                                      | 适用                     |
| ------------------- | :------: | ----------------------------------------------------------- | ------------------------ |
| `flagProvider`      |    1     | `--api-key <key>` 全局 flag                                 | 临时覆盖(单次命令)       |
| `envProvider`       |    5     | `$<NS>_API_KEY` 环境变量(`NS` = 命名空间大写)               | CI/容器                  |
| `envBearerProvider` |    6     | `$<NS>_BEARER_TOKEN` 环境变量                               | 预签发 JWT / sandbox     |
| `fileProvider`      |    10    | `~/.rxcli/credentials/<ns>.json` 的 `apiKey` 字段           | 持久化(默认主路径)       |
| `oauthProvider`     |    20    | `~/.rxcli/credentials/<ns>.json` 的 OAuth token(含 refresh) | OAuth 流程(rxcli 中间层) |

> 业务包通常不用关心这些——`defaultProviders()` 默认装好这 5 个。只有要自定义鉴权时才自己 `providers = [...defaultProviders(), customProvider]`(注意:priority 决定插入位置)。

### Provider 接口(自定义鉴权用)

```ts
export interface CredentialProvider {
  name(): string; // provider 名(日志/溯源)
  priority?(): number; // 优先级,小值先试,默认 10
  resolveToken(pctx: ProviderContext): Promise<TokenResult | null>; // null = 没有,chain 继续
  resolveIdentity?(pctx: ProviderContext): Promise<IdentityHint | null>;
}

export interface ProviderContext {
  namespace: string; // 命名空间
  configStore: ConfigStore; // agent-cli-sdk 的配置存储(直接读写文件,不走 chain)
  args: Record<string, unknown>; // 命令参数(读 --api-key 等)
  env: NodeJS.ProcessEnv; // 环境变量
}

export interface TokenResult {
  token: string;
  type: "api-key" | "bearer" | "basic" | "custom";
  scopes?: string[];
  source: string; // 来源描述(如 'env:ORDERS_API_KEY')
  expiresAt?: number; // 过期时间戳(ms)
  refreshToken?: string; // OAuth 的刷新 token
}
```

> **注意**:provider 的参数是 `ProviderContext`(命名 `pctx`),不是命令的 `CommandContext`。它有 `configStore`(直接读写文件),用于 provider 内部取凭证。

### 自定义 provider 示例(HMAC)

```ts
// src/hmac-provider.ts
export class HmacProvider implements CredentialProvider {
  constructor(private opts: { namespace: string }) {}
  name() {
    return "hmac";
  }
  priority() {
    return 15;
  } // 在 file(10)之后,oauth(20)之前

  async resolveToken(pctx: ProviderContext): Promise<TokenResult | null> {
    const creds = await pctx.configStore.loadCredentials(this.opts.namespace);
    if (!creds?.accessKey || !creds?.secretKey) return null; // 没有,chain 继续
    return { token: creds.accessKey, type: "custom", source: "config:hmac" };
  }
}
```

用的时候塞进 auth Plugin 的 providers(在 `createCrmAuth` 里改成 `providers = [...defaultProviders(), new HmacProvider(...)]`):

```ts
// 在 auth Plugin 工厂里(简化)
const providers = [...defaultProviders(), new HmacProvider({ namespace: opts.namespace })];
const resolved = await resolveWithChain(providers, pctx);
```

如果 HMAC 还要算签名塞 header,在 auth Plugin 的 `beforeRequest` 里加,或单独写一个签名插件(enforce:'post',在所有 header 加完后签名):

```ts
const signPlugin = {
  name: "hmac-sign",
  enforce: "post",
  async beforeRequest(ctx, req) {
    const creds = await ctx.credentials.get("orders");
    return {
      ...req,
      headers: { ...req.headers, "X-Signature": hmacSign(req.body, creds.secretKey) },
    };
  },
};

defineCli({ plugins: [auth, signPlugin], ... })
```

> **关键区别**:auth Plugin 管"取 token + 注入认证 header"(标准鉴权);签名插件管"非标准签名"(HMAC/mTLS)。两者配合,不冲突。

---

## provider chain 与插件的关系

| 扩展类型                                         | 机制                                      | 入口                           |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------ |
| **认证**(取 token、注入 header、填 user)         | `defineAuth`；特殊协议使用 provider chain | 把返回的 Plugin 放进 `plugins` |
| **非认证横切**(固定参数、签名、格式、错误、审计) | 普通插件钩子                              | 直接写 Plugin 对象塞 plugins   |

**provider chain 由 agent-cli-sdk 的 `resolveWithChain`/`resolveIdentityWithChain` 提供**,业务包不直接调 `credentials.register()`(已取消)。认证全部走自写的 auth Plugin(它调 provider chain),非认证横切用普通插件,不走 provider chain。

---

## 凭证存储

app 通过 `defineCliApp({ dir })` 只决定一次根目录。装配器创建唯一的 localState 并注入每个插件;其内的 ConfigStore 统一管理配置与凭证,更新通知使用同一根目录下的可删除缓存:

```
<dir>/
├── config/
│   ├── orders.json                     ← orders 的应用配置(注册 clientId 等)
│   └── invoices.json                   ← 按 namespace 隔离,互不覆盖
├── credentials/
│   ├── orders.json                     ← orders 的凭证(namespace 决定)
│   └── invoices.json
└── cache/
    └── updates/                        版本检查缓存
```

**配置与凭证都按业务包命名空间隔离**(auth Plugin 的 `credentialNamespace`),权限 `0600`。多个 CLI app 共用一个根目录时,注册配置互不覆盖。

> **安全契约**:
> - 凭证与配置以**明文 at-rest** 存储,仅依赖文件系统权限保护(不做混淆/加密)。如需 at-rest 加密,请在 OS keychain 等外部保管。
> - `0600`(文件)/ `0700`(目录)仅在 **POSIX** 生效;Windows 不支持 chmod,文件 ACL 继承父目录。
> - 存储目录由业务 app 通过 `defineCliApp({ dir })` 显式决定一次;`defineAuth`、`createUpdateNotifier`、`defineInstaller` 经 `apply(services)` 收到同一个 localState。agent-cli-sdk **不内置默认目录**,高层 API 一律不接收目录参数。
> - 凭证/配置文件读取走与命令输入相同的**严格有界解析器**(拒绝重复键、unsafe 键,限制深度/大小)。
> - OAuth refresh 的「读 → 换 token → 写」事务由**跨进程文件锁**保护(`ConfigStore.withLock`),避免并发 CLI 互相覆盖丢失更新。

### 凭证文件结构

```json
{
  "apiKey": "sk_xxx",
  "token": "ey...",
  "refreshToken": "ry...",
  "expiresAt": 1735689600000,
  "scopes": ["orders:read", "orders:write"],
  "user": { "openId": "u_1", "name": "alice" },
  "storedAt": 1735686000000,
  "authMethod": "oauth"
}
```

字段都可选——OAuth 用 `token`/`refreshToken`/`expiresAt`,API key 用 `apiKey`,HMAC 用自定义字段(`accessKey`/`secretKey`)。agent-cli-sdk 不强制结构。

### 业务包运行时读写凭证

业务包在 `run(ctx, args)` 里通过 `ctx.credentials` 读写(auth Plugin 在 beforeCommand 把 store 包装成这个 API):

```ts
// 读(优先走 provider chain,命中即返;都没命中返回 null)
const creds = await ctx.credentials.get("orders");

// 写(登录成功后,绕过 chain 直接落盘)
await ctx.credentials.save("orders", {
  token: "...",
  refreshToken: "...",
  expiresAt: Date.now() + 3600000,
});

// 清(登出)
await ctx.credentials.clear("orders");
```

> **注意区分两个层**:`ctx.credentials.*` 是命令运行时用的(走 provider chain);provider 内部用 `ProviderContext.configStore`(直接读写文件,不走 chain)。前者是业务包面向用户的 API,后者是 provider 实现者的 API。

### ConfigStore 接口(provider 实现者用)

`ProviderContext.configStore` 是 agent-cli-sdk 的配置/凭证存储抽象,直接读写磁盘文件(不走 provider chain)。接口:

```ts
export interface ConfigStore {
  loadCredentials(namespace: string): Promise<Record<string, unknown> | null>; // null = 文件不存在
  saveCredentials(namespace: string, data: Record<string, unknown>): Promise<void>; // 权限 0600
  clearCredentials(namespace: string): Promise<void>;
  loadConfig(namespace: string): Promise<Record<string, unknown>>; // <dir>/config/<ns>.json,不存在 = {}
  saveConfig(namespace: string, data: Record<string, unknown>): Promise<void>; // 整体替换,权限 0600
  withLock<T>(namespace: string, fn: () => Promise<T>): Promise<T>; // 凭证读-改-写事务锁
}
```

**两层 API 对照(方法名故意不同,避免混用):**

| 层            | API                                               | 在哪用                            | 走不走 chain                       |
| ------------- | ------------------------------------------------- | --------------------------------- | ---------------------------------- |
| 业务运行时    | `ctx.credentials.get/save/clear`                  | 命令 `run` 内、签名插件           | ✅ 走 provider chain(get 命中即返) |
| provider 实现 | `configStore.loadCredentials/saveCredentials/...` | `CredentialProvider` 内部、首引导 | ❌ 直读文件                        |

> provider 实现者用 `configStore.loadCredentials`;业务包/命令用 `ctx.credentials.get`。两者语义不同(一个直读、一个走链),方法名风格区分开,避免误用。

---

## 首次引导

provider chain 全都没命中时,auth Plugin 抛 `AuthenticationError`,agent-cli-sdk 触发首次引导(交互式 TTY 才触发,CI/非交互环境直接报错):

```bash
$ rxcli-orders list
⚠ orders 需要配置凭证(存储到 ~/.rxcli/credentials/orders.json,权限 0600)
  API Key: ********
  Secret Key: ********
✓ 凭证已保存
{ "ok": true, "data": [...] }
```

引导文案可由业务包注入(通过 defineCli 的 `messages.credentialsPrompt`)。非交互环境(agent 场景)不引导,直接返回错误输出 + hint:

```json
{
  "ok": false,
  "error": {
    "type": "authentication",
    "subtype": "no_credentials",
    "message": "orders 业务包未配置凭证",
    "hint": "run `rxcli-orders config set apiKey <your-key>` 配置 API key"
  }
}
```

---

## 凭证脱敏(日志纪律)

凭证值**绝不**进 stdout/stderr 的可见输出。agent-cli-sdk 强制:

- `ctx.log` 打印请求时,认证 header 自动脱敏:`Authorization: Bearer ey...` → `Authorization: Bearer [REDACTED]`
- 错误消息里若混入凭证,`handleError` 插件要脱敏(见 `04-errors.md`)
- `verbose` 模式打印请求详情时,认证字段用 `[REDACTED]` 占位

```bash
$ rxcli-orders list --verbose 2>&1 | grep -i auth
> Auth: Bearer [REDACTED]     # ← 永远看不到真实 token
```

> 注:本框架不实现完整的字段级脱敏特性(决策清单 #14),但**凭证本身的日志脱敏是底线**,从第一版就强制。

---

## 凭证系统的设计要点

| 传统做法                       | 本框架                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadCredentials()` 读固定文件 | `ctx.credentials.get(namespace)` 按命名空间读(走 provider chain)                                                                                           |
| 固定优先级链                   | `resolveWithChain` + `defaultProviders()`(默认 5 个 provider)                                                                                              |
| OAuth token 续期硬编码         | 401 检测 + singleflight 复用在框架**请求层**;refresh 执行能力由 auth Plugin 的 `createOn401Hook` 提供。两者协作(详见 `04-errors.md` 的"关于 401 自动续期") |
| 单一中间层 baseUrl             | 业务包各自声明 baseUrl(defineCli 配置),ConfigStore 只管凭证                                                                                                |
| 固定认证实现                   | `defineAuth` 覆盖标准场景；特殊协议通过公开 Plugin 与基础块扩展                                                                                            |

---

## 常见鉴权方式接入指南

| 鉴权方式                    | 怎么写 auth Plugin                                                          | 业务包要做什么               |
| --------------------------- | --------------------------------------------------------------------------- | ---------------------------- |
| OAuth(rxcli 中间层)         | `defineAuth`；自定义时用 context-keyed session + 公开 `handleUnauthorized`  | 优先使用框架工厂             |
| Bearer token                | 同上(去掉 on401)                                                            | 同上                         |
| API key(`X-Api-Key` header) | authStyle `'x-api-key'`                                                     | 同上,默认 provider 覆盖      |
| Basic Auth                  | authStyle `'basic'`                                                         | provider 存 user/pass        |
| HMAC 签名                   | auth Plugin 用自定义 `HmacProvider` 取 token;签名单独写 enforce:'post' 插件 | 实现 HmacProvider + 签名逻辑 |
| mTLS                        | 自定义 provider(读证书路径) + beforeRequest 注入证书                        | 实现证书加载                 |

### authStyle 配置

API key 和 Bearer 都是默认 provider 支持的,区别在塞进哪个 header。authStyle 传给 `injectAuthHeader(req, token, style)`:

```ts
injectAuthHeader(req, token, "bearer"); // → Authorization: Bearer xxx(默认)
injectAuthHeader(req, token, "x-api-key"); // → X-Api-Key: xxx
injectAuthHeader(req, token, "basic"); // → Authorization: Basic base64(user:pass)
```

authStyle 在 auth Plugin 工厂里由 opts 传入(如 `createCrmAuth({ authStyle: 'bearer' })`)。
