/**
 * plugin.provides 自动注入测试 —— defineCli 收集 plugin 贡献的命令/namespaces,
 * 合并规则(同 ns 不同命令 merge / 同 ns 同命令 defineCli 覆盖 / defineCli 独有不受影响)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineCli, defineCommand } from "../index.js";
import type { Plugin, CommandSpec } from "../types.js";

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
  process.exitCode = undefined;
});

function parseStdout() {
  return JSON.parse(stdoutBuf);
}

// 简单命令工厂:返回 { data: { marker } }
function mkCmd(name: string, marker: string): CommandSpec {
  return defineCommand({
    name,
    description: `${name} cmd`,
    async run() {
      return { data: { marker } };
    },
  });
}

describe("plugin.provides.commands: 顶层命令自动注入", () => {
  it("plugin 贡献顶层命令 → app.run 能命中(无需 defineCli 手挂)", async () => {
    const p: Plugin = {
      name: "telemetry",
      provides: { commands: { telemetry: mkCmd("telemetry", "from-plugin") } },
    };
    const app = defineCli({ name: "demo", description: "d", plugins: [p], commands: {} });
    await app.run(["telemetry"]);
    expect(parseStdout().data.marker).toBe("from-plugin");
  });

  it("defineCli 同名顶层命令覆盖 plugin 贡献的(业务赢)", async () => {
    const p: Plugin = {
      name: "telemetry",
      provides: { commands: { telemetry: mkCmd("telemetry", "from-plugin") } },
    };
    const app = defineCli({
      name: "demo",
      description: "d",
      plugins: [p],
      commands: { telemetry: mkCmd("telemetry", "from-app") },
    });
    await app.run(["telemetry"]);
    expect(parseStdout().data.marker).toBe("from-app");
  });
});

describe("plugin.provides.namespaces: namespace 命令自动注入", () => {
  it('plugin 贡献 namespace 命令 → app.run(["ns","cmd"]) 能命中', async () => {
    const p: Plugin = {
      name: "auth",
      provides: { namespaces: { auth: { login: mkCmd("login", "plugin-login") } } },
    };
    const app = defineCli({ name: "demo", description: "d", plugins: [p], commands: {} });
    await app.run(["auth", "login"]);
    expect(parseStdout().data.marker).toBe("plugin-login");
  });

  it("同 namespace 不同命令 → merge(plugin 给 login,业务加 register,合一起)", async () => {
    const p: Plugin = {
      name: "auth",
      provides: { namespaces: { auth: { login: mkCmd("login", "plugin-login") } } },
    };
    const app = defineCli({
      name: "demo",
      description: "d",
      plugins: [p],
      commands: {},
      namespaces: { auth: { register: mkCmd("register", "app-register") } },
    });
    // 两次 run 共用同一 stdout spy(envelope 不带 \n),故每次跑前重置 buffer
    stdoutBuf = "";
    await app.run(["auth", "login"]);
    expect(parseStdout().data.marker).toBe("plugin-login");
    stdoutBuf = "";
    await app.run(["auth", "register"]);
    expect(parseStdout().data.marker).toBe("app-register");
  });

  it("同 namespace 同命令 → defineCli 覆盖 plugin", async () => {
    const p: Plugin = {
      name: "auth",
      provides: { namespaces: { auth: { login: mkCmd("login", "plugin") } } },
    };
    const app = defineCli({
      name: "demo",
      description: "d",
      plugins: [p],
      commands: {},
      namespaces: { auth: { login: mkCmd("login", "app") } },
    });
    await app.run(["auth", "login"]);
    expect(parseStdout().data.marker).toBe("app");
  });

  it("defineCli 独有的 namespace 不受 plugin 影响", async () => {
    const p: Plugin = {
      name: "auth",
      provides: { namespaces: { auth: { login: mkCmd("login", "plugin") } } },
    };
    const app = defineCli({
      name: "demo",
      description: "d",
      plugins: [p],
      commands: {},
      namespaces: { orders: { list: mkCmd("list", "orders-list") } },
    });
    await app.run(["orders", "list"]);
    expect(parseStdout().data.marker).toBe("orders-list");
  });
});

describe("plugin.provides: route ownership", () => {
  it("does not mutate the input plugin while keeping ownership internal to the app", async () => {
    let guardCalls = 0;
    const p: Plugin = {
      name: "auth",
      async beforeCommand() {
        guardCalls++;
      },
      provides: {
        namespaces: { auth: { login: mkCmd("login", "x"), logout: mkCmd("logout", "x") } },
        commands: { whoami: mkCmd("whoami", "x") },
      },
    };
    const app = defineCli({ name: "demo", description: "d", plugins: [p], commands: {} });
    await app.run(["auth", "login"]);
    expect(guardCalls).toBe(0);
    expect(p).not.toHaveProperty("_ownedRoutes");
  });
});
