# Skill 生成、同步与分发（中文）

使用 agent-cli-sdk 从命令定义生成机械信息，再由开发者补充触发、领域流程和安全边界。不要手工维护会与代码漂移的命令表。

## 导航

1. 命令与生成工作流
2. Frontmatter 与语义内容
3. AUTO-GEN 块
4. References 与独立安装
5. 同步和安装向导
6. 安全与验证

## 1. 命令与生成工作流

设置 `skillsDir: "./skills"` 后，框架注入：

| 命令                                         | 行为                   |
| -------------------------------------------- | ---------------------- |
| `<bin> skills list`                          | 列出包内 Skill         |
| `<bin> skills read <name>`                   | 输出 `SKILL.md` 原文   |
| `<bin> skills read <name>/references/<file>` | 输出 reference 原文    |
| `<bin> skills gen <name> --init [--lang zh]` | 首次生成骨架和命令索引 |
| `<bin> skills gen <name>`                    | 只刷新 AUTO-GEN 块     |
| `<bin> skills sync`                          | 同步到 agent 发现目录  |

执行顺序：

```bash
# 1. 命令已用 defineCommand/defineCommands 声明，且每个参数都有 desc
my-cli skills gen my-skill --init --lang zh

# 2. 编辑 AUTO-GEN 块外的语义内容
# 3. 命令变化后刷新索引
my-cli skills gen my-skill

# 4. 校验并同步
my-cli skills list --json
my-cli skills sync --json
```

`--init` 只用于首次创建。已有文件使用普通 `gen`，避免重新生成骨架覆盖语义内容。

## 2. Frontmatter 与语义内容

生成器当前创建：

```yaml
---
name: my-skill
description: <能力、触发语句和相邻边界>
metadata:
  requires:
    bins: ["my-cli"]
  category: business
---
```

- `name` 与目录名一致，使用小写字母、数字和连字符。
- `description` 集中写“何时使用”，包含核心能力、口语化触发和最容易混淆的排除边界。
- `metadata.requires.bins` 写真实 bin 名；不要添加无法被当前消费者使用的装饰字段。
- 版本信息放 `package.json`，不要放进 Skill frontmatter。

示例：

```yaml
description: 查询和管理待办。当用户要查看、新建或完成待办时使用；日历事件和项目里程碑不在范围内。
```

不要在正文再复制完整触发表。正文只保留触发后的路由、非显然参数、多步依赖、安全限制和失败恢复。详细优化规则见 `skill-optimization.md`。

## 3. AUTO-GEN 块

生成块：

```markdown
<!-- AUTO-GEN:START commands -->
<!-- 本区块由 my-cli skills gen 自动生成，请勿手改 -->

## 命令

| 操作     | 命令                                   |
| -------- | -------------------------------------- |
| 查询待办 | `my-cli todos list [--limit <number>]` |

<!-- AUTO-GEN:END -->
```

AUTO-GEN 包含操作说明和命令签名，不包含完整参数表。若 scope 内存在 JSON 参数命令，还会生成输入方式及 `--input-schema`、`--input-example` 发现命令。命令或 args schema 变化后重新运行 `gen`；不要手改标记块。

签名来自参数 schema：

| 参数            | 签名                  |
| --------------- | --------------------- |
| 必填 positional | `<id>`                |
| 可选 positional | `[offset]`            |
| 必填 flag       | `--status <string>`   |
| 可选 flag       | `[--limit <number>]`  |
| 可选 boolean    | `[--force]`           |
| 可选 array      | `[--tag <string>...]` |

签名只表达调用形态。枚举、范围、字段和分页协议放入 references。

不要把结构化载荷的完整 JSON Schema 复制进 `SKILL.md`。需要业务语义时链接聚焦的字段/流程 reference；机器契约由 agent 通过 `--input-schema` 实时读取。

## 4. References 与独立安装

推荐结构：

```text
skills/my-skill/
├── SKILL.md
└── references/
    ├── install.md
    └── domain-fields.md
```

- 在 `SKILL.md` 直接链接每个 reference，并写明何时读取。
- 参数、字段、枚举和复杂工作流放 references；不要同时复制到正文。
- 每个 Skill 必须包含运行所需的全部 references，不引用 Skill 目录外文件，不使用软链接。
- 多个 Skill 共用安装说明时，从单一模板在 build 时生成实体 `references/install.md`；生成器需幂等并支持 `--check`。
- `package.json.files` 至少包含 `dist` 和 `skills`；用 pack dry-run 验证实际产物。

安装 reference 应要求 agent 先检查 bin 是否存在。缺失时说明全局安装、文件同步和网络访问等影响，取得必要授权后再执行，并用 `<bin> --help` 验证。

## 5. 同步和安装向导

未配置 `skillsTargets` 时，`skills sync`：

1. 始终写入 `~/.agents/skills`。
2. 仅当相应工具父目录存在时，写入 Claude、Codex、Cursor、ZCode、OpenClaw 和 Pi 的 Skill 目录。

显式 `skillsTargets` 会完全覆盖默认候选并强制写入指定目录；空数组表示不写任何同步目标。

```ts
defineCli({
  skillsTargets: [
    { key: "claude", dir: "~/.claude/skills" },
    { key: "codex", dir: "~/.codex/skills" },
  ],
});
```

`defineInstaller({ skillsSource })`(放入 `defineCliApp` 的 plugins,提供顶层 `install` 命令)的行为:

| `skillsSource` | Skill 安装路径                                   |
| -------------- | ------------------------------------------------ |
| 空             | 调用包内 `<bin> skills sync`                     |
| URL            | 尝试 `npx skills add <url>`，失败后回退本地 sync |

`defineCliApp`/`defineCli({ skillsSource })` 不会自动把该值交给安装向导；必须显式传给 `defineInstaller`。安装会产生全局包、Skill 文件和凭证等副作用，面向 agent 的安装说明必须先披露影响。

## 6. 安全与验证

`skills read` 和 `skills gen` 已拒绝绝对路径、`..`、越过 `skillsDir` 的 realpath 及外部 symlink。业务包不要绕过这些校验。

发布前：

1. 运行 `skills gen`，确认标记块外内容未变化。
2. 检查所有链接和 references 存在。
3. 运行 Skill 校验器和 `skill-optimization.md` 的 TRACE 清单。
4. 运行 should-trigger、口语触发和 should-not-trigger 评测。
5. dry-run 打包，并从包清单确认每个 Skill 可独立读取。
6. 对公开发布或复杂 Skill 做 `testing.md` 中的真实任务前向评测。
