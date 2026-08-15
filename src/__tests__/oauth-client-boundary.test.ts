import { describe, expect, it, vi } from "vitest";
import { OAuthClient } from "../oauth-client.js";
import { OAuthFlowCoordinator } from "../auth/flow-coordinator.js";
import { memoryStore } from "../credentials/config-store.js";

const config = { baseUrl: "https://oauth.test", clientId: "client", clientSecret: "secret" };

describe("OAuthClient boundary", () => {
  it("encodes a grant and validates the token contract through an injected transport", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "access", expires_in: 60, scope: "read write" }),
          {
            status: 200,
          },
        ),
    );
    const client = new OAuthClient(config, fetcher);

    await expect(client.clientCredentials("read write")).resolves.toMatchObject({
      access_token: "access",
      expires_in: 60,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth.test/token",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=client_credentials&scope=read+write",
      }),
    );
  });
});

describe("OAuthFlowCoordinator boundary", () => {
  it("singleflights acquisition and persistence as one transaction", async () => {
    const store = memoryStore();
    await store.saveCredentials("app", {
      token: "old",
      refreshToken: "refresh",
      expiresAt: 0,
      scopes: ["old-scope"],
      storedAt: 0,
      authMethod: "device",
    });
    const acquire = vi.fn(async () => ({ access_token: "new", expires_in: 60 }));
    const coordinator = new OAuthFlowCoordinator({
      store,
      namespace: "app",
      strategy: { requiresRefreshToken: true, acquire },
    });

    const [a, b] = await Promise.all([
      coordinator.refreshStoredSession(),
      coordinator.refreshStoredSession(),
    ]);
    expect(a).toMatchObject({ access_token: "new" });
    expect(b).toMatchObject({ access_token: "new" });
    expect(acquire).toHaveBeenCalledTimes(1);
    await expect(store.loadCredentials("app")).resolves.toMatchObject({
      token: "new",
      refreshToken: "refresh",
      scopes: ["old-scope"],
      authMethod: "device",
    });
  });
});
