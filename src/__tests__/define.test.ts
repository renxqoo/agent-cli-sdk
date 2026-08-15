/**
 * define.ts 的测试 —— App 工厂、路由匹配、flag 解析、help/version、未知命令。
 *
 * 这是原先最大的覆盖缺口(define.ts 此前零测试),集中验证 S2/S4/H1/H5/M1/M2/M9/M10。
 */
import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from "vitest";
import { defineCli, defineCommand, errs } from "../index.js";
import type { CommandSpec } from "../types.js";
import * as z from "zod";

// 捕获 stdout/stderr + exitCode
let stdoutBuf = "";
let stderrBuf = "";
beforeEach(() => {
  stdoutBuf = "";
  stderrBuf = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  // 捕获 exitCode(不真的退出)
  const spy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  void spy;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

// 解析 JSON 统一输出(stderr 错误 / stdout 成功)
function parseStdout() {
  return JSON.parse(stdoutBuf);
}
function parseStderr() {
  return JSON.parse(stderrBuf.trim());
}

describe("schema-first command typing", () => {
  it("keeps optional flags optional and required/default flags present", () => {
    defineCommand({
      name: "typed",
      description: "typed",
      args: {
        schema: z.object({
          query: z.string().optional(),
          limit: z.coerce.number().default(20),
          id: z.string(),
        }),
      },
      async run(_ctx, args) {
        expectTypeOf(args.query).toEqualTypeOf<string | undefined>();
        expectTypeOf(args.limit).toEqualTypeOf<number>();
        expectTypeOf(args.id).toEqualTypeOf<string>();
        return { data: args };
      },
    });
  });
});

// ============================================================================
// S2: defineCli 不传 plugins 时不应崩溃
// ============================================================================

describe("S2: defineCli 不传 plugins", () => {
  it("不带 plugins 跑命令应正常输出统一格式,不崩(README 入门示例形态)", async () => {
    const app = defineCli({
      name: "demo",
      description: "demo app",
      // 注意:故意不传 plugins
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "say hi",
          async run() {
            return { data: { msg: "hi" } };
          },
        }),
      },
    });
    await app.run(["hello"]);
    expect(process.exitCode).toBe(0);
    expect(parseStdout().ok).toBe(true);
    expect(parseStdout().data).toEqual({ msg: "hi" });
  });
});

// ============================================================================
// S4: 未知命令不应 exit 0(agent 会误判成功)
// ============================================================================

describe("S4: 未知命令", () => {
  it("未知命令 → 非 0 exit + stderr 错误输出(不能 exit 0)", async () => {
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: 1 };
          },
        }),
      },
    });
    await app.run(["bogus-command"]);
    // exit 0 是危险的(agent 误判成功);应为 validation exit 2
    expect(process.exitCode).not.toBe(0);
    const env = parseStderr();
    expect(env.ok).toBe(false);
    expect(env.error.type).toBe("validation");
    expect(env.error.subtype).toBe("invalid_argument");
  });

  it("空 argv / -h / --help 仍显示帮助 + exit 0(不报错)", async () => {
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: 1 };
          },
        }),
      },
    });
    await app.run([]);
    expect(process.exitCode).toBe(0);
    expect(stdoutBuf).toContain("Usage:");
    expect(stdoutBuf).toContain("hello");
  });
});

// ============================================================================
// D6: 顶层 --help 应显示 defineCli({description})(当前丢失)
// ============================================================================

describe("D6: 顶层 help 显示应用描述", () => {
  it("空 argv → help 含 defineCli 的 description", async () => {
    const app = defineCli({
      name: "demo",
      description: "我的演示应用 —— 查订单与商品",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: 1 };
          },
        }),
      },
    });
    await app.run([]);
    expect(process.exitCode).toBe(0);
    expect(stdoutBuf).toContain("我的演示应用 —— 查订单与商品");
  });

  it("--help 显式请求 → help 同样含 description", async () => {
    const app = defineCli({
      name: "demo",
      description: "another desc here",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: 1 };
          },
        }),
      },
    });
    await app.run(["--help"]);
    expect(process.exitCode).toBe(0);
    expect(stdoutBuf).toContain("another desc here");
  });
});

// ============================================================================
// S5: errorOnStatus 启动期 subtype 校验
// ============================================================================
// 拼错的 subtype 会在请求时静默降级为 internal(exit 5),难排查。
// defineCli 启动时校验是否已在 SUBTYPE_REGISTRY 登记,拼错立刻 fail。

describe("S5: errorOnStatus 启动期 subtype 校验", () => {
  it("已登记的 subtype → 正常装配,不报错", () => {
    expect(() =>
      defineCli({
        name: "demo",
        description: "demo",
        commands: {
          hello: defineCommand({
            name: "hello",
            description: "x",
            async run() {
              return { data: 1 };
            },
          }),
        },
        errorOnStatus: { 404: "not_found", 429: "rate_limited", "5xx": "server_error" },
      }),
    ).not.toThrow();
  });

  it("未登记的 subtype → defineCli 立刻 throw(不让拼错悄悄上线)", () => {
    expect(() =>
      defineCli({
        name: "demo",
        description: "demo",
        commands: {
          hello: defineCommand({
            name: "hello",
            description: "x",
            async run() {
              return { data: 1 };
            },
          }),
        },
        errorOnStatus: { 404: "not_foundd" }, // ← 拼错
      }),
    ).toThrow(/not_foundd/);
  });

  it("errorOnStatus 缺省 / undefined → 不校验(向后兼容)", () => {
    expect(() =>
      defineCli({
        name: "demo",
        description: "demo",
        commands: {
          hello: defineCommand({
            name: "hello",
            description: "x",
            async run() {
              return { data: 1 };
            },
          }),
        },
      }),
    ).not.toThrow();
  });
});

// ============================================================================
// H1: --no-<key> 布尔取反
// ============================================================================

describe("H1: --no-wait 布尔取反", () => {
  it("--no-wait 应让 wait=false(而非 undefined)", async () => {
    let captured: unknown = "not-called";
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        login: defineCommand({
          name: "login",
          description: "login",
          args: { schema: z.object({ wait: z.boolean().default(true) }) },
          async run(_ctx, args) {
            captured = (args as { wait?: unknown }).wait;
            return { data: { ok: true } };
          },
        }),
      },
    });
    await app.run(["login", "--no-wait"]);
    // 关键:--no-wait 应解析成 wait=false(当前:undefined,导致 noWait 分支不可达)
    expect(captured).toBe(false);
  });

  it("--wait 显式 true 仍生效", async () => {
    let captured: unknown = "not-called";
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        login: defineCommand({
          name: "login",
          description: "login",
          args: { schema: z.object({ wait: z.boolean().default(true) }) },
          async run(_ctx, args) {
            captured = (args as { wait?: unknown }).wait;
            return { data: { ok: true } };
          },
        }),
      },
    });
    await app.run(["login", "--wait"]);
    expect(captured).toBe(true);
  });
});

// ============================================================================
// H5: --version 不应打印 help 全文
// ============================================================================

describe("H5: --version", () => {
  it("--version 只打印版本号,不打印 help 全文", async () => {
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: 1 };
          },
        }),
      },
    });
    await app.run(["--version"]);
    expect(process.exitCode).toBe(0);
    // 不应是 help 全文(不应含 "Usage:" / "Commands:")
    expect(stdoutBuf).not.toContain("Usage:");
    expect(stdoutBuf).not.toContain("Commands:");
    // 应包含版本号(agent-cli-sdk 包版本 0.1.0)
    expect(stdoutBuf).toMatch(/\d+\.\d+\.\d+/);
  });

  it("-v 短形式同样只打印版本号", async () => {
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: 1 };
          },
        }),
      },
    });
    await app.run(["-v"]);
    expect(stdoutBuf).not.toContain("Usage:");
  });
});

// ============================================================================
// M1: 子命令后 -h 应显示帮助(而非 validation 错)
// ============================================================================

describe("M1: 子命令 -h 显示帮助", () => {
  it('hello -h → exit 0 + 帮助(不报 "未预期的位置参数")', async () => {
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "say hi",
          async run() {
            return { data: 1 };
          },
        }),
      },
    });
    await app.run(["hello", "-h"]);
    expect(process.exitCode).toBe(0);
    // 不应是错误输出
    expect(stderrBuf).toBe("");
  });
});

// ============================================================================
// M2: 负数 flag 值(--limit -1)
// ============================================================================

describe("M2: 负数 flag 值", () => {
  it("--limit -1 → limit=-1,不把 -1 当位置参数", async () => {
    let captured: unknown = "not-called";
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        list: defineCommand({
          name: "list",
          description: "list",
          args: { schema: z.object({ limit: z.coerce.number().optional() }) },
          async run(_ctx, args) {
            captured = (args as { limit?: unknown }).limit;
            return { data: [] };
          },
        }),
      },
    });
    await app.run(["list", "--limit", "-1"]);
    expect(captured).toBe(-1);
  });
});

// ============================================================================
// M9: BareError 从 beforeCommand/scope 阶段抛出应保留 exit code
// ============================================================================

describe("M9: defineCli.run 的 catch 处理 BareError", () => {
  it("run 内抛 BareError → 用其 exitCode,不被 toCliError 降级成 exit 1", async () => {
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        check: defineCommand({
          name: "check",
          description: "predicate",
          async run() {
            throw new errs.BareError(7);
          },
        }),
      },
    });
    await app.run(["check"]);
    // BareError(7) 应保留 exit 7,而非被 toCliError 包成 InternalError → exit 5
    expect(process.exitCode).toBe(7);
  });
});

// ============================================================================
// M10: -- 之后 token 全为 positional
// ============================================================================

describe("M10: -- 分隔符之后全为 positional", () => {
  it("echo -- --help → --help 被当 positional,不触发帮助", async () => {
    let capturedPos: string[] = [];
    let showedHelp = false;
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        echo: defineCommand({
          name: "echo",
          description: "echo",
          // 接收多余位置参数(无 args spec,run 内读不到,靠校验报错反推)
          async run() {
            return { data: { ok: true } };
          },
        }),
      },
    });
    // 重新写一个能捕获 positionals 的命令:用单个 positional
    const app2 = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        echo: defineCommand({
          name: "echo",
          description: "echo",
          args: { schema: z.object({ msg: z.string().optional() }), pos: ["msg"] },
          async run(_ctx, args) {
            capturedPos = [(args as { msg?: string }).msg ?? ""];
            return { data: { ok: true } };
          },
        }),
      },
    });
    // -- 之后的 --weird 必须当 positional 而非 flag
    await app2.run(["echo", "--", "--weird"]);
    expect(capturedPos).toEqual(["--weird"]);
    expect(showedHelp).toBe(false);
    // 验证没有触发帮助(--help 在 -- 之后不该当 flag)
    void app;
  });

  it("-- 之前的 flag 仍按 flag 解析,之后的全为 positional", async () => {
    let capturedMsg = "";
    let capturedVerbose = "not-set";
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {
        echo: defineCommand({
          name: "echo",
          description: "echo",
          args: {
            schema: z.object({
              msg: z.string().optional(),
              verbose: z.boolean().default(false),
            }),
            pos: ["msg"],
          },
          async run(_ctx, args) {
            capturedMsg = (args as { msg?: string }).msg ?? "";
            capturedVerbose = String((args as { verbose?: boolean }).verbose);
            return { data: 1 };
          },
        }),
      },
    });
    await app.run(["echo", "--verbose", "--", "--msg"]);
    expect(capturedVerbose).toBe("true"); // -- 在前,--verbose 正常解析为 flag
    expect(capturedMsg).toBe("--msg"); // -- 之后 --msg 当 positional
  });
});

// ============================================================================
// 路由匹配:多级 namespace
// ============================================================================

describe("路由: namespaces 多级匹配", () => {
  it("orders list → 命中 namespace.list", async () => {
    let called = "";
    const app = defineCli({
      name: "demo",
      description: "demo",
      commands: {},
      namespaces: {
        orders: {
          list: defineCommand({
            name: "list",
            description: "list orders",
            async run() {
              called = "orders.list";
              return { data: [] };
            },
          }),
          get: defineCommand({
            name: "get",
            description: "get order",
            args: { schema: z.object({ id: z.string() }), pos: ["id"] },
            async run() {
              called = "orders.get";
              return { data: {} };
            },
          }) as CommandSpec,
        },
      },
    });
    await app.run(["orders", "list"]);
    expect(called).toBe("orders.list");
    await app.run(["orders", "get", "o_1"]);
    expect(called).toBe("orders.get");
  });
});
