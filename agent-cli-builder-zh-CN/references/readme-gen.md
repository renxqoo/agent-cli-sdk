# README 生成指南（中文）

README 面向开发者和终端用户；Skill 面向 AI agent。两者共享事实来源，但不要互相复制整份内容。

## 导航

1. 信息来源与结构
2. 安装说明
3. 鉴权分支
4. 输出、开发与维护
5. 发布检查

## 1. 信息来源与结构

先从实现提取事实，不凭模板补全：

| README 内容          | 唯一事实来源                   |
| -------------------- | ------------------------------ |
| 包名、bin、Node 版本 | `package.json`                 |
| 定位、命令和业务域   | `defineCli`、`defineCommand`   |
| 安装行为             | `defineCliApp` 里 `defineInstaller` 插件的配置 |
| 鉴权步骤             | auth 实现和真实 `--help`       |
| 输出与分页           | 命令返回值、`defaultFormat`    |
| 开发命令             | `package.json.scripts`         |

按项目复杂度保留必要章节：

1. 一句话定位和适用范围。
2. 安装、验证和卸载/清理影响。
3. 3-8 个高频命令。
4. 鉴权或环境配置（仅实际需要时）。
5. 输出契约和关键限制。
6. 开发、测试和发布命令（源码项目需要时）。

不要为了满足固定模板添加空章节、宣传语、虚构链接或不存在的脚本。

## 2. 安装说明

若入口实现了安装向导：

````markdown
## 安装

需要 Node.js {{engines.node}}。以下命令会全局安装 CLI，并将包内 Skill 同步到本机已安装的 AI 工具目录：

```bash
npx {{package-name}} install
```

验证：

```bash
{{bin}} --help
{{bin}} skills list --json
```
````

必须如实说明副作用：全局 npm 包、Skill 目录、网络下载、配置文件和登录凭证。不要声称向导会执行源码中没有的步骤。

提供手动安装仅用于排障：

```bash
npm install -g {{package-name}}
{{bin}} skills sync --json
{{bin}} --help
```

若 app 没有 `defineInstaller` 插件，不要写 `npx <pkg> install`。使用真实支持的安装方式。

## 3. 鉴权分支

### 无鉴权

明确写“无需登录”，不要保留空的凭证章节。

### OAuth / `defineAuth`

README 给人类用户写交互式流程：

```bash
{{bin}} auth register
{{bin}} auth login
{{bin}} auth status --json
```

只在实现确实要求动态注册时包含 `register`。当前交互式注册输入不会遮罩；提醒用户在私密终端操作。不要要求用户把真实令牌粘贴给 agent，也不要在 README 推荐 `--token <真实值>`。说明注册和登录会写入哪些本地配置。

业务 Skill 给 agent 写 split-flow；不要把 README 的阻塞式 `auth login` 原样复制到 Skill。

### 静态密钥或自定义鉴权

不要把长期密钥示例写成 `--secret <value>`。命令行可能进入 shell 历史和进程列表。优先说明受控环境变量或实现中的交互式遮罩输入：

```bash
export MY_CLI_API_KEY="<从安全凭证系统读取>"
{{bin}} auth status --json
```

不要声称凭证经过加密，除非存储实现和测试能够证明。

## 4. 输出、开发与维护

输出说明应与 `defaultFormat` 一致：

```markdown
Agent 或脚本调用时显式加 `--json`。成功结果写 stdout，错误和日志写 stderr。
```

不要写“列表自动生成分页”。只有命令返回 `meta.pagination` 时才说明 `complete` 和 `nextToken`。

常用命令来自 `--help`，每条示例都必须能运行。不要虚构 `--dryRun`；结构化写操作只有在 `operation` 声明后才会出现短横线形式的 `--dry-run` 和 `--yes`。

JSON 参数命令示例优先展示安全的文件或原生 stdin 调用及 schema 发现，不要在 README 塞长内联载荷：

```bash
{{bin}} orders create --input-file ./order.json --idempotency-key <stable-key> --yes
{{bin}} orders create --input-schema
```

说明载荷必须且只能选择一个来源，并提醒内联敏感值可能进入 shell 历史或进程列表。

开发章节只列真实脚本：

```bash
pnpm --filter {{package-name}} typecheck
pnpm --filter {{package-name}} build
pnpm --filter {{package-name}} test
```

记录会影响维护的关键决策即可，例如 package/bin/namespace 映射、认证类型和错误映射；不要写长篇设计复盘。

## 5. 发布检查

- [ ] 安装命令、Node 版本、bin 和脚本来自当前 `package.json`。
- [ ] `--help` 与 README 示例一致。
- [ ] 安装、登录、文件写入和远程访问的影响已说明。
- [ ] 示例不包含真实域名凭证、token、个人数据或生产资源 ID。
- [ ] JSON、错误、分页和退出码说明与真实运行一致。
- [ ] Skill 安装步骤和 README 面向人的步骤语义一致。
- [ ] pack dry-run 包含 README、dist 和全部 Skill 文件。
