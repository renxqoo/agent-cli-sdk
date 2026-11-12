# 运行时重构与迁移

> 本文保留此前运行时迁移的历史记录；0.0.1 的默认行为、导入路径及本轮验证请见[生产契约与迁移](09-production-contracts.md)。

## 目标与基线

本次重构以 main 的 3e849c2 和已清理的 483 个有效用例为基线。运行时目标为 Node.js 26.0.0 及以上稳定版、Bun 1.4.0 及以上稳定版。构建与类型检查使用项目的 TypeScript、tsup 和 pnpm。

保留命令声明、JSON/argv 输入、结构化输出、错误退出码、单次 401 重试、provider 优先级和 Skill 人工内容。修正会话串用、凭证复活、临时故障清凭证、锁失去互斥、文件越界、参数回显和增量同步行为。

## 模块与状态归属

| 模块 | 权威状态与职责 |
| --- | --- |
| CommandRegistry | 编译后的路由索引、命令 schema、插件命令归属 |
| PluginFactory | 为每个 App 的 services 创建独立 Plugin 实例 |
| Plugin | 当前 App 的钩子与命令，装配后编译钩子执行计划 |
| RequestExecutor | 逻辑请求快照、单次物理请求审计、401 重试决策、dry-run 请求约束 |
| AuthSessionManager | 每个命令上下文绑定的 token、sessionId 与身份快照 |
| OAuthFlowCoordinator | 指定会话的 singleflight、持锁重读、刷新和凭证提交 |
| ConfigStore | 凭证变更的唯一事务入口、校验、命名空间隔离和原子提交 |
| SkillRepository | 发现、读取、生成和发布 |
| SkillTree | 一次校验后的源内容与文件权限快照，供全部同步目标复用 |

## 接口迁移

| 移除的接口 | 当前接口与迁移方法 |
| --- | --- |
| Plugin.apply | 使用 PluginFactory.setup(services)，返回该 App 的 Plugin |
| applyPlugins | setupPlugins 返回装配后的 Plugin 数组 |
| createOn401Hook | createOAuthRefresh 返回接收 OAuthSessionRef 的函数，结果为 TokenInfo 或 null |
| CredentialProvider.resolveIdentity、resolveIdentityWithChain | 在同一次 resolveToken 结果中返回 identity |
| ConfigStore.withLock | transactCredentials(namespace, operation)，回调使用 transaction.read/write/clear |
| lockStaleAfterMs、releaseFileLock | 进程终止和持有连接关闭时由 SQLite 释放锁 |
| SkillFileStore 注入接口 | SkillRepository 统一执行边界校验、独占生成和原子文件替换 |

defineCliApp 接收 Plugin 或 PluginFactory。低层 defineCli 接收装配完成的 Plugin。需要显式装配时，从 `@myriosx/cli-kit/advanced` 导入并调用 setupPlugins，并把返回值交给 defineCli。

## 会话与事务

登录为凭证分配新的 sessionId。刷新保留 sessionId。失败请求携带实际发送的 token 与命令绑定的 sessionId，刷新在事务内核对存储中的会话。会话已经改变时返回 null。相同会话已被其他请求刷新时复用已提交的 token。

已有 JSON 凭证在读取时使用确定性的文档摘要识别会话，成功刷新时持久化 sessionId。凭证 JSON 由 ConfigStore 管理。配置与凭证先通过相同 codec 校验，再原子替换。

transactCredentials 暂存修改，回调成功后提交一次。抛错则放弃修改，退出后句柄失效。保存、清除、刷新和登出共用命名空间互斥。登出先在事务内取出并清除凭证，再吊销取出的会话。

SQLite 文件承载跨进程互斥。每个命名空间使用独立文件，Node 与 Bun 共享 BEGIN IMMEDIATE 语义。连接关闭和进程终止释放互斥。锁文件应在应用停止运行后随本地状态目录管理。升级时应先停止使用旧锁协议的 CLI 进程。

## Skill 文件与恢复

发现时校验技能名。生成校验 SKILL.md 的实际目标，独占生成并原子替换。同步先校验和读取源树，拒绝越界链接与特殊文件，保留普通文件执行权限。每个目标使用独占锁，目录替换保留失败回滚。

同步清单校验来源标识和技能名。目标恢复先于内容摘要判断。源快照跨目标复用，未变更且与源一致的目标文件保持原位。目标被外部修改时重新发布源内容。

## 验证与清理顺序

1. 为已确认缺陷取得失败证据，补充会话、文件和真实多进程回归。
2. 迁移源码、调用方、类型用例、文档和内置构建 Skill。
3. 运行 Node 与 Bun 全量用例、覆盖率、类型、lint、格式、文档链接。
4. 用最低版本和当前稳定版运行实际 tarball 的安装与消费。
5. 对数组参数、路由和未变更 Skill 同步作相同负载的前后对比。
6. 独立审查后重跑受影响用例及交付门禁。

CI 为 Linux、macOS、Windows 配置最低版本与当前稳定版矩阵。具体本机运行结果以交付记录为准。

## 本机验收记录

环境为 macOS arm64。Node.js 26.0.0、26.13.0，Bun 1.4.0、1.4.4 均通过 516 个用例和实际 tarball 安装消费。类型检查、构建、lint、格式和文档链接检查通过。Node 稳定版覆盖率超过仓库既有阈值。

已取得 CLI 六项修复前失败证据，认证、跨进程锁和文件边界另有隔离探针。独立审查发现的执行权限、增量恢复、序列化、请求头大小写和跨目标快照问题均有定向回归。

以下数据来自同机合成负载。数组参数和路由为七轮中位数，目录同步为单次采样。数据反映本机合成负载下的改动收益。

| 场景 | Node 26.13.0 改前 / 改后 | Bun 1.4.4 改前 / 改后 |
| --- | --- | --- |
| 32,000 个重复数组参数 | 456.01 / 2.00 ms | 1,074.26 / 1.76 ms |
| 10,000 条路由的末项命令 | 105.8 / 1.2 μs | 243.3 / 1.0 μs |
| 800 个 Skill 首次同步 | 515 / 399 ms | 878 / 358 ms |
| 800 个 Skill 无变化重同步 | 1,018 / 340 ms | 1,453 / 237 ms |

持有和释放空凭证事务的 1,000 次采样，平均耗时为 Node 约 0.24 ms、Bun 约 0.26 ms，包含锁连接、目录检查和临时文件巡检。真实多进程回归验证持锁互斥、命名空间独立和持有者被终止后的接续获取。
