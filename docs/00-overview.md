# 00 · 架构总览

> 本文档是 agent-cli-sdk 的设计锚点。所有后续文档(命令使用、SDK 指南、统一输出格式、错误、凭证、skill)都以本文档的全局决策为准,实现不允许偏离。

---

## 一句话定位

**`@renxqoo/agent-cli-sdk` 是一个 agent-native CLI 框架包:业务包依赖它,只用声明"调哪个后端接口、字段怎么处理",就能获得鉴权、脱敏、统一输出格式、错误分类、管道组合、skill 发现等全套能力。**

它解决的核心矛盾是:**后端接口千差万别(REST/GraphQL/RPC、OAuth/API-key/mTLS、各种字段命名),但"把数据交给 agent 的方式"是通用的。** 框架把前者交给业务包,后者收敛成框架能力。

---

## 设计要点

| 维度       | 做法                                                         |
| ---------- | ------------------------------------------------------------ |
| 形态       | **SDK 框架**:agent-cli-sdk(本仓库)+ 业务包独立 npm |
| 业务包接入 | 别人写独立 npm 包,依赖 agent-cli-sdk                          |
| 编程风格   | **function 风格 + 配置对象声明**(defineCli/defineCommand)    |
| 输出       | **统一统一输出格式**(成功 stdout / 错误 stderr)              |
| 错误       | **9 类类型化错误 + exit code 映射 + 结构化统一输出格式**     |
| 凭证       | **provider chain**,可扩展任意鉴权方式                        |
| 管道       | **unix 管道**,传引用+ID,本地过滤交 jq                        |
| 上百接口   | **拆文件组装**(按业务域 namespaces 聚合)                     |
| skill      | **从 defineCommands 自动生成命令文档** + 人工语义区          |

---

## 三层架构

```
┌──────────────────────────────────────────────────────────────┐
│  agent / 终端用户                                              │
│  ─ 用 unix 管道组合命令                                         │
│  ─ 读 skill 自服务发现命令                                      │
│  ─ 解析 stdout 统一输出格式拿数据,看 stderr 统一输出格式处理错误               │
├──────────────────────────────────────────────────────────────┤
│  业务包(独立 npm,@org/rxcli-xxx)                            │
│  ─ 写 function 风格命令(defineCommand,带 <Args,Result> 泛型)│
│  ─ 用 ctx.get/post 请求(无 client 层)                       │
│  ─ 写插件(标准认证用 defineAuth,特殊协议组合基础块)          │
│  ─ 写 SKILL.md(语义部分,命令表自动生成)                     │
│  ─ 业务知识全在这层,agent-cli-sdk 不懂业务                          │
├──────────────────────────────────────────────────────────────┤
│  @renxqoo/agent-cli-sdk(基础包,本仓维护)                          │
│  ─ ctx 请求方法(get/post/...,带鉴权 + 401 自动续期)         │
│  ─ 统一输出格式:成功/失败的统一输出契约                                │
│  ─ 错误分类:9 类 + exit code + 类型化构造器                   │
│  ─ 认证:defineAuth 标准工厂 + 可组合认证基础块                │
│  ─ 插件系统:vite 式 Plugin + 6 钩子 + enforce 三档            │
│  ─ 管道:PipeRecord 类型 + stdin/stdout                       │
│  ─ skill:list/read/sync + 命令文档自动生成                    │
│  ─ 配置:ConfigStore(按 namespace 隔离凭证,业务包各自 baseUrl) │
└──────────────────────────────────────────────────────────────┘
```

**关键边界:agent-cli-sdk 不懂业务,业务包不懂框架细节。** 两者的契约面是 `ctx`(命令运行时上下文)和"统一输出格式"。

---

## 三个参考实现

设计借鉴了两个工业级 CLI,每个借鉴的方面不同:

| 参考                          | 借鉴点                                                                                                                 | 为什么                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **mmx**(MiniMax CLI, TS)      | client 能力复用、SDK/CLI 共享请求层、凭证解析优先级链、exit code 体系                                                  | 单一后端的 SDK 形态范本        |
| **lark-cli**(飞书 CLI, Go)    | 结构化错误输出(RFC 7807)、成功输出 + pagination meta、provider chain、skill 系统、stdout/stderr 纪律、命令文档自动生成 | agent-first CLI 框架的治理范本 |
| ** rxcli 前版**(本作者前一版) | device flow 登录、401 singleflight refresh、gateway 中间层代理、skill reader                                           | 直接演进基础,迁移而非重发明    |

**注意:借鉴的是模式,不是复制代码。** lark-cli 是 Go,我们是 TS;mmx 是单一后端产品,我们是框架。每个借鉴点都按 TS 框架场景做了改造(详见各专题文档)。

---

## 仓库结构

```
 agent-cli-sdk/
├── src/                        实现代码(types/define/oauth/credentials/skills/qrcode/...)
├── docs/                       ★ 设计文档(本目录,随包发布)
├── skills/agent-cli-builder/   内置 skill:教 agent 用本 SDK 构建 CLI
├── type-tests/                 类型测试(tsconfig.type-tests.json)
├── scripts/                    打包冒烟测试 + 文档链接检查
├── package.json                本包(SDK,无 bin;业务包依赖它)
├── tsup.config.ts              构建(entry: index / errs / credentials / skills)
└── vitest.config.ts            测试配置
```

**业务包接入(独立 npm):**

业务包是**独立 npm 包**,依赖 `@renxqoo/agent-cli-sdk`;装载方式见 `02-sdk-guide.md`。

---

## 全局决策清单

这是整个项目讨论后定稿的决策表。**后续所有文档和实现都必须遵守,改动需重新讨论。**

| #   | 维度         | 决策                                                                                                                                                            | 详见文档            |
| --- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | 架构         | agent-cli-sdk 独立仓库(SDK)+ 业务包独立 npm                                                                                                                   | 本文档              |
| 2   | 装载         | 独立 bin 为主 + 可被 rxcli 主包装载为子命令                                                                                                                     | `02-sdk-guide.md`   |
| 3   | 编程风格     | **function 风格 + 配置对象声明**(不用 class 继承)                                                                                                               | `02-sdk-guide.md`   |
| 4   | 请求         | **取消 client 概念**(无 createClient/Client);请求方法 `get/post/...` 全挂 `ctx`;鉴权归 agent-cli-sdk 内部 + auth 插件                                                 | `02-sdk-guide.md`   |
| 5   | transport    | 低层 `ctx.request` + 高层便利方法(`ctx.get` 等);**REST 先行**                                                                                                   | `02-sdk-guide.md`   |
| 6   | 横切机制     | **vite 式插件**(钩子是 Plugin 接口,defineCli 用 `plugins: []`,不做内联钩子)                                                                                     | `02-sdk-guide.md`   |
| 7   | 错误         | 类型化错误 + 结构化统一输出格式到 stderr + **9 类 exit code**;throw 进 observeError/handleError 链                                                              | `04-errors.md`      |
| 8   | 统一输出格式 | 成功也统一输出格式 `{ok, data, meta}`;**stdout=数据 / stderr=一切**                                                                                             | `03-envelopes.md`   |
| 9   | 分页         | 统一输出格式 `meta.pagination` + `complete` + `nextToken`,**agent 自决续拉**                                                                                    | `03-envelopes.md`   |
| 10  | 认证         | `defineAuth` 覆盖标准 OAuth/Bearer/API key/Basic；特殊协议通过公开 Plugin 与基础块组合                                                                          | `05-credentials.md` |
| 11  | 管道         | unix 管道;**传引用+ID**;本地过滤交 jq                                                                                                                           | `01-cli-usage.md`   |
| 12  | 过滤         | `--limit/--offset` 透传后端;`--filter`/选字段**交 jq**                                                                                                          | `01-cli-usage.md`   |
| 13  | 全局 flag    | `--json` + 服务端查询参数;其余交 jq/sort                                                                                                                        | `01-cli-usage.md`   |
| 14  | 脱敏         | 前版不做特性;以后经 transformOutput 插件实现                                                                                                                    | `02-sdk-guide.md`   |
| 15  | skill        | list/read/sync + **defineCommands 自动生成命令文档**                                                                                                            | `06-skills.md`      |
| 16  | 测试         | vitest + `createTestCtx`                                                                                                                                        | `02-sdk-guide.md`   |
| 17  | 类型         | 命令三泛型 `<Args, Result, State>` + `defineCommands<State>`;`ctx.state` 强类型防乱塞;请求泛型 `ctx.get<T>()` 可选                                              | `02-sdk-guide.md`   |
| 18  | 插件钩子     | 6 个:beforeCommand/beforeRequest/observeRequest/handleUnauthorized/transformOutput/handleError;**enforce 三档**(pre/normal/post);observeError/handleError 链式 | `02-sdk-guide.md`   |
| 19  | 前版不做     | resource() 生成器、写入确认、OpenAPI 自动注册                                                                                                                   | 本文档              |

### 几个决策的"为什么"(简版,详见专题文档)

- **function 而非 class**:框架场景要组合(管道)、要 tree-shaking(发 npm)、要好测(mock 参数),class 继承在这三方面都劣于 function。
- **取消 client**:client 同时承担"请求能力"和"业务自定义参数"两个职责会混淆;请求挂 ctx 更直接,鉴权归 auth 插件,业务状态归 `ctx.state`(强类型)。少一层间接,少一个混乱源。
- **vite 式插件而非内联钩子**:插件是独立可复用模块(可发 npm),钩子是插件接口;内联需求写匿名插件。统一一个扩展机制,避免"逻辑该放 run 还是钩子"的困惑。
- **认证仍是 Plugin**:`defineAuth` 负责标准场景并返回普通 Plugin；特殊协议仍可用 provider chain、context-keyed session、`injectAuthHeader` 和 `handleUnauthorized` 等公开边界组合，不需要依赖框架私有状态。
- **命令三泛型**:类似 axios 声明请求/响应类型——一个命令把参数类型、返回类型、state 类型都声明清楚,TS 全面检查;渐进式(不写泛型默认 unknown/{}),不强制。
- **ctx.state 强类型**:`defineCli<State>` 声明才能访问,未声明报错。从结构上消灭"乱塞"——不是开放 bag,是强类型共享渠道(插件间传递数据)。
- **enforce 三档**:解决"加 header 的先跑、签名最后跑"的顺序问题(pre 加基础参数 → normal 业务 → post 签名收尾)。
- **agent 自决续拉分页**:不假设"必须拉全量",给 agent `complete:false + nextToken`,让它按场景决定续不续。
- **本地过滤交 jq**:agent-cli-sdk 不重复造 jq。stdout 是结构化 JSON,右边的过滤/选字段/排序全用 unix 工具链。
- **stdout/stderr 铁律**:管道能组合的根是 stdout 纯净。日志/进度/错误提示全 stderr,否则 `rxcli a | jq` 混进一行"加载中"整个管道就废了。

---

## 文档索引

| 文档                | 给谁看           | 内容                                                                                      |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `00-overview.md`    | 所有人           | 架构、分层、决策清单(本文档)                                                              |
| `01-cli-usage.md`   | 终端用户 / agent | 怎么调用命令、管道、分页、exit code                                                       |
| `02-sdk-guide.md`   | 业务包开发者     | 怎么写业务包、ctx 接口、**插件系统**、auth 插件、命令三泛型                               |
| `03-envelopes.md`   | 实现者 / agent   | 成功/错误输出的字段契约                                                                   |
| `04-errors.md`      | 业务包开发者     | 9 类错误、何时 throw、hint、observeError/handleError 链                                   |
| `05-credentials.md` | 业务包开发者     | **写 auth Plugin**(provider chain / injectAuthHeader / oauth)、provider chain、自定义凭证 |
| `06-skills.md`      | 业务包开发者     | skill 系统、命令文档自动生成                                                              |

> 本目录提供中英双语文档:中文为 `*.md`,英文为 `*.en.md`(唯一例外是 `07-structured-input.md` 英文原版 + `07-structured-input.zh-CN.md` 中文版)。

---

## 实现状态

上述设计已全部实现(代码、测试、内置 skill、文档)。决策清单仍是权威约束:后续改动需重新讨论。
