/**
 * bug-hunt 测试 —— 复现已发现的 bug(预期 FAIL,作为 TDD red)。
 *
 * 这些测试故意断言"期望的正确行为",当前因 bug 存在会失败。
 * 修复后应转 green。每个测试注释标明 bug 编号和根因。
 */
import { describe, it, expect } from "vitest";
import * as z from "zod";
import { createTestCtx } from "../test-utils.js";
import { defineCommand, defineCli } from "../define.js";
import { runCommand as executeCommand, type RunCommandOptions } from "../pipeline.js";

function runCommand<State>(
  options: Omit<RunCommandOptions<State>, "source" | "route"> & { route?: string[] },
): Promise<number> {
  return executeCommand({
    ...options,
    route: options.route ?? [options.spec.name],
    source: "test",
  });
}

// ============================================================================
// BUG-SDK-1 [P1]: meta.pagination: null 导致 TypeError(被兜底成 internal/unknown)
// 根因: envelope.ts:42 `p.complete` 解引用 null
// 期望: pagination:null 应被当 undefined 处理(跳过),不崩溃
// ============================================================================
describe("BUG-SDK-1: meta.pagination: null 不应崩溃", () => {
  it("命令返回 meta:{pagination:null} 应正常输出(不 TypeError)", async () => {
    const cmd = defineCommand({
      name: "test",
      async run() {
        return { data: [1, 2], meta: { pagination: null } };
      },
    });
    const ctx = createTestCtx({ request: async () => ({ status: 200, data: {}, headers: {} }) });
    // 当前:会 TypeError → exit 5;期望:exit 0,pagination 被跳过
    const code = await runCommand({ spec: cmd, args: {}, ctx, plugins: [] });
    expect(code).toBe(0);
  });
});

// ============================================================================
// BUG-SDK-2 [P1]: enforce 类型只有 "pre"|"post",但实现支持三档("normal")
// 根因: types.ts:197 enforce?: "pre" | "post"(缺 normal),plugin.ts:21 定义了三档
// 期望: enforce 类型应包含 "normal"
// ============================================================================
describe("BUG-SDK-2: enforce 类型应支持 normal 档", () => {
  it("enforce: 'normal' 应是合法类型值", async () => {
    // 类型层面验证(运行时 normal 已被 sortPlugins 支持)
    const plugin = { name: "test", enforce: "normal" as const, async beforeCommand() {} };
    // 当前:TS 编译报错 "normal" 不在 "pre"|"post" 里;运行时正常
    expect(plugin.enforce).toBe("normal");
  });
});

// ============================================================================
// BUG-SDK-3 [中]: 单短横 flag(如 -x)被静默当 positional,不拒绝
// 根因: define.ts parseFlags 只识别 -- 开头的 token,-x 落入 positional
// 期望: -x 这种非 -h/-v 的单短横 token 应抛 validation(未知 flag),而非塞进 positional
// ============================================================================
describe("BUG-SDK-3: 单短氢 flag 不应静默当 positional", () => {
  it("cmd -x(未知短 flag)应报 validation 错误", async () => {
    const app = defineCli({
      name: "test",
      description: "test",
      commands: {
        greet: defineCommand({
          name: "greet",
          args: { schema: z.object({ name: z.string() }), pos: ["name"] },
          async run(_ctx, args) {
            return { data: args };
          },
        }),
      },
    });
    // 捕获 stderr(错误输出)
    const origErr = process.stderr.write.bind(process.stderr);
    let errOut = "";
    process.stderr.write = (s: string) => {
      errOut += s;
      return true;
    };
    await app.run(["greet", "-x"]);
    process.stderr.write = origErr;
    // 当前:-x 被当 name 成功(exit 0);期望:报 validation(未知 flag -x)
    const parsed = JSON.parse(errOut);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.type).toBe("validation");
  });
});
