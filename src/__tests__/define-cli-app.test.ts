/**
 * defineCliApp 装配器测试:services 注入、apply 顺序与失败语义、
 * dir/localState 二选一、defineAuth/defineInstaller 经装配后的路由可达性,
 * 以及 app 级生命周期钩子(onAppRun/afterAppRun)。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineAuth, defineCliApp, defineCommand, defineInstaller } from "../index.js";
import { createMemoryLocalState } from "../local-state.js";
import type { AppServices, Plugin } from "../types.js";

const roots: string[] = [];
let stdout = "";
let stderr = "";
const origIsTTY = process.stdin.isTTY;

beforeEach(() => {
  stdout = "";
  stderr = "";
  process.exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// installer 集成测试会跑 npm/whichBin 子进程:全部 stub 成成功 no-op。
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from("/fake/prefix/bin/demo")),
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: Buffer) => void,
    ) => {
      cb(null, Buffer.from(""));
    },
  ),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => true };
});

describe("defineCliApp: 装配器", () => {
  it("按注册序 apply 插件,services 携带 appName/binName/同一 localState", async () => {
    const order: string[] = [];
    const services: AppServices[] = [];
    const localState = createMemoryLocalState();
    const p1: Plugin = {
      name: "p1",
      async apply(servicesArg) {
        order.push("p1");
        services.push(servicesArg);
      },
    };
    const p2: Plugin = {
      name: "p2",
      async apply(servicesArg) {
        order.push("p2");
        services.push(servicesArg);
      },
    };

    const app = await defineCliApp({
      localState,
      name: "demo",
      binName: "demo-bin",
      description: "d",
      plugins: [p1, p2],
      commands: {},
    });

    expect(order).toEqual(["p1", "p2"]);
    expect(services[0]).toMatchObject({ appName: "demo", binName: "demo-bin" });
    expect(services[0]!.localState).toBe(localState);
    expect(services[1]!.localState).toBe(localState);
    expect(app.name).toBe("demo");
  });

  it("dir 与 localState 二选一:dir 会创建文件本地状态", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-cli-app-"));
    roots.push(root);
    const seen: unknown[] = [];
    const probe: Plugin = {
      name: "probe",
      async apply(servicesArg) {
        seen.push(servicesArg.localState.kind);
      },
    };

    await defineCliApp({
      dir: root,
      name: "demo",
      description: "d",
      plugins: [probe],
      commands: {},
    });

    expect(seen).toEqual(["file"]);
  });

  it("任一插件 apply 失败 → defineCliApp reject(启动失败,不静默降级)", async () => {
    const broken: Plugin = {
      name: "broken",
      async apply() {
        throw new Error("assembly failed");
      },
    };
    await expect(
      defineCliApp({
        localState: createMemoryLocalState(),
        name: "demo",
        description: "d",
        plugins: [broken],
        commands: {},
      }),
    ).rejects.toThrow("assembly failed");
  });

  it("defineAuth 经装配后 auth 命令可路由(apply 填充 provides)", async () => {
    const app = await defineCliApp({
      localState: createMemoryLocalState(),
      name: "demo",
      description: "d",
      defaultFormat: "json",
      plugins: [defineAuth({ credentialNamespace: "crm", baseUrl: "http://t" })],
      commands: {},
    });

    // 未登录 → auth status 命中路由并返回 { loggedIn: false }(exit 0),
    // 而非 unknown command(exit 2)—— 证明 apply 已填充 provides
    await app.run(["auth", "status"]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout).data.loggedIn).toBe(false);
  });

  it("defineInstaller 经装配后 install 是顶层命令(skipPluginHooks 路由)", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-cli-app-"));
    roots.push(root);
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const app = await defineCliApp({
        dir: root,
        name: "demo",
        description: "d",
        defaultFormat: "json",
        plugins: [defineInstaller({ binName: "demo", pkgName: "demo-pkg" })],
        commands: {},
      });

      await app.run(["install"]);
      expect(process.exitCode).toBe(0);
      expect(stdout).toBe("");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });
});

describe("app 级生命周期钩子", () => {
  it("onAppRun/afterAppRun 每次 run 恰一次,覆盖未知命令与 help 路径", async () => {
    const events: string[] = [];
    const lifecycle: Plugin = {
      name: "lifecycle",
      async onAppRun() {
        events.push("on");
      },
      async afterAppRun(event) {
        events.push(`after:${event.exitCode}`);
      },
    };
    const app = await defineCliApp({
      localState: createMemoryLocalState(),
      name: "demo",
      description: "d",
      plugins: [lifecycle],
      commands: {},
    });

    await app.run(["nope"]);
    expect(process.exitCode).toBe(2);
    await app.run(["--help"]);
    expect(process.exitCode).toBe(0);

    expect(events).toEqual(["on", "after:2", "on", "after:0"]);
  });

  it("钩子失败静默,不改变命令输出与退出码", async () => {
    const noisy: Plugin = {
      name: "noisy-lifecycle",
      async onAppRun() {
        throw new Error("onAppRun boom");
      },
      async afterAppRun() {
        throw new Error("afterAppRun boom");
      },
    };
    const app = await defineCliApp({
      localState: createMemoryLocalState(),
      name: "demo",
      description: "d",
      defaultFormat: "json",
      plugins: [noisy],
      commands: {
        ok: defineCommand({
          name: "ok",
          description: "succeed",
          async run() {
            return { data: { value: 42 } };
          },
        }),
      },
    });

    await app.run(["ok", "--json"]);

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout).data).toEqual({ value: 42 });
    expect(stderr).toBe("");
  });
});
