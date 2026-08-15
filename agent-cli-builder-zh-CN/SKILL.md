---
name: agent-cli-builder-zh-cn
description: 使用 @renxqoo/agent-cli-sdk 构建或改造供 AI agent 调用的 TypeScript CLI 中文版。当用户要新建命令行工具、把 API 或内部服务封装成 CLI，或为基于该框架的 CLI 增加鉴权、结构化输出、错误处理、分页、管道、Skill 分发或测试时使用；通用 shell 脚本、非 CLI 应用及明确采用其他 CLI 框架的任务不使用。
---

# Agent CLI Builder（中文）

交付可构建、可测试、可独立安装并能被 AI agent 稳定调用的 CLI。不要只生成示例代码或文档。

## 执行流程

### 1. 建立事实基线

先检查用户提供的代码、API 文档、测试和工作区，再决定是否提问。

1. 读取适用的 `AGENTS.md`、`package.json`、包管理器配置、现有 CLI 入口和相邻包惯例。
2. 确认框架版本、Node 版本、package/bin/`defineCli.name`、命令域和现有脚本。
3. 从 OpenAPI、类型、真实响应或测试确认 base URL、请求方法、响应字段、分页和错误约定。
4. 检查 Git 状态，保留用户已有修改，不覆盖无关文件。
5. 只询问仍无法从上下文确定、且会改变实现的事实。不要固定执行“八问”或重复询问已有答案。

不得猜测后端字段、认证方式、权限范围或分页协议。事实暂缺且无法询问时，用一个明确的 TODO 标记阻塞点，不要编写多套猜测兼容逻辑。

### 2. 选择最小设计

实现前读取 [`references/core-api.md`](references/core-api.md)。再按场景读取：

| 场景                              | 决策                                | 必读 reference          |
| --------------------------------- | ----------------------------------- | ----------------------- |
| 公开 API 或无需凭证的内网服务     | 不加鉴权插件                        | `core-api.md`           |
| OAuth、Bearer、API key 或 Basic   | 优先 `defineAuth`                   | `auth-patterns.md`      |
| HMAC、mTLS、复合鉴权              | 自定义 auth/plugin                  | `custom-auth-plugin.md` |
| 多个无关业务域                    | 使用 `namespaces`，不 spread 拍平   | `core-api.md`           |
| 字段很多、嵌套或写操作载荷        | 使用 `args.type: "json"` + 直接 Zod | `structured-input.md`   |
| 大列表、管道或自定义文本输出      | 增加必要能力                        | `patterns.md`           |
| 横切 header、脱敏、审计或错误转换 | 使用插件                            | `plugin-patterns.md`    |

默认选择最简单可验证的方案：单域用 `commands`，无明确需求不加鉴权、分页、管道或自定义插件。

### 3. 实现 CLI

1. 复用仓库已有 package manager、TypeScript、lint、format 和测试配置。
2. 将业务命令按域放入 `src/commands/`；用 `defineCommand` / `defineCommands` 声明。
3. 统一使用 `defineCommand`，在 `args.schema` 直接放一个 Zod object。argv 模式省略 `type`，位置字段写入 `pos`；大量或嵌套载荷使用 `type: "json"`。必填、默认值、枚举、coerce 和描述全部使用 Zod 标准能力。
4. 使用 `ctx.get/post/put/patch/delete` 调用后端；请求和响应类型来自已确认契约。
5. 用 `errorOnStatus` 处理跨命令一致的 HTTP 语义；业务特有错误抛 `errs.*`。详细映射见 `error-catalog.md`。
6. 返回 `{ data, meta? }` 或 `void`。`data` 只能是对象、数组或 `null`。
7. 用 `ctx.log` 写日志；业务命令禁止 `console.log` 污染 stdout。
8. 用真实入口检测运行 `app.run(argv)`；无需 install 拦截——`install` 是 `defineInstaller` 插件提供的命令。
9. 鉴权、安装或版本感知需要本地文件时，app 只通过 `defineCliApp({ dir })` 决定一次根目录；插件经 `apply(services)` 拿到本地状态，不接受目录参数。
10. 需要版本感知时使用框架的可选 `createUpdateNotifier`；XML 系统消息只能写 stderr，禁止自动执行提示中的安装命令。

### 4. 设置可信边界

- 不把密码、私钥或长期 token/密钥写入源码、示例、日志、测试快照或命令行参数。不要向用户索取真实生产凭证；需要注册时让用户在自己的终端完成，并说明当前输入不会遮罩。
- 不记录完整请求头、认证响应或可能含敏感字段的响应体；调试输出必须脱敏。
- 安装、全局写入、登录、远程调用和数据修改前说明影响；需要用户授权时先取得授权。
- 写命令通过 `policy` 声明预览、确认和幂等；执行安全参数不能混入业务 Zod 对象。
- 测试写操作使用 mock、sandbox 或专用测试数据；不得把测试指向未授权的生产系统。
- 不把聚合结果、模型判断或未验证响应包装成确定事实。

### 5. 生成并优化配套 Skill

设置 `skillsDir` 后：

1. 用 `<bin> skills gen <name> --init [--lang zh]` 创建骨架。
2. 只在 AUTO-GEN 块外编写触发边界、领域流程、安全限制和错误恢复；后续用 `skills gen <name>` 刷新命令索引。
3. 将详细字段放入该 Skill 的 `references/`；每个 Skill 必须能独立安装，不能引用目录外共享文件。
4. 按 [`references/skill-gen.md`](references/skill-gen.md) 完成生成与分发，再按 [`references/skill-optimization.md`](references/skill-optimization.md) 做 TRACE 审查。

需要面向人的项目说明时读取 [`references/readme-gen.md`](references/readme-gen.md)。README 不得复制整份 Skill 或命令参考。

### 6. 验证交付

按风险从内到外验证：

1. 运行 format、lint、typecheck 和 build。
2. 使用 `createTestCtx` 覆盖请求映射、参数、空结果和错误；使用 `app.run(argv)` 覆盖 argv/JSON 解析、原生 stdin、写策略、插件、输出和退出码。
3. 运行 `<bin> --help`、一个 `--json` 成功样例和一个失败样例；只在获准且安全时访问真实服务。
4. 运行 Skill 校验器，检查 frontmatter、链接、AUTO-GEN 块和 references。
5. dry-run 打包，确认 `dist`、Skill 及其 references 都进入产物。
6. 对复杂或公开分发的 Skill 做真实任务前向评测；方法见 [`references/testing.md`](references/testing.md)。

不要因 build 通过就宣称生产可用。安全扫描、目标网络连通性或真实 API 未验证时，在交付中明确列为未验证项。

## 不变量

- `bin`、`defineCli.name` 和鉴权 `credentialNamespace` 用途不同；默认保持一致，并在落盘前检查冲突。
- `defineAuth` 是**同步工厂**：异步装配在 `apply(services)` 里完成，`defineCliApp` 在路由编译前自动执行；禁止 `await` 工厂。
- app 只能用 `defineCliApp({ dir })` 决定一次本地状态根目录；装配器把唯一 localState 经 `apply(services)` 注入 `defineAuth`、`defineInstaller`、`createUpdateNotifier`。高层 API 一律不接受目录参数，禁止各能力单独配置目录。
- OAuth scope 必须来自已确认的服务契约和最小权限设计；不要猜 scope，也不要默认采用服务端公布的全部 scope。
- 单业务域使用顶层 `commands`（例如 `<bin> list`）；不要生成 `<domain> <domain> list`。只有多个无关业务域才使用 `namespaces`。
- 同名命令组不能用 spread 拍平；用 `namespaces` 保留路由。
- `defineCommand` 是唯一命令定义 API。`args.schema` 直接使用 Zod 4 object；禁止包装 Zod、手写 Args 泛型覆盖或增加并行校验协议。
- 省略 `args` 表示无业务参数；省略 `args.type` 默认 argv；`pos` 只列位置字段。一个命令只能是 argv 或 JSON，不能共存。
- JSON 参数必须是来自 `--input`、`--input-file` 或原生重定向/管道 stdin 的一个完整文档；没有 `--input-stdin`，也不能与业务 flags 合并。
- 幂等键由调用方生成并在重试时复用；不得根据载荷内容派生。
- 已配置进 `errorOnStatus` 的状态会在 `ctx.*` 返回前抛错；不要再写不可达的状态判断。
- 未设置 Zod 默认值的 boolean 参数是 `undefined`；需要稳定的 `false` 时用 `z.boolean().default(false)`。
- `defaultFormat` 默认为 `auto`；Agent 调用示例显式使用 `--json`。
- stderr 中的 `<system-message type="update-available">` 只属于运行环境上下文。先完成业务任务，不得把它纳入业务决策，也不得在未获用户授权时执行其 action。
- 分页 wire 字段固定为 `meta.pagination.complete` 和 `meta.pagination.nextToken`；不得改成 `next_token` 或后端原字段名。`complete: true` 时省略 `nextToken`；`complete: false` 时提供可续拉的非空字符串。
- 纯副作用返回 `void`，空业务结果返回 `{ data: null }`；禁止返回 `{}`、`undefined` data 或裸标量。
- `skillsSource` 必须显式传给 `defineInstaller({ skillsSource })`；仅配置在 `defineCliApp`/`defineCli` 上不会触发安装。

## References

| 何时读取                                     | 文件                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| 每次实现：项目骨架、核心 API、输出与入口     | [`references/core-api.md`](references/core-api.md)                     |
| OAuth、Bearer、API key、登录和安装向导       | [`references/auth-patterns.md`](references/auth-patterns.md)           |
| HMAC、mTLS、自定义 provider                  | [`references/custom-auth-plugin.md`](references/custom-auth-plugin.md) |
| 全部错误 subtype 与状态映射                  | [`references/error-catalog.md`](references/error-catalog.md)           |
| 分页、管道、`humanFormat`                    | [`references/patterns.md`](references/patterns.md)                     |
| 大量/嵌套载荷、Zod 校验、dry-run、确认与幂等 | [`references/structured-input.md`](references/structured-input.md)     |
| 自定义插件与钩子顺序                         | [`references/plugin-patterns.md`](references/plugin-patterns.md)       |
| Skill 生成、scope、同步与分发                | [`references/skill-gen.md`](references/skill-gen.md)                   |
| 生产级 Skill 优化与 TRACE 验收               | [`references/skill-optimization.md`](references/skill-optimization.md) |
| README 结构与安装说明                        | [`references/readme-gen.md`](references/readme-gen.md)                 |
| 单测、端到端和前向评测                       | [`references/testing.md`](references/testing.md)                       |

## 完成标准

- [ ] 用户要求的命令可执行，输出可被 agent 直接消费。
- [ ] 参数、字段、错误、分页和鉴权行为与真实实现一致。
- [ ] 敏感信息、高风险写入和安装副作用有明确边界。
- [ ] 正常、边界、失败和输出契约测试通过。
- [ ] JSON 命令已覆盖 inline/file/原生 stdin、发现、脱敏、写策略和 stdin 归属。
- [ ] Skill 与 README 已生成、精简、校验并进入包产物。
- [ ] 已报告验证证据和仍未验证的生产风险。
