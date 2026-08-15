# 测试与真实任务评测（中文）

代码测试验证 CLI 契约；前向评测验证 agent 能否靠 Skill 完成任务。两者不能互相替代。

## 导航

1. 测试矩阵
2. `createTestCtx` 命令测试
3. `app.run(argv)` 端到端测试
4. 安全和打包验证
5. Skill 前向评测

## 1. 测试矩阵

| 层             | 验证内容                          | 最低覆盖                       |
| -------------- | --------------------------------- | ------------------------------ |
| 命令单测       | 请求映射、业务转换、类型化错误    | 正常、空结果、边界、后端失败   |
| CLI 端到端     | argv、路由、插件、输出、exit code | 成功 JSON、参数错误、HTTP 错误 |
| JSON 参数      | 来源、Zod、脱敏、写策略、stdin    | 合法来源、限制、发现、策略     |
| 构建与打包     | ESM 入口、bin、文件清单           | build、`--help`、pack dry-run  |
| Skill 静态校验 | frontmatter、链接、AUTO-GEN       | 校验器、生成器 `--check`       |
| 前向评测       | 触发、调用、安全、最终结果        | 典型、口语、相邻边界、失败场景 |

所有远程写操作使用 mock、sandbox 或专用测试资源。未经授权不得用生产凭证或生产数据做测试。

## 2. `createTestCtx` 命令测试

`createTestCtx` 在低层 mock `request`，因此 `get/post/...` 都会走同一个替身：

```ts
import { createTestCtx } from "@renxqoo/agent-cli-sdk";

it("把 limit 传给后端并返回列表", async () => {
  let request: { path?: string; query?: Record<string, unknown> } = {};
  const ctx = createTestCtx({
    request: async (opts) => {
      request = opts;
      return { status: 200, data: { items: [{ id: "t_1" }] }, headers: {} };
    },
  });

  const result = await todoCommands.list.run(ctx, { limit: 5 });

  expect(request).toMatchObject({ path: "/todos", query: { limit: 5 } });
  expect(result?.data).toEqual([{ id: "t_1" }]);
});
```

按 path 分发时，对未知请求立即抛错，避免测试误通过：

```ts
request: async (opts) => {
  if (opts.path === "/todos") return { status: 200, data: { items: [] }, headers: {} };
  throw new Error(`unexpected ${opts.method} ${opts.path}`);
};
```

注意：

- 每个响应都返回 `status`、`data` 和 `headers`。
- `createTestCtx` 不执行 `defineCli` 装配、插件生命周期或 `errorOnStatus`；这些用端到端测试覆盖。
- 测 `ctx.state`、日志、凭证或管道时显式注入对应 mock。
- 不在快照中保存 token、请求头或完整敏感响应。

管道测试只需提供 `PipeApi`：

```ts
const pipe = {
  async *in() {
    yield { type: "orders", id: "o_1", data: { id: "o_1" } };
  },
  isInPipe: () => true,
};

const ctx = createTestCtx({ pipe, request: mockRequest });
```

## 3. `app.run(argv)` 端到端测试

使用 `app.run` 覆盖：

- 全局与命令参数解析。
- commands/namespaces 路由。
- plugin `beforeCommand`、请求钩子、输出和错误钩子。
- `defaultFormat`、`--json`、stdout/stderr 和 exit code。
- `errorOnStatus`、未知命令和输出契约违规。

测试时拦截 `process.stdout.write`、`process.stderr.write` 和 `global.fetch`，并在 `afterEach` 恢复：

```ts
let stdout = "";
let stderr = "";

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  stdout = "";
  stderr = "";
});
```

最低断言：

```ts
await app.run(["list", "--json"]);
expect(process.exitCode).toBe(0);
expect(JSON.parse(stdout)).toMatchObject({ ok: true, source: "my-cli" });
expect(stderr).toBe("");
```

再覆盖未知命令、缺失参数、一个 `errorOnStatus` 状态、裸标量 data 和插件顺序。不要只直接调用 `command.run`。

每组 JSON 参数命令至少覆盖：

- 覆盖 inline、普通文件成功及两者互斥失败；未给显式来源时覆盖原生 stdin 成功，空 stdin 必须失败。显式来源优先且不消费无关 stdin。
- 字节/深度/属性/数组限制、重复键、危险键、非法 UTF-8 和代表性 Zod issue，错误不得回显原始载荷。
- 无载荷执行 `--input-schema` 和 `--input-example`。
- dry-run 与 `observeInput` 中按敏感 JSON Pointer 脱敏。
- dry-run 不进入 `run`、必填确认和调用方幂等键 header 注入。
- 原生重定向/管道 stdin 独占输入流，不再读取 `PipeRecord`。

## 4. 安全和打包验证

发布前执行：

1. format、lint、typecheck、build、unit/e2e tests。
2. 从 `dist` 运行 `<bin> --help`、成功 JSON 和失败 JSON。
3. 检查日志和错误是否对 token、cookie、Authorization 和个人数据脱敏。
4. 对写命令验证预览、确认、权限错误和回滚提示。
5. dry-run 打包，确认 bin、已 bundle/压缩的 dist、README、Skill 和 references 均存在；从临时安装的产物导入公共 API。
6. 在临时目录安装包产物并读取 Skill，避免只验证源码路径。

真实 API 冒烟只使用明确授权的环境。记录服务、账号范围和是否产生数据；测试后清理专用资源。

## 5. Skill 前向评测

复杂或公开分发的 Skill 至少评测：

1. 明确核心任务的 should-trigger 请求。
2. 不包含命令名的口语请求。
3. 相邻能力的 should-not-trigger 请求。
4. 缺少 bin 时的安装指引。
5. 非显然参数或多步命令串联。
6. 敏感输入、高风险写入或权限不足。
7. 空结果、局部失败和数据不足。

使用新上下文或子代理，将 Skill 路径和真实用户请求作为输入，不泄露预期命令、怀疑的问题或修复方案。测试 agent 若会修改外部系统，必须先获得用户批准或改用 mock/sandbox。

每个任务记录：

- 是否触发正确 Skill。
- 是否选择正确命令、参数和顺序。
- 是否遵守安装、凭证和写操作边界。
- 是否处理错误且没有编造数据。
- 是否交付用户可直接使用的最终结果。

不要把“调用了 CLI”作为唯一通过标准。有效断言应覆盖 Skill 相比 `--help` 提供的非显然价值，例如默认值陷阱、领域映射、多步流程和安全限制。

前向评测不能验证的项目必须在交付中列出，例如安全实验室扫描、国内网络、生产权限和外部 API 稳定性。
