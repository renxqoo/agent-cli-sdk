import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineCommand, defineCommands, errs } from "../index.js";
import { NotFoundError } from "../errs/index.js";
import { createTestCtx } from "../test-utils.js";
import { runCommand as executeCommand, type RunCommandOptions } from "../pipeline.js";
import type { CommandSpec, Plugin } from "../types.js";
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

// 捕获 stdout/stderr
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
});
afterEach(() => {
  vi.restoreAllMocks();
});

// 模拟 orders list 命令
const listCommand = defineCommand({
  name: "list",
  description: "查询订单列表",
  args: { schema: z.object({ limit: z.coerce.number().default(30) }) },
  async run(ctx, args) {
    const res = await ctx.get<{ items: Array<{ id: string; total: number }>; hasMore: boolean }>(
      "/orders",
      { limit: args.limit },
    );
    return {
      data: res.data.items,
      meta: {
        count: res.data.items.length,
        pagination: { complete: !res.data.hasMore },
      },
    };
  },
});

const getCommand = defineCommand({
  name: "get",
  description: "查询订单详情",
  args: { schema: z.object({ id: z.string() }), pos: ["id"] },
  async run(ctx, { id }) {
    const res = await ctx.get(`/orders/${id}`);
    if (res.status === 404) throw new errs.NotFoundError(`订单 ${id} 不存在`);
    return { data: res.data };
  },
});

describe("pipeline: 成功路径(runCommand + 统一输出格式)", () => {
  it("list 返回数组 data + 分页 meta,stdout 是统一输出格式", async () => {
    const ctx = createTestCtx({
      request: async () => ({
        status: 200,
        data: {
          items: [
            { id: "o1", total: 100 },
            { id: "o2", total: 200 },
          ],
          hasMore: false,
        },
        headers: {},
      }),
    });
    const code = await runCommand({ spec: listCommand, args: { limit: 30 }, ctx, plugins: [] });
    expect(code).toBe(0);
    const env = JSON.parse(stdoutBuf);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual([
      { id: "o1", total: 100 },
      { id: "o2", total: 200 },
    ]);
    expect(env.meta.count).toBe(2);
    expect(env.meta.pagination.complete).toBe(true);
  });

  it("data 业务字段 camelCase 不被转 snake_case", async () => {
    const ctx = createTestCtx({
      request: async () => ({
        status: 200,
        data: { items: [{ userId: "u1", orderCount: 3 }] },
        headers: {},
      }),
    });
    await runCommand({ spec: listCommand, args: { limit: 30 }, ctx, plugins: [] });
    const env = JSON.parse(stdoutBuf);
    expect(env.data[0].userId).toBe("u1");
    expect(env.data[0].orderCount).toBe(3);
  });
});

describe("pipeline: 错误路径(throw → stderr 统一输出格式 + exit code)", () => {
  it("404 → NotFoundError → stderr 错误输出 + exit 1", async () => {
    const ctx = createTestCtx({
      request: async () => ({ status: 404, data: {}, headers: {} }),
    });
    const code = await runCommand({ spec: getCommand, args: { id: "x" }, ctx, plugins: [] });
    expect(code).toBe(1);
    expect(stdoutBuf).toBe(""); // stdout 纯净
    const env = JSON.parse(stderrBuf);
    expect(env.ok).toBe(false);
    expect(env.error.type).toBe("api");
    expect(env.error.subtype).toBe("not_found");
    expect(env.error.code).toBe(404);
  });

  it("裸 Error 兜底成 internal/unknown + exit 5", async () => {
    const badCmd = defineCommand({
      name: "bad",
      description: "throw 裸 Error",
      async run() {
        throw new Error("boom");
      },
    });
    const ctx = createTestCtx();
    const code = await runCommand({ spec: badCmd, args: {}, ctx, plugins: [] });
    expect(code).toBe(5);
    const env = JSON.parse(stderrBuf);
    expect(env.error.type).toBe("internal");
    expect(env.error.subtype).toBe("unknown");
  });

  it("BareError 只设 exit code,不渲染 stderr 统一输出格式", async () => {
    const predicate = defineCommand({
      name: "check",
      description: "谓词",
      async run() {
        throw new errs.BareError(3);
      },
    });
    const ctx = createTestCtx();
    const code = await runCommand({ spec: predicate, args: {}, ctx, plugins: [] });
    expect(code).toBe(3);
    expect(stderrBuf).toBe("");
  });
});

describe("pipeline: explicit error handling", () => {
  it("observeError can enrich an error without controlling execution", async () => {
    const addHint: Plugin = {
      name: "add-hint",
      async observeError(_ctx, err) {
        if (err instanceof NotFoundError && !err.hint) {
          err.hint = "用 list 查有效 ID";
        }
      },
    };
    const ctx = createTestCtx({ request: async () => ({ status: 404, data: {}, headers: {} }) });
    await runCommand({ spec: getCommand, args: { id: "x" }, ctx, plugins: [addHint] });
    const env = JSON.parse(stderrBuf);
    expect(env.error.hint).toBe("用 list 查有效 ID");
  });

  it("handleError requires an explicit recovery decision", async () => {
    const fallback: Plugin = {
      name: "fallback",
      async handleError() {
        return { action: "recover", result: { data: { cached: true } } };
      },
    };
    const ctx = createTestCtx({ request: async () => ({ status: 404, data: {}, headers: {} }) });
    const code = await runCommand({
      spec: getCommand,
      args: { id: "x" },
      ctx,
      plugins: [fallback],
    });
    expect(code).toBe(0);
    const env = JSON.parse(stdoutBuf);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ cached: true });
  });

  it("a failed error handler preserves the original structured error", async () => {
    const brokenHook: Plugin = {
      name: "broken-error-hook",
      async handleError() {
        throw new Error("hook crashed");
      },
    };
    const ctx = createTestCtx({ request: async () => ({ status: 404, data: {}, headers: {} }) });
    const code = await runCommand({
      spec: getCommand,
      args: { id: "x" },
      ctx,
      plugins: [brokenHook],
    });

    expect(code).toBe(1);
    expect(JSON.parse(stderrBuf).error).toMatchObject({
      type: "api",
      subtype: "not_found",
    });
  });
});

describe("pipeline: void 返回(纯副作用命令)", () => {
  it("run 不 return → 空成功输出 + exit 0", async () => {
    const sideEffect = defineCommand({
      name: "noop",
      description: "无输出",
      async run() {
        // 纯副作用,不 return
      },
    });
    const ctx = createTestCtx();
    const code = await runCommand({ spec: sideEffect, args: {}, ctx, plugins: [] });
    expect(code).toBe(0);
    const env = JSON.parse(stdoutBuf);
    expect(env.ok).toBe(true);
    expect(env.data).toBeNull();
  });
});

describe("pipeline: CommandResult runtime contract", () => {
  it("rejects an object result without an own data field", async () => {
    const broken = defineCommand({
      name: "broken",
      description: "broken",
      async run() {
        return {} as never;
      },
    });
    const code = await runCommand({ spec: broken, args: {}, ctx: createTestCtx(), plugins: [] });
    expect(code).toBe(5);
    expect(JSON.parse(stderrBuf).error.subtype).toBe("contract_violation");
  });

  it("rejects undefined returned by transformOutput", async () => {
    const command = defineCommand({
      name: "output",
      description: "output",
      async run() {
        return { data: { ok: true } };
      },
    });
    const plugin: Plugin = {
      name: "broken-output",
      async transformOutput() {
        return undefined as never;
      },
    };
    const code = await runCommand({
      spec: command,
      args: {},
      ctx: createTestCtx(),
      plugins: [plugin],
    });
    expect(code).toBe(5);
    expect(JSON.parse(stderrBuf).error.subtype).toBe("contract_violation");
  });
});

describe("pipeline: lazy argument validation", () => {
  it("routes parse errors through observeError and human-readable rendering", async () => {
    let seen: unknown;
    const observer: Plugin = {
      name: "observer",
      async observeError(_ctx, err) {
        seen = err;
      },
    };
    const command = defineCommand({
      name: "list",
      description: "list",
      async run() {
        return { data: null };
      },
    });
    const code = await runCommand({
      spec: command,
      args: () => {
        throw new errs.ValidationError({ subtype: "invalid_argument", message: "bad limit" });
      },
      ctx: createTestCtx(),
      plugins: [observer],
      humanReadable: true,
    });
    expect(code).toBe(2);
    expect(seen).toBeInstanceOf(errs.ValidationError);
    expect(stderrBuf).toContain("error: bad limit");
    expect(() => JSON.parse(stderrBuf)).toThrow();
  });
});

describe("skipPluginHooks 命令跳过 beforeCommand", () => {
  it("skipPluginHooks 命令不跑 beforeCommand(不走 auth/凭证校验)", async () => {
    let beforeRan = false;
    const internalCmd = defineCommand({
      name: "skills",
      description: "internal",
      skipPluginHooks: true,
      async run() {
        return { data: { ok: true } };
      },
    });
    const probePlugin: Plugin = {
      name: "probe",
      enforce: "pre",
      async beforeCommand() {
        beforeRan = true;
      },
    };
    const ctx = createTestCtx();
    const code = await runCommand({ spec: internalCmd, args: {}, ctx, plugins: [probePlugin] });
    expect(code).toBe(0);
    expect(beforeRan).toBe(false); // internal 跳过了 beforeCommand
  });
});

describe("精确豁免:plugin 自己的命令跳自己的 beforeCommand(route 传入时)", () => {
  it("plugin A 贡献 cmd → 跑 cmd 时 A 的 beforeCommand 不跑(route 命中 ownership map)", async () => {
    let beforeA = false;
    const ownedCmd = defineCommand({
      name: "login",
      description: "owned by plugin A",
      async run() {
        return { data: { ok: true } };
      },
    });
    const pluginA: Plugin = {
      name: "A",
      async beforeCommand() {
        beforeA = true;
      },
    };
    const ctx = createTestCtx();
    const code = await runCommand({
      spec: ownedCmd,
      args: {},
      ctx,
      plugins: [pluginA],
      route: ["login"],
      ownedRoutes: new Map([[pluginA, [["login"]]]]),
    });
    expect(code).toBe(0);
    expect(beforeA).toBe(false); // route 命中 _ownedRoutes → 豁免 A 自身
  });

  it("plugin B(非 owner)的 beforeCommand 照跑(不误伤别的 plugin)", async () => {
    let beforeA = false;
    let beforeB = false;
    const ownedCmd = defineCommand({
      name: "login",
      description: "owned by plugin A",
      async run() {
        return { data: { ok: true } };
      },
    });
    const pluginA: Plugin = {
      name: "A",
      async beforeCommand() {
        beforeA = true;
      },
    };
    const pluginB: Plugin = {
      name: "B",
      async beforeCommand() {
        beforeB = true;
      },
    };
    const ctx = createTestCtx();
    await runCommand({
      spec: ownedCmd,
      args: {},
      ctx,
      plugins: [pluginA, pluginB],
      route: ["login"],
      ownedRoutes: new Map([[pluginA, [["login"]]]]),
    });
    expect(beforeA).toBe(false); // A 是 owner → 豁免
    expect(beforeB).toBe(true); // B 不是 owner → 照跑
  });

  it('namespace 路径的 ownedRoute 精确豁免(["auth","login"])', async () => {
    let beforeA = false;
    const loginCmd = defineCommand({
      name: "login",
      description: "x",
      async run() {
        return { data: { ok: true } };
      },
    });
    const pluginA: Plugin = {
      name: "A",
      async beforeCommand() {
        beforeA = true;
      },
    };
    const ctx = createTestCtx();
    await runCommand({
      spec: loginCmd,
      args: {},
      ctx,
      plugins: [pluginA],
      route: ["auth", "login"],
      ownedRoutes: new Map([[pluginA, [["auth", "login"]]]]),
    });
    expect(beforeA).toBe(false); // 两段路径都匹配 → 豁免
  });
});

describe("defineCommands: 命令组校验", () => {
  it("缺少 name 抛错", () => {
    expect(() =>
      defineCommands({ bad: { description: "x", run: async () => {} } as unknown as CommandSpec }),
    ).toThrow(/name/);
  });

  it("缺少 run 抛错", () => {
    expect(() =>
      defineCommands({ bad: { name: "bad", description: "x" } as unknown as CommandSpec }),
    ).toThrow(/run/);
  });
});
