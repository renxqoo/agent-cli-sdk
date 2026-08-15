/**
 * --json / --no-json 全局 flag 测试
 *
 * 验证:
 *   - 默认输出 JSON 统一输出(不变)
 *   - --no-json(TTY)→ 人类可读文本(通用兜底 prettyPrint)
 *   - --no-json + 命令声明 humanFormat → 用命令的自定义渲染
 *   - --no-json 错误(stderr)→ prettyError 文本
 *   - 管道保护:stdin 非 TTY 时 --no-json 强制 JSON
 *   - --json 显式强制 JSON(即使未来默认改了也保 JSON)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineCli, defineCommand, errs, prettyPrint } from "../index.js";
import { printTable } from "../pretty.js";
import * as z from "zod";

let stdoutBuf = "";
let stderrBuf = "";
let stdinIsTTY: boolean | undefined;
beforeEach(() => {
  stdoutBuf = "";
  stderrBuf = "";
  // 默认模拟 TTY(--no-json 生效);管道测试单独覆盖
  stdinIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  // 恢复原始 isTTY
  if (stdinIsTTY === undefined) {
    delete (process.stdin as { isTTY?: boolean }).isTTY;
  } else {
    Object.defineProperty(process.stdin, "isTTY", { value: stdinIsTTY, configurable: true });
  }
});

describe("--no-json: 默认 JSON 不变", () => {
  it("不传 flag → JSON 统一输出", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: { a: 1 } };
          },
        }),
      },
    });
    await app.run(["hello"]);
    expect(JSON.parse(stdoutBuf).ok).toBe(true);
    expect(JSON.parse(stdoutBuf).data.a).toBe(1);
  });
});

describe("--no-json: 人类可读文本(通用兜底)", () => {
  it("--no-json 对象 → key: value 详情(不是统一输出格式)", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: { a: 1 } };
          },
        }),
      },
    });
    await app.run(["hello", "--no-json"]);
    // prettyPrint 对单对象输出 key: value 详情;区别于统一输出格式:没有 ok/identity/data 骨架
    expect(stdoutBuf).toContain("a:  1");
    expect(stdoutBuf).not.toContain('"ok":true');
    expect(stdoutBuf).not.toContain('"data"');
  });

  it("--no-json 对象数组 → 自动表格(取对象 keys 当列)", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        list: defineCommand({
          name: "list",
          description: "x",
          async run() {
            return { data: [{ id: "o1" }, { id: "o2" }] };
          },
        }),
      },
    });
    await app.run(["list", "--no-json"]);
    // 自动表格:列名(id)+ 分隔行 + 数据行
    expect(stdoutBuf).toContain("id");
    expect(stdoutBuf).toContain("--");
    expect(stdoutBuf).toContain("o1");
    expect(stdoutBuf).toContain("o2");
  });

  it("--no-json {key:array} 单 key 包装 → 钻进去自动表格", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        list: defineCommand({
          name: "list",
          description: "x",
          async run() {
            return { data: { orders: [{ id: "o1", total: 199 }] } };
          },
        }),
      },
    });
    await app.run(["list", "--no-json"]);
    // 钻进 {orders:[...]} → 自动表格,列名是 id/total
    expect(stdoutBuf).toContain("id");
    expect(stdoutBuf).toContain("total");
    expect(stdoutBuf).toContain("o1");
    expect(stdoutBuf).toContain("199");
    expect(stdoutBuf).not.toContain("orders"); // 包装层不显示
  });

  it("--no-json {key:array, total:n} 多 key 包装 → 钻进首个数组(忽略伴随字段)", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        list: defineCommand({
          name: "list",
          description: "x",
          async run() {
            return { data: { products: [{ id: "p1", price: 39 }], total: 1 } };
          },
        }),
      },
    });
    await app.run(["list", "--no-json"]);
    // 钻进 {products:[...], total:1} → 自动表格(用 products 数组);total 伴随字段不影响
    expect(stdoutBuf).toContain("id");
    expect(stdoutBuf).toContain("price");
    expect(stdoutBuf).toContain("p1");
  });

  it("--no-json scalar 数组 → 序号列表", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        list: defineCommand({
          name: "list",
          description: "x",
          async run() {
            return { data: ["a", "b", "c"] };
          },
        }),
      },
    });
    await app.run(["list", "--no-json"]);
    // scalar 项 → 序号列表
    expect(stdoutBuf).toContain("1. a");
    expect(stdoutBuf).toContain("2. b");
    expect(stdoutBuf).toContain("3. c");
  });

  it("--no-json meta count → 附摘要行", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        list: defineCommand({
          name: "list",
          description: "x",
          async run() {
            return { data: [{ id: "o1" }], meta: { count: 1, pagination: { complete: true } } };
          },
        }),
      },
    });
    await app.run(["list", "--no-json"]);
    expect(stdoutBuf).toContain("1 item(s)");
    expect(stdoutBuf).toContain("all loaded");
  });

  it("--no-json null data → （无数据）", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        void: defineCommand({
          name: "void",
          description: "x",
          async run() {
            return { data: null };
          },
        }),
      },
    });
    await app.run(["void", "--no-json"]);
    expect(stdoutBuf.trim()).toBe("(no data)");
  });
});

describe("--no-json: 命令自定义 humanFormat", () => {
  it("声明 humanFormat → 用命令的渲染(不用兜底)", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          humanFormat: (data) => `CUSTOM:${JSON.stringify(data)}`,
          async run() {
            return { data: { a: 1 } };
          },
        }),
      },
    });
    await app.run(["hello", "--no-json"]);
    expect(stdoutBuf.trim()).toBe('CUSTOM:{"a":1}');
  });

  it("prettyPrint 可被业务复用(导出)", () => {
    expect(prettyPrint({ a: 1 })).toContain("a");
    expect(prettyPrint(null)).toBe("(no data)");
    expect(prettyPrint([1, 2])).toContain("1.");
  });
});

describe("printTable: 表格渲染工具", () => {
  it("空数组 → （空）", () => {
    expect(printTable([], [{ header: "ID", value: (r: { id: string }) => r.id }])).toBe("(empty)");
  });

  it("基本表格:标题行 + 分隔行 + 数据行,列对齐", () => {
    const out = printTable(
      [
        { id: "o1", total: 199 },
        { id: "o100", total: 5 },
      ],
      [
        { header: "ID", value: (r: { id: string; total: number }) => r.id },
        {
          header: "总额",
          value: (r: { id: string; total: number }) => `¥${r.total}`,
          align: "right",
        },
      ],
    );
    const lines = out.split("\n");
    // ID 列宽 4(max o100),总额列宽 4(max ¥199;标题"总额"显示宽 4)
    expect(lines[0]).toBe("ID    总额"); // 标题:ID padEnd 4 + 双空格 + 总额(显示宽 4=列宽,不补)
    expect(lines[1]).toBe("----  ----"); // 分隔:各列宽 4,双空格
    expect(lines[2]).toBe("o1    ¥199"); // o1 padEnd 4 + 双空格 + ¥199(宽 4=列宽)
    expect(lines[3]).toBe("o100    ¥5"); // o100(宽4) + 双空格 + ¥5 右对齐到 4(前补 2 空格)
  });

  it("CJK 中文列宽按显示宽度 2 列对齐(不被 .length 算成 1)", () => {
    const out = printTable(
      [{ name: "红" }, { name: "AB" }],
      [{ header: "名", value: (r: { name: string }) => r.name }],
    );
    const lines = out.split("\n");
    // "名" 显示宽 2,"红" 显示宽 2,"AB" 显示宽 2 → 列宽 2
    expect(lines[0]).toBe("名");
    expect(lines[1]).toBe("--");
    expect(lines[2]).toBe("红");
    expect(lines[3]).toBe("AB");
  });

  it("右对齐列:数值靠右", () => {
    const out = printTable(
      [{ n: 1 }, { n: 1000 }],
      [{ header: "N", value: (r: { n: number }) => r.n, align: "right" }],
    );
    const lines = out.split("\n");
    // 1000 宽 4,1 右对齐→"   1"
    expect(lines[2]).toBe("   1");
    expect(lines[3]).toBe("1000");
  });

  it("value 返回 null/undefined → 空字符串(不崩)", () => {
    const out = printTable([{ a: null }, { a: undefined }, { a: "x" }] as Array<{ a: unknown }>, [
      { header: "A", value: (r: { a: unknown }) => r.a },
    ]);
    const lines = out.split("\n");
    // 列宽 1(max "x");null/undefined → '' padEnd 到 1 = 一个空格
    expect(lines[2]).toBe(" ");
    expect(lines[3]).toBe(" ");
    expect(lines[4]).toBe("x");
  });
});

describe("--no-json: 错误也文本化(stderr)", () => {
  it("--no-json 命令抛错 → prettyError 到 stderr", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        fail: defineCommand({
          name: "fail",
          description: "x",
          async run() {
            throw new errs.APIError({
              subtype: "not_found",
              code: 404,
              message: "订单不存在",
              hint: "检查 ID",
            });
          },
        }),
      },
    });
    await app.run(["fail", "--no-json"]);
    expect(stderrBuf).toContain("error: 订单不存在");
    expect(stderrBuf).toContain("hint: 检查 ID");
    expect(stderrBuf).toContain("not_found");
    // stdout 不应有错误输出
    expect(stdoutBuf).toBe("");
  });

  it("默认模式错误 → JSON 错误输出到 stderr(--no-json 不传)", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        fail: defineCommand({
          name: "fail",
          description: "x",
          async run() {
            throw new errs.NotFoundError({ subtype: "not_found", message: "订单不存在" });
          },
        }),
      },
    });
    await app.run(["fail"]);
    const env = JSON.parse(stderrBuf.trim());
    expect(env.ok).toBe(false);
    expect(env.error.subtype).toBe("not_found");
  });
});

describe("管道保护:stdin 非 TTY 时 --no-json 强制 JSON", () => {
  it("被管道(isTTY=undefined)时 --no-json → 仍 JSON 统一输出", async () => {
    // 模拟管道:isTTY = undefined
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: { a: 1 } };
          },
        }),
      },
    });
    await app.run(["hello", "--no-json"]);
    // 管道保护:强制 JSON(不走 prettyPrint)
    expect(JSON.parse(stdoutBuf).ok).toBe(true);
    expect(JSON.parse(stdoutBuf).data.a).toBe(1);
  });
});

describe("--json: 显式强制 JSON", () => {
  it("--json 显式传 → JSON 统一输出(无论 TTY)", async () => {
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: { a: 1 } };
          },
        }),
      },
    });
    await app.run(["hello", "--json"]);
    expect(JSON.parse(stdoutBuf).ok).toBe(true);
  });
});

describe("--no-json: json 不进命令 args(框架 flag)", () => {
  it("命令的 args 收不到 json(被框架剔除)", async () => {
    let receivedArgs: Record<string, unknown> = {};
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          args: { schema: z.object({ name: z.string().optional() }) },
          async run(_ctx, args) {
            receivedArgs = args;
            return { data: { ok: true } };
          },
        }),
      },
    });
    await app.run(["hello", "--no-json", "--name", "world"]);
    expect(receivedArgs.name).toBe("world");
    expect(receivedArgs.json).toBeUndefined(); // json 被框架剔除,不进命令 args
  });
});

// ============================================================================
// defaultFormat: 业务选择默认输出格式(json / human / auto)
// isTTY 场景:stdin(管道保护判据)+ stdout(auto 判据)分别可控
// ============================================================================
function mkDataApp(
  defaultFormat: "json" | "human" | "auto",
  tty: { stdin?: boolean; stdout?: boolean },
) {
  if (tty.stdin !== undefined) {
    Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
  } else {
    delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
  if (tty.stdout !== undefined) {
    Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
  } else {
    delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
  return defineCli({
    name: "demo",
    description: "d",
    defaultFormat,
    commands: {
      hello: defineCommand({
        name: "hello",
        description: "x",
        async run() {
          return { data: { a: 1 } };
        },
      }),
    },
  });
}
function isJsonOut(buf: string): boolean {
  try {
    const e = JSON.parse(buf);
    return e.ok === true && "data" in e;
  } catch {
    return false;
  }
}
function isTextOut(buf: string): boolean {
  // 文本兜底:单对象 → "a:  1"(key: value),不是统一输出格式
  return buf.includes("a:") && !buf.includes('"ok"');
}

describe("defaultFormat: json(默认 JSON,agent-native)", () => {
  it("不传 flag + TTY → JSON(不被 TTY 影响)", async () => {
    stdoutBuf = "";
    const app = mkDataApp("json", { stdin: true, stdout: true });
    await app.run(["hello"]);
    expect(isJsonOut(stdoutBuf)).toBe(true);
  });

  it("--no-json 强制文本(覆盖默认 json)", async () => {
    stdoutBuf = "";
    const app = mkDataApp("json", { stdin: true, stdout: true });
    await app.run(["hello", "--no-json"]);
    expect(isTextOut(stdoutBuf)).toBe(true);
  });
});

describe("defaultFormat: human(默认文本,面向终端用户)", () => {
  it("不传 flag + TTY(stdin+stdout)→ 文本", async () => {
    stdoutBuf = "";
    const app = mkDataApp("human", { stdin: true, stdout: true });
    await app.run(["hello"]);
    expect(isTextOut(stdoutBuf)).toBe(true);
  });

  it("不传 flag + 非 TTY(管道:stdin 非 TTY)→ JSON(管道保护)", async () => {
    stdoutBuf = "";
    const app = mkDataApp("human", { stdin: false, stdout: true });
    await app.run(["hello"]);
    expect(isJsonOut(stdoutBuf)).toBe(true);
  });

  it("--json 强制 JSON(覆盖默认 human)", async () => {
    stdoutBuf = "";
    const app = mkDataApp("human", { stdin: true, stdout: true });
    await app.run(["hello", "--json"]);
    expect(isJsonOut(stdoutBuf)).toBe(true);
  });
});

describe("defaultFormat: auto(TTY→文本/非 TTY→JSON,默认值)", () => {
  it("不传 flag + stdout TTY → 文本", async () => {
    stdoutBuf = "";
    const app = mkDataApp("auto", { stdin: true, stdout: true });
    await app.run(["hello"]);
    expect(isTextOut(stdoutBuf)).toBe(true);
  });

  it("不传 flag + stdout 非 TTY → JSON", async () => {
    stdoutBuf = "";
    const app = mkDataApp("auto", { stdin: true, stdout: false });
    await app.run(["hello"]);
    expect(isJsonOut(stdoutBuf)).toBe(true);
  });

  it("不传 defaultFormat(省略)= auto 行为", async () => {
    stdoutBuf = "";
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const app = defineCli({
      name: "demo",
      description: "d",
      commands: {
        hello: defineCommand({
          name: "hello",
          description: "x",
          async run() {
            return { data: { a: 1 } };
          },
        }),
      },
    });
    await app.run(["hello"]);
    expect(isTextOut(stdoutBuf)).toBe(true);
  });
});
