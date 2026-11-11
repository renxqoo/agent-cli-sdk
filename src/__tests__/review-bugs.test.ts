/**
 * Code review 复现测试 —— 每个 bug 一个最小用例,断言"期望的正确行为"。
 * 当前(有 bug)→ FAIL;修复后 → green。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineCli, defineCommand } from "../define.js";
import { prettyPrint } from "../pretty.js";
import { runCommand as executeCommand, type RunCommandOptions } from "../pipeline.js";
import { createTestCtx } from "../test-utils.js";
import * as z from "zod";

function runCommand<State>(
  options: Omit<RunCommandOptions<State>, "source" | "route"> & { route?: string[] },
): Promise<number> {
  return executeCommand({
    ...options,
    route: options.route ?? [options.spec.name],
    source: "test",
  });
}

// helper:捕获 stdout/stderr + exitCode
async function captureRun(app: { run: (a: string[]) => Promise<void> }, argv: string[]) {
  let out = "";
  let err = "";
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err += s;
    return true;
  }) as typeof process.stderr.write;
  await app.run(argv);
  process.stdout.write = o;
  process.stderr.write = e;
  return { out, err, code: process.exitCode };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("dispatch control and diagnostic output", () => {
  it("renders leading help without executing a matching command", async () => {
    const run = vi.fn(async () => ({ data: { changed: true } }));
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: { change: defineCommand({ name: "change", description: "change", run }) },
    });
    const result = await captureRun(app, ["--help", "change"]);
    expect(run).not.toHaveBeenCalled();
    expect(result.out).toContain("Usage:");
    expect(result.code).toBe(0);
  });

  it("does not echo unparsed values when a route is unknown", async () => {
    const app = defineCli({ name: "demo", description: "demo", commands: {} });
    const result = await captureRun(app, [
      "typo",
      "--api-key",
      "secret-key",
      "--input",
      '{"password":"secret-input"}',
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Unknown command");
    expect(result.err).not.toContain("secret-");
  });

  it("passes valid non-cloneable argv values to the handler", async () => {
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        echo: defineCommand({
          name: "echo",
          description: "echo",
          args: { schema: z.object({ value: z.string().transform((value) => () => value) }) },
          async run(_ctx, args) {
            return { data: { value: args.value() } };
          },
        }),
      },
    });
    const result = await captureRun(app, ["--json", "echo", "--value", "hello"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).data).toEqual({ value: "hello" });
  });
});

// ============================================================================
// BUG-R1 [P1]: --version 出现在命令之后仍触发全局版本输出,命令不执行
// 根因: define.ts:189 hasFlagBeforeSeparator 扫描整个 argv,没区分顶层 flag 和命令参数
// ============================================================================
describe("BUG-R1: --version 在命令之后不应触发全局版本输出", () => {
  it("`myapp list --version` 不应打印版本行(应执行 list 或把 --version 当未知 flag)", async () => {
    const app = defineCli({
      name: "myapp",
      description: "x",
      defaultFormat: "json",
      commands: {
        list: defineCommand({
          name: "list",
          description: "l",
          async run() {
            return { data: { ok: 1 } };
          },
        }),
      },
    });
    const r = await captureRun(app, ["list", "--version"]);
    // 关键不变量:stdout 不含 "myapp/" 版本行(那是全局 --version 的产物)
    expect(r.out).not.toContain("myapp/");
  });

  it("`myapp bogus --version`(未知命令)不应打印版本行,应报未知命令", async () => {
    const app = defineCli({
      name: "myapp",
      description: "x",
      defaultFormat: "json",
      commands: {
        list: defineCommand({
          name: "list",
          description: "l",
          async run() {
            return { data: { ok: 1 } };
          },
        }),
      },
    });
    const r = await captureRun(app, ["bogus", "--version"]);
    expect(r.out).not.toContain("myapp/");
    expect(r.code).toBe(2); // 未知命令 → validation exit 2
  });
});

// ============================================================================
// BUG-R2 [P1]: 框架参数和业务参数同名时语义不确定
// 新契约:api-key/json/help/version 由框架独占,定义命令时立即报错。
// ============================================================================
describe("BUG-R2: 框架保留参数不能由业务命令重新声明", () => {
  it.each(["api-key", "json", "help", "version"])("拒绝保留参数 %s", (name) => {
    expect(() =>
      defineCommand({
        name: "get",
        description: "g",
        args: { schema: z.object({ [name]: z.string() }) },
        async run() {
          return { data: null };
        },
      }),
    ).toThrow(`argument --${name} is reserved`);
  });
});

// ============================================================================
// BUG-R3 [中]: prettyPrint 对"单对象含数组字段"误判为数组,丢失其他字段
// 根因: pretty.ts:77-85 extractArray 对任何含数组字段的对象都返回首个数组
// ============================================================================
describe("BUG-R3: prettyPrint 单对象含数组字段不应丢失其他字段", () => {
  it("{name:'订单A', items:[1,2]} 应渲染出 name,而非只剩序号列表", () => {
    const out = prettyPrint({ name: "订单A", items: [1, 2, 3] });
    expect(out).toContain("name");
    expect(out).toContain("订单A");
  });
});

// ============================================================================
// BUG-R7 [中]: isOlderVersion 对非版本字符串('unknown')返回 true
// 根因: install-workflow.ts isOlderVersion Number("unknown")=NaN, NaN??0=NaN, 后续段 0<2 → true
// 说明:stepInstallGlobally 调用处已有 installedVer!=="unknown" 守卫,故 install 流程不受影响;
//      但 isOlderVersion 是导出的纯函数,"非版本 → true" 违反直觉契约,任何不带守卫的调用都会踩坑。
// ============================================================================
describe("BUG-R7: isOlderVersion 对非版本字符串应返回 false", () => {
  it("'unknown' vs '1.2.3' → 不应判为小于", async () => {
    const { isOlderVersion } = await import("../install-workflow.js");
    expect(isOlderVersion("unknown", "1.2.3")).toBe(false);
  });
});

// ============================================================================
// BUG-R9 [中]: --json 等全局 flag 出现在命令名之前被判为"未知命令"
// 根因: define.ts:306-310 matchRoute 只收 argv 头部连续非 flag token
// ============================================================================
describe("BUG-R9: --json 在命令名之前不应被判为未知命令", () => {
  it("`--json list` 应覆盖 human 默认格式并输出 JSON", async () => {
    let ran = false;
    const app = defineCli({
      name: "x",
      description: "x",
      defaultFormat: "human",
      commands: {
        list: defineCommand({
          name: "list",
          description: "l",
          async run() {
            ran = true;
            return { data: { ok: 1 } };
          },
        }),
      },
    });
    const r = await captureRun(app, ["--json", "list"]);
    expect(ran).toBe(true);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, data: { ok: 1 } });
  });
});

// ============================================================================
// BUG-R12 [低]: run 返回 {data: 标量} 不报 contract_violation,破坏 StructuredData 契约
// 根因: pipeline.ts:88-97 只检查 typeof object + hasOwnProperty("data"),不校验 data 形态
// ============================================================================
describe("BUG-R12: run 返回 {data: 标量} 应报 contract_violation", () => {
  it("{data: 123} → 非 StructuredData 应 exit 5", async () => {
    const cmd = defineCommand({
      name: "c",
      async run() {
        return { data: 123 };
      },
    });
    let errOut = "";
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => {
      errOut += s;
      return true;
    }) as typeof process.stderr.write;
    const code = await runCommand({ spec: cmd, args: {}, ctx: createTestCtx(), plugins: [] });
    process.stdout.write = o;
    process.stderr.write = e;
    expect(code).toBe(5);
    expect(JSON.parse(errOut).error.subtype).toBe("contract_violation");
  });
});
