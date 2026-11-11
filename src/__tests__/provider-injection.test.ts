/**
 * envBearerProvider 测试。
 */
import { describe, it, expect } from "vitest";
import { envBearerProvider } from "../credentials/providers.js";
import { memoryStore } from "../credentials/config-store.js";
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
