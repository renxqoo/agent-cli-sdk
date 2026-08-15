/**
 * defineAuth 工厂测试 —— 验证工厂产出的 plugin 形态、scope 透传、
 * S3 凭据回读(config/<ns>.json → clientId)。
 *
 * device flow 的轮询/split-flow 逻辑测试在 device-splitflow.test.ts。
 * defineAuth 是同步工厂:异步装配在 apply(services),本文件用 assembledAuth 完成。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { defineAuth } from "../auth/index.js";
import { createTestCtx } from "../test-utils.js";
import { createMemoryLocalState, type LocalState } from "../local-state.js";
import * as oauthApi from "../oauth.js";

async function assembledAuth(
  opts: Parameters<typeof defineAuth>[0],
  localState: LocalState = createMemoryLocalState(),
) {
  const plugin = defineAuth(opts);
  await plugin.apply?.({ localState, appName: "test" });
  return plugin;
}

// ============================================================================
// 工厂形态:返回的 plugin 带 provides + 钩子
// ============================================================================

describe("defineAuth: 工厂形态", () => {
  it("返回的 plugin 有 provides.namespaces[cmdNs],含 login/status/logout/register", async () => {
    const plugin = await assembledAuth({
      credentialNamespace: "crm",
      baseUrl: "http://test",
    });
    expect(plugin.name).toBe("auth:crm");
    expect(plugin.enforce).toBe("pre");
    expect(plugin.provides?.namespaces?.auth).toBeDefined();
    const cmds = plugin.provides!.namespaces!.auth!;
    expect(Object.keys(cmds).sort()).toEqual(["login", "logout", "register", "status"]);
  });

  it("commandNamespace 可自定义(默认 auth)", async () => {
    const plugin = await assembledAuth({
      credentialNamespace: "crm",
      baseUrl: "http://test",
      commandNamespace: "iam",
    });
    expect(plugin.provides?.namespaces?.iam).toBeDefined();
    expect(plugin.provides?.namespaces?.auth).toBeUndefined();
  });

  it("plugin 通过显式 handleUnauthorized hook 提供 401 恢复", async () => {
    const plugin = await assembledAuth({
      credentialNamespace: "crm",
      baseUrl: "http://test",
    });
    expect(plugin.handleUnauthorized).toBeTypeOf("function");
  });

  it("未装配前 provides 为空,钩子抛契约错误(不静默降级)", async () => {
    const plugin = defineAuth({ credentialNamespace: "crm", baseUrl: "http://test" });
    expect(plugin.provides).toBeUndefined();
    await expect(plugin.beforeCommand!(createTestCtx())).rejects.toThrow("apply(services)");
  });
});

// ============================================================================
// S3: register 凭据回读(config/<ns>.json → oauth.clientId)—— 从 crm 迁入
// ============================================================================

describe("S3: register 凭据回读(config/<ns>.json → oauth.clientId)", () => {
  it("store 的 config 里有 clientId/clientSecret → 工厂读回", async () => {
    const localState = createMemoryLocalState({
      config: { crm: { clientId: "cli_registered", clientSecret: "sec_registered" } },
    });
    const plugin = await assembledAuth(
      {
        credentialNamespace: "crm",
        baseUrl: "http://test",
      },
      localState,
    );
    // 工厂成功完成配置解析，并公开标准的未授权恢复 hook。
    expect(plugin.handleUnauthorized).toBeDefined();
  });

  it("显式传 clientId/clientSecret 优先(不被 config 覆盖)", async () => {
    const localState = createMemoryLocalState({
      config: { crm: { clientId: "from_config", clientSecret: "from_config" } },
    });
    const plugin = await assembledAuth(
      {
        credentialNamespace: "crm",
        baseUrl: "http://test",
        clientId: "from_opt",
        clientSecret: "from_opt",
      },
      localState,
    );
    // 通过 login 命令触发 deviceAuthorization,spy 校验 clientId 来源
    const spy = vi.spyOn(oauthApi, "deviceAuthorization").mockResolvedValue({
      device_code: "dc",
      user_code: "uc",
      verification_uri: "u",
      expires_in: 1,
      interval: 1,
    });
    const ctx = createTestCtx();
    const cmds = plugin.provides!.namespaces!.auth!;
    await cmds.login.run(ctx, { wait: false });
    const calledCfg = spy.mock.calls[0]![0];
    expect(calledCfg.clientId).toBe("from_opt");
    spy.mockRestore();
  });

  it("config 无凭据 + opts 空 → clientId 为空(未注册态)", async () => {
    const localState = createMemoryLocalState({ config: {} });
    const plugin = await assembledAuth(
      {
        credentialNamespace: "crm",
        baseUrl: "http://test",
      },
      localState,
    );
    const spy = vi.spyOn(oauthApi, "deviceAuthorization").mockResolvedValue({
      device_code: "dc",
      user_code: "uc",
      verification_uri: "u",
      expires_in: 1,
      interval: 1,
    });
    const ctx = createTestCtx();
    const cmds = plugin.provides!.namespaces!.auth!;
    await cmds.login.run(ctx, { wait: false });
    const calledCfg = spy.mock.calls[0]![0];
    expect(calledCfg.clientId).toBe("");
    spy.mockRestore();
  });
});

// ============================================================================
// scope 透传:业务自定,空=不带
// ============================================================================

describe("scope 透传(业务自定,空=不带)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defineAuth({scope}) → login 时 deviceAuthorization 收到该 scope", async () => {
    const plugin = await assembledAuth({
      credentialNamespace: "crm",
      baseUrl: "http://test",
      scope: "company.api offline_access",
    });
    const captured: string[] = [];
    const spy = vi
      .spyOn(oauthApi, "deviceAuthorization")
      .mockImplementation(async (_cfg, scope) => {
        captured.push(scope ?? "");
        return {
          device_code: "dc",
          user_code: "uc",
          verification_uri: "u",
          expires_in: 1,
          interval: 1,
        };
      });
    const ctx = createTestCtx();
    const cmds = plugin.provides!.namespaces!.auth!;
    await cmds.login.run(ctx, { wait: false });
    expect(captured[0]).toBe("company.api offline_access");
    spy.mockRestore();
  });

  it("defineAuth 不传 scope → deviceAuthorization 收到 undefined(不带 scope)", async () => {
    const plugin = await assembledAuth({
      credentialNamespace: "crm",
      baseUrl: "http://test",
      // 不传 scope
    });
    const captured: (string | undefined)[] = [];
    const spy = vi
      .spyOn(oauthApi, "deviceAuthorization")
      .mockImplementation(async (_cfg, scope) => {
        captured.push(scope);
        return {
          device_code: "dc",
          user_code: "uc",
          verification_uri: "u",
          expires_in: 1,
          interval: 1,
        };
      });
    const ctx = createTestCtx();
    const cmds = plugin.provides!.namespaces!.auth!;
    await cmds.login.run(ctx, { wait: false });
    expect(captured[0]).toBeUndefined();
    spy.mockRestore();
  });
});

// ============================================================================
// M3: device 轮询逻辑已移到 flows/device.ts,测试见 device-splitflow.test.ts
// ============================================================================
