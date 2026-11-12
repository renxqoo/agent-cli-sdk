# 2.0 生产契约与迁移

本文描述 2.0.0 的公开契约。此前运行时变更的历史与数据兼容说明见 [运行时迁移](08-runtime-refactor.md)。

## 目标与边界

本轮基线为 `e82b30d`。保留命令声明、输入校验、输出骨架、插件顺序、会话隔离、单次 401 重试、凭证事务及 Skill 恢复。修正 HTTP 错误默认被当成成功的问题，补齐请求时限和调用方取消，并将运行时组合与业务入口分开。

SDK 面向 Node.js 26+ / Bun 1.4+ 的独立 CLI。`App.run()` 读写进程标准流并设置 `process.exitCode`；同进程嵌入方需要串行运行，或用 `/advanced` 自行组织执行与 I/O。默认文件凭证仍以明文存储，POSIX 权限保护不等同系统凭证保险库；可注入自定义 ConfigStore。

## 公开 API 与兼容承诺

| 入口 | 使用者与职责 |
| --- | --- |
| `@renxqoo/agent-cli-sdk` | 业务作者：应用/命令/认证工厂、插件和上下文类型、错误、输出、测试工具 |
| `@renxqoo/agent-cli-sdk/advanced` | 运行时集成者：插件装配与调度、上下文/HTTP adapter 工厂、命令执行器、管道读取器 |
| `@renxqoo/agent-cli-sdk/credentials` | 自定义凭证 provider 和 ConfigStore |
| `@renxqoo/agent-cli-sdk/skills` | Skill 发现、生成、同步及格式辅助工具 |
| `@renxqoo/agent-cli-sdk/errs` | 错误类、分类与退出码 |

以上入口均遵守 SemVer。`advanced` 表示调用者承担生命周期顺序与进程 I/O 责任，不表示可以无版本约束地破坏兼容。未列入 `package.json.exports` 的内部文件不属于公开 API。移除公开 API、改变默认失败语义或提升最低运行时要求须通过 major 版本发布，并附消费者迁移说明。

## 请求契约

- `ctx.get/post/put/patch/delete/request` 的 HTTP 4xx/5xx 默认抛类型化错误。400/422 为 `validation/invalid_argument`，403 为 `authorization/forbidden`，404 为 `api/not_found`，409 为 `api/conflict`，429 为 `api/rate_limited`，5xx 为 `api/server_error`，其余为 `api/http_error`。
- `errorOnStatus` 自定义精确状态优先于自定义类别通配符，两者均优先于默认映射。401 保留认证类别，只有认证类别的映射参与其最终分类。
- 确需检查错误响应时，在单次调用传 `allowHttpErrors: true`；这会绕过该次请求的自动状态映射，但不绕过最终 401 认证失败。
- 业务 HTTP 的默认时限为每次物理请求 30,000 ms，覆盖请求发送和响应 body 读取。应用的 `requestTimeoutMs` 可修改默认值，单次 `timeout` 优先；允许范围为 1 到 2,147,483,647 的整数毫秒。
- 所有快捷方法接收 `RequestControls`：GET 在 query 后、POST/PUT/PATCH 在 body 后、DELETE 在 path 后。低层 `ctx.request` 接收同名字段。
- 调用方 `signal` 与时限组合。调用方取消返回 `network/cancelled`、`retryable: false`；时限耗尽返回 `network/timeout`、`retryable: true`；均为退出码 4。取消原因保留为内部 cause，不回显到机器输出。
- 调用方取消不能被请求准备插件移除；取消后不再发送认证重试。等待共享 OAuth 刷新时可以取消当前等待，共享刷新仍可为其他调用完成。
- 已发送请求的审计始终启动一次。取消可结束当前审计等待，已启动的观察钩子继续完成；取消不会回滚已发生的后端写入。
- 401 只重试一次，每次重新准备原始逻辑请求，并对实际 I/O 审计。网络错误与 5xx 不自动重试，避免重复写入。自定义 HttpAdapter 必须遵守 signal、timeout 和单次发送契约。
- 请求时限不包含任意插件执行或共享 OAuth 刷新的耗时。OAuthClient 的协议调用保留自己的 30 秒时限。插件应使其异步钩子可终止；需要覆盖整段操作时，调用方可传 `AbortSignal.timeout(...)`。

```ts
import { defineCli } from "@renxqoo/agent-cli-sdk";
import { setupPlugins } from "@renxqoo/agent-cli-sdk/advanced";
import { generateAutogenBlock } from "@renxqoo/agent-cli-sdk/skills";

// 应用默认值：defineCli({ ..., requestTimeoutMs: 15_000 })。
const response = await ctx.get("/orders", { limit: 20 }, {
  timeout: 5_000,
  signal: AbortSignal.timeout(10_000),
});

// 命令自行赋予 HTTP 状态业务语义时显式开启检查；仍须处理其他错误状态。
const inspected = await ctx.get(`/orders/${id}`, undefined, { allowHttpErrors: true });
if (inspected.status === 404) { /* 命令专属恢复或类型化错误 */ }
if (inspected.status >= 400) { /* 处理剩余错误，或使用 advanced.throwForResponse */ }
```

## 迁移矩阵与实施顺序

| 原行为 | 2.0 行为与消费者动作 | 验证入口 |
| --- | --- | --- |
| 未映射 HTTP 错误返回成功 | 默认抛错；手动状态分支显式传 allowHttpErrors | production-request、打包消费者失败命令 |
| 请求没有 SDK 默认时限 | 默认 30 秒；长操作显式设置应用或单次时限 | production-request、request-network |
| 调用方不能取消 | RequestControls.signal；保留跨重试取消语义 | production-request、request-network |
| 根入口包含调度与格式实现 | 调度迁移到 /advanced，Skill 工具迁移到 /skills | 类型用例与真实 tarball 消费 |
| 发布约束只有文档描述 | CI 比较 Git 基线并校验版本与 changelog | release-gate、release:check |
| 凭证与 Skill 持久化格式 | 保留本轮前格式及已有事务/恢复协议 | 全量会话、跨进程、Skill 回归 |

先迁移业务命令的状态检查，再更新导入路径和时限配置，随后运行消费者类型/行为测试。发布由调用方明确执行；本轮仅准备 2.0.0 成品。回退应将消费者与 SDK 一起退回先前版本；本轮没有新增数据格式迁移。

## 验证与发布

`pnpm release:check --base <git-ref>` 校验版本是有效 SemVer、变更后版本递增、存在唯一匹配包名/版本且日期有效的 changelog 标题。默认基线为 HEAD，无法解析基线时失败，不静默跳过。CI 的 PR 使用 base SHA，main push 使用 before SHA；它验证发布元数据，不自动推断所有源码的兼容性。

完整门禁使用仓库既有 build、typecheck、lint、format:check、docs:check、Node/Bun 全量测试与覆盖率、tarball 安装消费。tarball 消费同时验证五个入口、发布后的类型声明、默认 HTTP 失败和取消退出码。macOS 本机结果与 CI 的跨系统矩阵应分别报告；测试通过不能替代实际业务采用和持续运行记录。

## 本轮本机验收记录（2026-11-12）

环境：macOS arm64。以下为本轮实际执行结果，Linux/Windows 结果待远端 CI 运行。

| 运行时 | 完整回归 | 实际 tarball 安装、入口、类型和失败行为 |
| --- | --- | --- |
| Node.js 26.0.0 | 62 文件 / 623 用例通过 | 通过 |
| Node.js 26.13.0 | 62 文件 / 623 用例通过 | 通过 |
| Bun 1.4.0 | 62 文件 / 623 用例通过 | 通过 |
| Bun 1.4.4 | 62 文件 / 623 用例通过 | 通过 |

Node.js 26.13.0 覆盖率：语句 85.09%、分支 76.68%、函数 89.40%、行 87.26%，超过仓库既有门槛。构建、源码与消费者类型检查、lint、格式、文档链接、release:check 及 diff 空白检查通过。lint 保留仓库既有非阻断警告，未降低规则或覆盖率阈值。

两路独立只读审查分别覆盖请求生命周期和公开 API/发布/文档；发现的审计等待取消与六处文档状态分支遗漏均已修正并复核。HTTP 默认失败和审计等待取消取得修复前失败、修复后通过的回归证据；真实回环 HTTP 验证时限覆盖 body 和在途取消。最低 Bun 版本的 HTTP 测试服务采用先停止监听再关闭连接的清理顺序。

本轮未发布 npm、推送仓库或调用真实业务 OAuth 服务。本机验证采用已安装依赖；pnpm 11 的本地依赖预检尝试重新安装时，使用进程环境 `pnpm_config_verify_deps_before_run=false` 运行原有脚本，未修改项目安装配置。CI 仍从冻结 lockfile 安装后执行全部检查。
