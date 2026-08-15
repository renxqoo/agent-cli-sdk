import { describe, expect, it } from "vitest";
import { identityKey } from "../../context.js";
import { memoryStore } from "../../credentials/config-store.js";
import type { ConfigStore, CredentialProvider } from "../../credentials/types.js";
import { createTestCtx } from "../../test-utils.js";
import { defineAuth } from "../index.js";
import { createMemoryLocalState, type LocalState } from "../../local-state.js";

/** 装配 helper:defineAuth 现在是同步工厂,异步装配在 apply(services)。 */
async function assembledAuth(
  opts: Parameters<typeof defineAuth>[0],
  localState: LocalState = createMemoryLocalState(),
) {
  const plugin = defineAuth(opts);
  await plugin.apply?.({ localState, appName: "test" });
  return plugin;
}

describe("AuthSessionManager boundary", () => {
  it("gives an explicitly injected bearer token the documented highest priority", async () => {
    const lowerPriority: CredentialProvider = {
      name: () => "flag-like",
      priority: () => 1,
      async resolveToken() {
        return { token: "api-key", type: "api-key", source: "test" };
      },
    };
    const plugin = await assembledAuth({
      credentialNamespace: "crm",
      baseUrl: "https://auth.test",
      bearerToken: "injected",
      providers: [lowerPriority],
    });
    const ctx = createTestCtx();

    await plugin.beforeCommand!(ctx);
    const request = await plugin.beforeRequest!(ctx, { method: "GET", path: "/orders" });

    expect(request.headers?.authorization).toBe("Bearer injected");
  });

  it("surfaces a corrupt configuration store instead of silently becoming unregistered", async () => {
    const brokenStore: ConfigStore = {
      async loadConfig(_namespace: string) {
        throw new Error("corrupt config.json");
      },
      async saveConfig(_namespace: string, _data) {},
      async loadCredentials() {
        return null;
      },
      async saveCredentials() {},
      async clearCredentials() {},
      async withLock<T>(_namespace: string, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    };

    const plugin = defineAuth({
      credentialNamespace: "crm",
      baseUrl: "https://auth.test",
    });
    await expect(
      plugin.apply?.({ localState: { kind: "memory", store: brokenStore }, appName: "test" }),
    ).rejects.toThrow("corrupt config.json");
  });

  it("reports a persisted client_credentials session as bot identity", async () => {
    const plugin = await assembledAuth(
      {
        credentialNamespace: "crm",
        baseUrl: "https://auth.test",
      },
      createMemoryLocalState({
        credentials: {
          crm: {
            token: "machine-token",
            authMethod: "client_credentials",
            expiresAt: Date.now() + 60_000,
          },
        },
      }),
    );
    const ctx = createTestCtx();

    await plugin.beforeCommand!(ctx);

    expect((ctx as typeof ctx & { [identityKey]?: unknown })[identityKey]).toEqual({
      identity: "bot",
    });
  });
});
