/**
 * Wave 3 regression tests — auth lifecycle:
 *   C5 — callback close() settles the still-pending result promise
 *   L9 — a token response without expires_in is tolerated
 *   L2 — client_credentials refresh re-requests the persisted granted scopes
 *   L5 — coordinator distinguishes retryable network errors from permanent auth failure
 *   B6 — logout revokes the refresh token as well as the access token
 *   L3 — status reports an expired user session instead of throwing
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { waitForCallback } from "../infra/callback-server.js";
import { OAuthClient } from "../oauth-client.js";
import { OAuthFlowCoordinator } from "../auth/flow-coordinator.js";
import { buildOn401Handler } from "../auth/helpers.js";
import { defineAuth } from "../auth/index.js";
import { createTestCtx } from "../test-utils.js";
import { memoryStore } from "../credentials/config-store.js";
import { createMemoryLocalState } from "../local-state.js";
import { AuthenticationError, NetworkError } from "../errs/index.js";

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// C5: close() rejects a pending result
// ---------------------------------------------------------------------------

describe("C5: callback close() settles the result promise", () => {
  it("rejects a still-pending result so callers cannot hang forever", async () => {
    const handle = await waitForCallback({ timeoutMs: 10_000, expectedState: "s" });
    const expectation = expect(handle.result).rejects.toThrow(/closed/i);
    handle.close();
    await expectation;
  });
});

// ---------------------------------------------------------------------------
// L9: missing expires_in
// ---------------------------------------------------------------------------

describe("L9: token without expires_in", () => {
  it("OAuthClient tolerates a response that omits expires_in", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "a" }), { status: 200 }),
    );
    const client = new OAuthClient(
      { baseUrl: "http://t", clientId: "c", clientSecret: "s" },
      fetcher,
    );
    const token = await client.clientCredentials();
    expect(token.access_token).toBe("a");
    expect(token.expires_in).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L2: client_credentials refresh scope consistency
// ---------------------------------------------------------------------------

describe("L2: client_credentials refresh re-requests persisted scopes", () => {
  it("uses the stored granted scopes (joined), not the static opts.scope", async () => {
    const store = memoryStore();
    await store.saveCredentials("app", {
      token: "old",
      refreshToken: "",
      expiresAt: 0,
      scopes: ["a", "b"],
      storedAt: 0,
      authMethod: "client_credentials",
    });
    let receivedScope: string | undefined;
    const cfg = { baseUrl: "http://t", clientId: "c", clientSecret: "s" };
    const flow = {
      type: "client_credentials" as const,
      login: vi.fn(),
      refresh: vi.fn(async (deps) => {
        receivedScope = deps.scope;
        return { access_token: "new", expires_in: 60 };
      }),
    };
    const handler = buildOn401Handler({
      flow,
      oauth: cfg,
      store,
      namespace: "app",
      scope: "static",
    });

    const token = await handler();
    expect(token?.access_token).toBe("new");
    expect(receivedScope).toBe("a b"); // persisted scopes, NOT "static"
  });
});

// ---------------------------------------------------------------------------
// L5: refresh error taxonomy
// ---------------------------------------------------------------------------

describe("L5: coordinator refresh error taxonomy", () => {
  it("rethrows retryable network errors", async () => {
    const store = memoryStore();
    await store.saveCredentials("app", {
      token: "old",
      refreshToken: "rt",
      expiresAt: 0,
      scopes: [],
      storedAt: 0,
      authMethod: "device",
    });
    const acquire = vi.fn(async () => {
      throw new NetworkError({ subtype: "connection_refused", message: "net", retryable: true });
    });
    const coordinator = new OAuthFlowCoordinator({
      store,
      namespace: "app",
      strategy: { requiresRefreshToken: true, acquire },
    });
    await expect(coordinator.refreshStoredSession()).rejects.toBeInstanceOf(NetworkError);
  });

  it("returns null and clears the stale session on a permanent auth failure", async () => {
    const store = memoryStore();
    await store.saveCredentials("app", {
      token: "old",
      refreshToken: "rt",
      expiresAt: 0,
      scopes: [],
      storedAt: 0,
      authMethod: "device",
    });
    const acquire = vi.fn(async () => {
      throw new AuthenticationError({ subtype: "token_revoked", message: "revoked" });
    });
    const coordinator = new OAuthFlowCoordinator({
      store,
      namespace: "app",
      strategy: { requiresRefreshToken: true, acquire },
    });
    await expect(coordinator.refreshStoredSession()).resolves.toBeNull();
    expect(store._snapshot().credentials.app).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B6: logout revokes the refresh token too
// ---------------------------------------------------------------------------

describe("B6: logout revokes access + refresh tokens", () => {
  it("sends two revoke requests (access_token + refresh_token hints)", async () => {
    const store = memoryStore({
      credentials: {
        crm: {
          token: "at",
          refreshToken: "rt",
          authMethod: "device",
          storedAt: 1,
          scopes: [],
        },
      },
    });
    const plugin = defineAuth({
      credentialNamespace: "crm",
      baseUrl: "http://t",
      clientId: "c",
      clientSecret: "s",
    });
    await plugin.apply?.({ localState: { kind: "memory", store }, appName: "test" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const ctx = createTestCtx();
    const cmds = plugin.provides!.namespaces!.auth!;
    await cmds.logout.run(ctx);

    const revokeBodies = fetchSpy.mock.calls
      .filter((call) => String(call[0]).endsWith("/revoke"))
      .map((call) => (call[1]?.body as string) ?? "");
    const tokens = revokeBodies.map((b) => new URLSearchParams(b).get("token"));
    expect(tokens).toEqual(expect.arrayContaining(["at", "rt"]));
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// L3: status symmetry for an expired user session
// ---------------------------------------------------------------------------

describe("L3: status reports expired user session without throwing", () => {
  it("returns { loggedIn: true, expired: true } and does not call getUserInfo", async () => {
    const store = memoryStore({
      credentials: {
        crm: {
          token: "expired-token",
          expiresAt: 1, // already expired
          authMethod: "device",
          user: { userId: "u", name: "n" },
          storedAt: 1,
          scopes: [],
        },
      },
    });
    const plugin = defineAuth({
      credentialNamespace: "crm",
      baseUrl: "http://t",
      clientId: "c",
      clientSecret: "s",
    });
    await plugin.apply?.({ localState: { kind: "memory", store }, appName: "test" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const ctx = createTestCtx();
    const cmds = plugin.provides!.namespaces!.auth!;
    const result = (await cmds.status.run(ctx)) as {
      data: { loggedIn: boolean; expired: boolean };
    };
    expect(result.data).toEqual({ loggedIn: true, expired: true });
    // did not attempt to call user_info with the expired token
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
