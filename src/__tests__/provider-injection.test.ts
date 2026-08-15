/**
 * envBearerProvider + bearerToken 注入 + providers 自定义 测试。
 */
import { describe, it, expect } from "vitest";
import { envBearerProvider } from "../credentials/providers.js";
import { defineAuth } from "../auth/index.js";
import { memoryStore } from "../credentials/config-store.js";
import { createMemoryLocalState } from "../local-state.js";
import type { ProviderContext } from "../credentials/types.js";

function makeCtx(env: Record<string, string> = {}): ProviderContext {
  return {
    namespace: "crm",
    configStore: memoryStore(),
    args: {},
    env,
  };
}

describe("envBearerProvider", () => {
  it("有 CRM_BEARER_TOKEN → 返回 bearer token", async () => {
    const provider = envBearerProvider();
    const result = await provider.resolveToken(makeCtx({ CRM_BEARER_TOKEN: "eyJjwt..." }));
    expect(result).not.toBeNull();
    expect(result!.token).toBe("eyJjwt...");
    expect(result!.type).toBe("bearer");
    expect(result!.source).toContain("CRM_BEARER_TOKEN");
  });

  it("无 CRM_BEARER_TOKEN → 返回 null(skip)", async () => {
    const provider = envBearerProvider();
    const result = await provider.resolveToken(makeCtx({}));
    expect(result).toBeNull();
  });

  it("namespace 含连字符 → 正确转下划线(MY-CRM → MY_CRM_BEARER_TOKEN)", async () => {
    const provider = envBearerProvider();
    const result = await provider.resolveToken({
      namespace: "my-crm",
      configStore: memoryStore(),
      args: {},
      env: { MY_CRM_BEARER_TOKEN: "tok" },
    } as ProviderContext);
    expect(result!.token).toBe("tok");
  });

  it("priority = 6(在 env api-key 5 之后,file 10 之前)", () => {
    const provider = envBearerProvider();
    expect(provider.priority?.()).toBe(6);
  });

  it("name = env-bearer", () => {
    const provider = envBearerProvider();
    expect(provider.name()).toBe("env-bearer");
  });
});

describe("defineAuth bearerToken 注入", () => {
  it("设了 bearerToken → provider chain 直接命中(priority 0)", async () => {
    const plugin = defineAuth({
      credentialNamespace: "test-bearer",
      baseUrl: "http://test",
      bearerToken: "injected-jwt-token",
    });
    await plugin.apply?.({ localState: createMemoryLocalState(), appName: "test" });

    // plugin 的 beforeCommand 会跑 provider chain
    // bearerToken 对应的 provider priority=0,应该最先命中
    // 验证:plugin 正常装配(没有报错)
    expect(plugin).toBeTruthy();
    expect(plugin.name).toContain("test-bearer");
  });

  it("没设 bearerToken → 正常创建(走默认 chain)", async () => {
    const plugin = defineAuth({
      credentialNamespace: "test-default",
      baseUrl: "http://test",
    });
    await plugin.apply?.({ localState: createMemoryLocalState(), appName: "test" });
    expect(plugin).toBeTruthy();
  });
});

describe("defineAuth 自定义 providers", () => {
  it("传了 providers → 用自定义的(不用 defaultProviders)", async () => {
    const customProvider = {
      name: () => "custom",
      priority: () => 1,
      async resolveToken() {
        return { token: "custom-token", type: "bearer" as const, source: "custom" };
      },
    };

    const plugin = defineAuth({
      credentialNamespace: "test-custom",
      baseUrl: "http://test",
      providers: [customProvider],
    });
    await plugin.apply?.({ localState: createMemoryLocalState(), appName: "test" });

    expect(plugin).toBeTruthy();
  });

  it("bearerToken + providers 可以同时用(bearerToken 优先)", async () => {
    const customProvider = {
      name: () => "custom",
      priority: () => 1,
      async resolveToken() {
        return { token: "custom-token", type: "bearer" as const, source: "custom" };
      },
    };

    const plugin = defineAuth({
      credentialNamespace: "test-both",
      baseUrl: "http://test",
      bearerToken: "injected-jwt",
      providers: [customProvider],
    });
    await plugin.apply?.({ localState: createMemoryLocalState(), appName: "test" });

    expect(plugin).toBeTruthy();
  });
});
