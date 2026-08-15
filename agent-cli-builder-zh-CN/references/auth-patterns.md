# 鉴权：`defineAuth` 工厂（中文）

标准 OAuth、Bearer、API key 和 Basic 优先使用 `defineAuth`。HMAC、mTLS 和复合鉴权读取 `custom-auth-plugin.md`。

## 导航

1. `defineAuth` 选项与最小用法
2. Agent 的 split-flow 登录
3. 安装向导
4. 凭证隔离与安全边界
5. 何时使用自定义插件

## 0. defineAuth 贡献了什么

`defineAuth({ ... })` 一行同时给你:

| 贡献                    | 说明                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| **4 个 auth 命令**      | `login` / `status` / `logout` / `register`(通过 `provides.namespaces.auth` 自动注入到 `<bin> auth <cmd>`) |
| **login 三分支**        | 默认阻塞轮询(人类)/ `--no-wait --json`(发起,立即返回)/ `--device-code <code>`(完成轮询,device flow 专属)  |
| **register 命令**       | 用注册令牌 + client_metadata 换独立 client(RFC 7591 snake_case 响应),写 `<dir>/config/<ns>.json`        |
| **beforeCommand 钩子**  | 跑 provider chain 取 token → 填 `ctx.credentials` / `ctx.state.user`                                      |
| **beforeRequest 钩子**  | 注入 `Authorization: Bearer`(OAuth 2.1 access token 一律 Bearer,RFC 6750)                                 |
| **401 续期 hook**       | 公开的 `handleUnauthorized`(singleflight refresh + 落盘 + 重跑 request hooks 后重试一次)                  |
| **精确豁免**            | `auth login/register` 等自动跳过自身 `beforeCommand`(不会被"必须登录"拦截)                                |
| **OAuth 2.1 三流程**    | `flow` 选项:device(RFC 8628,默认)/ authorization_code+PKCE / client_credentials                            |
| **注册 metadata 派生**  | client_name/grant_types/scope/token_endpoint_auth_method 按字段缺省派生,显式 `clientMetadata` 优先        |
| **sandbox 注入**        | `bearerToken` 一行注入预签发 JWT(priority 0,显式配置优先级最高)                                           |

### defineAuth 全部选项

```ts
const auth = defineAuth({                  // 同步工厂,禁止 await;异步装配在 apply(services)
  credentialNamespace: "crm",           // 必填:config/<ns>.json 与 credentials/<ns>.json 的隔离命名空间
  baseUrl: AUTH_BASE_URL,               // 必填:auth-proxy 地址
  scope: "orders:read offline_access",  // 可选:一份 scope,登录授权与注册声明(clientMetadata.scope)共用
  flow: "device",                       // 可选:device(默认)/ authorization_code / client_credentials
  clientMetadata: {                     // 可选:RFC 7591 注册声明;缺省字段按 flow/scope 派生
    client_name: "crm",                 //  ← 显式覆盖派生值
    redirect_uris: ["http://localhost:8080/callback"],  // authCode flow 需要
  },
  bearerToken: process.env.CRM_BEARER_TOKEN, // 可选:sandbox/CI 一行注入 JWT
  providers: [...],                     // 可选:自定义 provider chain(不传=defaultProviders)
  clientId: "...",                      // 可选:env/config 回退
  clientSecret: "...",                  // 可选
  redirectPort: 8080,                   // 可选:authCode flow 本地回调端口
  commandNamespace: "auth",             // 可选:命令命名空间(默认 auth)
});
```

工厂**不接收目录/store/localState 参数**——本地状态经 `apply(services)` 从 `defineCliApp({ dir })` 注入。

**注册 metadata 缺省派生**(显式字段优先,hasOwnProperty 判断):

| 字段                        | 缺省值                                        |
| --------------------------- | --------------------------------------------- |
| `client_name`               | `credentialNamespace`                         |
| `grant_types`               | 按 flow:device → `urn:ietf:params:oauth:grant-type:device_code refresh_token`;authorization_code → `authorization_code refresh_token`;client_credentials → `client_credentials` |
| `scope`                     | `scope`(注册声明与授权请求需要不同时显式覆盖) |
| `token_endpoint_auth_method`| `client_secret_basic`                         |

### 最小用法

```ts
import { defineCliApp, defineAuth } from "@renxqoo/agent-cli-sdk";
import { homedir } from "node:os";
import { join } from "node:path";

const app = await defineCliApp({
  name: "rxweather",
  dir: join(homedir(), ".rxweather"), // app 唯一一次目录决策
  plugins: [
    defineAuth({
      credentialNamespace: "rxweather",
      baseUrl: process.env.AUTH_BASE_URL!,
      scope: "weather:read offline_access", // 仅使用已确认的最小权限 scope
      clientMetadata: { client_name: "rxweather" },
      bearerToken: process.env.RXWEATHER_BEARER_TOKEN, // sandbox/CI 注入(可选)
    }),
  ],
  // ...
});
```

`defineAuth` 是**同步工厂**,返回 Plugin(不是 Promise),禁止 `await`。`defineCliApp` 在路由编译前自动执行插件 `apply(services)`,鉴权配置解析(读 config、可能请求 metadata)都在 apply 里完成。低层 `defineCli` 用户须手动 `await auth.apply?.({ localState, appName })`。

> 旧版 `await defineAuth({ localState })` 形态已删除,不保留兼容参数。

### 首次使用顺序

```
register(注册令牌 + client_metadata → client_id/client_secret,写 <dir>/config/<ns>.json)
   ↓
login(OAuth device flow → token,写 <dir>/credentials/<ns>.json)
   ↓
业务命令(orders list / ...)
```

跳过 register 直接 login → `device_authorization failed`(401 invalid_client)。

> **register 的 client_metadata**:RFC 7591 标准。`defineAuth({ clientMetadata: { client_name: "crm" } })` 声明后,register 命令会把它发给服务端。服务端返回 snake_case 响应(`client_id`/`client_secret`/`client_id_issued_at`/`client_secret_expires_at=0`)。

### clientId / Secret 的回填优先级

`defineAuth` 不传 `clientId/clientSecret` 时:

1. `process.env.RXCLI_CLIENT_ID` / `RXCLI_CLIENT_SECRET`(CI/临时覆盖)
2. `<dir>/config/<ns>.json`(register 写入,按 namespace 隔离——其他 app 的注册不会覆盖)
3. 空(未注册态,login 会失败提示 register)

---

## 1. agent 登录必须用 split-flow

业务 Skill 必须写明此流程，避免 agent 启动阻塞式登录后无法把授权 URL 交给用户。

```bash
# 第一步:发起(当前轮,立即返回)
my-cli auth login --no-wait --json
# → {"ok":true,"data":{"device_code":"...","verification_url":"https://...","expires_in":300,...}}
#   记住 data.device_code

# 1.5:生成二维码给用户扫码(框架自动注入的顶层 qrcode 命令)
my-cli qrcode <verification_url> --output /tmp/login-qr.png
# → 把 URL 文本 + 二维码图片一起给用户

# 第二步:用户在浏览器完成授权后,完成登录(下一轮)
my-cli auth login --device-code <第一步的 device_code>
# → stderr "✓ 登录成功:<name>",token 写入 <dir>/credentials/<ns>.json
```

**禁止**:agent 在同一轮展示 URL 后立刻跑 `--device-code`(harness 不透传中间输出,用户看不到 URL);缓存 `device_code`/`verification_url`(几分钟过期,每次重新发起)。

---

## 2. install 向导(4 步,分发 CLI 用)

向导是内部插件(`defineInstaller`),提供顶层 `install` 命令——入口**不再需要拦截**。加入 `defineCliApp` 的 plugins 即可:

```ts
const app = await defineCliApp({
  name: "rxweather",
  dir: join(homedir(), ".rxweather"),
  plugins: [
    defineAuth({ credentialNamespace: "rxweather", baseUrl: AUTH_BASE_URL }),
    defineInstaller({
      skillsSource: process.env.X_SKILLS_SOURCE,
      // auth: false,   // 无鉴权的开放数据 CLI 用:跳过 register/login 步骤
    }),
  ],
  // ...
});
// rxcli install [--lang zh|en] 是普通路由命令;入口保持 app.run(argv) 不变。
```

**4 步流程**(向导自动跑,无需手写):

1. `npm install -g <业务包名>`(由 `detectBizPackage()` 从 package.json 探测,不是问用户)
2. 装 skills:`skillsSource` 设了 → `npx skills add <url>`;空 → `<bin> skills sync`
3. `<bin> auth register`(若 `<dir>/config/` 下没有任何 clientId;`auth: false` 时跳过)
4. `<bin> auth login`(失败仅 warn,不阻断)

**传给 `defineInstaller` 的 `skillsSource` 决定 skills 怎么装**:空 → 本地 `skills/` 同步到用户已装的 agent 工具发现目录(`~/.agents` 始终写 + 探测到的已装工具);设 URL → `npx skills add`(覆盖 30+ AI 工具发现路径)。`defineCliApp`/`defineCli({ skillsSource })` 不会自动转交该配置。

---

## 3. 凭证存储路径(隔离多 CLI)

存储目录由 app 显式决定(agent-cli-sdk **无默认目录**,不自动隔离)。在同一目录内,**配置与凭证都**靠 `credentialNamespace` 区分:

```
<dir>/
├── config/<ns>.json        ← register 写入的 clientId/clientSecret(namespace 隔离)
├── credentials/<ns>.json   ← token
└── cache/updates/          ← 版本检查缓存
```

两个 CLI 用同一目录且 namespace 撞了 → **静默共用同一份凭证**,引发鉴权混乱;namespace 不同 → 注册配置互不覆盖。

**(a) 多个 CLI 共享同一目录,靠 namespace 区分**(适合同一家公司的多个 CLI,token 可复用):

```ts
const app = await defineCliApp({
  dir: join(homedir(), ".rxcli"),
  plugins: [
    defineAuth({
      credentialNamespace: "crm", // → ~/.rxcli/config/crm.json + credentials/crm.json
      baseUrl: AUTH_BASE_URL,
    }),
  ],
  // ...
});
```

**(b) 完全独立目录**(适合独立产品):

```ts
const app = await defineCliApp({
  dir: join(homedir(), ".my-cli"),
  plugins: [
    defineAuth({ credentialNamespace: "my-cli", baseUrl: AUTH_BASE_URL }),
  ],
  // ...
});
```

> agent-cli-sdk 不内置默认目录，app 用 `defineCliApp({ dir })` 决定一次；装配器把唯一 localState 经 `apply(services)` 注入 `defineAuth`、`defineInstaller`、`createUpdateNotifier`。测试使用 `defineCliApp({ localState: createMemoryLocalState(...) })`。高层 API 不保留 `store`、`configDir`、`cacheDir`、`localState` 兼容参数。

### 安全边界

- 不把 client secret、token、API key 或 refresh token 写进源码、Skill、README、日志或测试快照。
- 不让 agent 把长期密钥直接放进命令行；命令行参数可能进入 shell 历史和进程列表。优先使用受控环境变量、交互式遮罩输入或平台注入。
- `--api-key` 只适合用户明确授权的一次性覆盖；不得回显其值。
- `auth register` 省略 `--token` 时使用普通终端输入，字符**不会遮罩**；带 `--token` 又可能暴露在历史和进程列表。不要向用户索取真实生产注册令牌，让用户在私密终端自行执行，并将这一限制列为高敏环境的已知风险。
- 注册和登录会写入本地配置或凭证文件。执行前说明路径与影响，并使用已确认的最小权限 scope。
- 注册 metadata 由 `scope`/`flow`/`credentialNamespace` 缺省派生；仅当服务端要求注册声明与授权请求不同时才显式传 `clientMetadata` 字段覆盖。
- 调试认证失败时只报告 provider 来源、过期状态和缺失 scope，不打印原始凭证或认证响应。

---

## 何时不用 defineAuth(改用手写 Plugin)

| 场景                                          | 用什么                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| 标准 OAuth 2.1(device / authorization_code+PKCE / client_credentials) | `defineAuth` 工厂(本文档)                  |
| 单 Bearer 凭证(非 OAuth)                      | 手写 Plugin + `injectAuthHeader(req, token, "bearer")`          |
| API key / Basic 凭证                          | 手写 Plugin + `injectAuthHeader`(`x-api-key` / `basic`)         |
| HMAC 签名(非 header 注入,要算签名)            | 手写 auth Plugin,见 `references/custom-auth-plugin.md`          |
| mTLS(客户端证书)                              | 手写 auth Plugin + `beforeRequest` 注入证书,见同文件            |
| 复合鉴权(签名 + header)                       | 手写 auth Plugin + 签名 Plugin(`enforce:'post'`),见同文件       |

后三类读 `references/custom-auth-plugin.md`(手写 Plugin 骨架、provider chain、HMAC 例子、provider 接口)。
