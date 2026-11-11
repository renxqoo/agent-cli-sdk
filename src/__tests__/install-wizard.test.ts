/**
 * installer 插件测试 —— 测纯函数部分(formatInstallMessage/isOlderVersion)+
 * install 命令的装配行为(skipPluginHooks、rawText/BareError 退出码、--lang 透传)。
 * 真实 npm/网络/clack 交互靠手动冒烟,不在此单测。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatInstallMessage, isOlderVersion } from "../install-workflow.js";
import { defineInstaller, type DefineInstallerOptions } from "../installer.js";
import { createLocalState, createMemoryLocalState } from "../local-state.js";
import { createTestCtx } from "../test-utils.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("formatInstallMessage: 占位符替换", () => {
  it("单占位符", () => {
    expect(formatInstallMessage("a %s b", "x")).toBe("a x b");
  });
  it("多占位符", () => {
    expect(formatInstallMessage("a %s b %s", "x", "y")).toBe("a x b y");
  });
  it("占位符多于实参 → 填空串", () => {
    expect(formatInstallMessage("a %s b %s", "x")).toBe("a x b ");
  });
  it("无占位符", () => {
    expect(formatInstallMessage("hello")).toBe("hello");
  });
});

describe("isOlderVersion: 版本比较", () => {
  it("1.0.0 < 1.0.1", () => {
    expect(isOlderVersion("1.0.0", "1.0.1")).toBe(true);
  });
  it("1.0.1 < 1.1.0", () => {
    expect(isOlderVersion("1.0.1", "1.1.0")).toBe(true);
  });
  it("1.9.0 < 2.0.0", () => {
    expect(isOlderVersion("1.9.0", "2.0.0")).toBe(true);
  });
  it("相等 → false", () => {
    expect(isOlderVersion("1.0.0", "1.0.0")).toBe(false);
  });
  it("大于 → false", () => {
    expect(isOlderVersion("2.0.0", "1.0.0")).toBe(false);
  });
  it("去 prerelease tag:1.0.0-beta < 1.0.1", () => {
    expect(isOlderVersion("1.0.0-beta", "1.0.1")).toBe(true);
  });
  it("缺段补 0:1.0 < 1.0.1", () => {
    expect(isOlderVersion("1.0", "1.0.1")).toBe(true);
  });
});

// ============================================================================
// I1: installer 插件提供顶层 install 命令,不自行 process.exit
// ============================================================================

// I1 走非交互路径(非 TTY):不触发 clack 交互,但会跑 npm/whichBin 子进程。
// 用 vi.mock 把 child_process 全部 stub 成成功 no-op,避免真装包/真联网。
// existsSync 让 whichBin 找到 bin(返回非 null),从而 stepInstallSkills 走成功分支。
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from("/fake/prefix/bin/rxcli-test")),
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

describe("I1: installer 提供 install 命令,不自行 process.exit", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const origIsTTY = process.stdin.isTTY;
  const localState = createLocalState({ dir: join(tmpdir(), "rxcli-install-test") });

  async function assembledInstaller(options: DefineInstallerOptions = {}) {
    const plugin = defineInstaller(options);
    return plugin.setup({ localState, appName: "test" });
  }

  beforeEach(() => {
    // 非交互路径:presenter 走 console.error 而非 clack
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit should not be called");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it("install 是顶层命令且跳过所有插件钩子", async () => {
    const plugin = await assembledInstaller({ binName: "rxcli-test", pkgName: "test-pkg" });
    const spec = plugin.provides!.commands!.install;
    expect(spec.name).toBe("install");
    expect(spec.skipPluginHooks).toBe(true);
  });

  it("成功完成 → 返回 rawText('')(stdout 无业务数据,exit 0 语义)", async () => {
    const plugin = await assembledInstaller({ binName: "rxcli-test", pkgName: "test-pkg" });
    const result = await plugin.provides!.commands!.install.run(createTestCtx(), {});
    expect(result).toEqual({ kind: "raw-text", text: "" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("向导失败 → 抛 BareError(exit code 1,由管道静默携带)", async () => {
    const childProcess = await import("node:child_process");
    const syncSpy = vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error("npm gone");
    });
    const asyncSpy = vi
      .mocked(childProcess.execFile)
      .mockImplementationOnce((_c, _a, _o, cb) => cb(new Error("install failed"), Buffer.from("")));
    try {
      const plugin = await assembledInstaller({ binName: "rxcli-test", pkgName: "test-pkg" });
      const result = plugin.provides!.commands!.install.run(createTestCtx(), {});
      await expect(result).rejects.toMatchObject({ exitCode: 1 });
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      syncSpy.mockRestore();
      asyncSpy.mockRestore();
    }
  });

  it("--lang 经命令参数透传(zh → 中文 setup 文案)", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const plugin = await assembledInstaller({ binName: "rxcli-test", pkgName: "test-pkg" });
    await plugin.provides!.commands!.install.run(createTestCtx(), { lang: "zh" });
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("正在设置");
  });

  it("auth: false 时跳过注册/授权提示(无 auth 的开放数据 CLI)", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const plugin = await assembledInstaller({
      binName: "rxcli-test",
      pkgName: "test-pkg",
      auth: false,
    });
    const result = await plugin.provides!.commands!.install.run(createTestCtx(), {});
    expect(result).toEqual({ kind: "raw-text", text: "" });
    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).not.toContain("auth register");
  });

  it("memory 本地状态不可用于 installer(明确报错,不静默降级)", async () => {
    const plugin = defineInstaller();
    await expect(
      plugin.setup({
        localState: createMemoryLocalState(),
        appName: "test",
      }),
    ).rejects.toThrow("file-backed");
  });
});
