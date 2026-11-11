import { afterEach, describe, expect, it, vi } from "vitest";
import { defineCliApp, defineAuth, defineCommand, createMemoryLocalState } from "../index.js";
import { memoryStore } from "../credentials/config-store.js";
import { OAuthClient } from "../oauth-client.js";
import { OAuthFlowCoordinator } from "../auth/flow-coordinator.js";

const oauth = { baseUrl: "https://oauth.test", clientId: "client", clientSecret: "secret" };
const initial = {
  sessionId: "session-a",
  token: "token-a",
  refreshToken: "refresh-a",
  authMethod: "device",
  scopes: ["read"],
  user: { userId: "a", name: "Alice" },
};
const expected = { sessionId: "session-a", token: "token-a" };

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("persisted OAuth session ownership", () => {
  it("preserves the session when the token endpoint returns a retryable HTTP failure", async () => {
    const store = memoryStore({ credentials: { app: initial } });
    const client = new OAuthClient(
      oauth,
      async () => new Response('{"error":"temporarily_unavailable"}', { status: 503 }),
    );
    const coordinator = new OAuthFlowCoordinator({
      store,
      namespace: "app",
      strategy: {
        requiresRefreshToken: true,
        acquire: (session) => client.refresh(session.refreshToken!),
      },
    });
    await expect(coordinator.refreshSession(expected)).rejects.toMatchObject({
      code: 503,
      retryable: true,
    });
    expect(await store.loadCredentials("app")).toEqual(initial);
  });

  it("rejects an old session after a different account is saved", async () => {
    const store = memoryStore({ credentials: { app: initial } });
    const acquire = vi.fn();
    const coordinator = new OAuthFlowCoordinator({
      store,
      namespace: "app",
      strategy: { acquire },
    });
    await store.saveCredentials("app", { ...initial, sessionId: "session-b", token: "token-b" });
    await expect(coordinator.refreshSession(expected)).resolves.toBeNull();
    expect(acquire).not.toHaveBeenCalled();
    expect((await store.loadCredentials("app"))?.token).toBe("token-b");
  });

  it("serializes a credential clear after an in-flight refresh", async () => {
    const store = memoryStore({ credentials: { app: initial } });
    let finish!: (token: { access_token: string }) => void;
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const coordinator = new OAuthFlowCoordinator({
      store,
      namespace: "app",
      strategy: {
        acquire: () => {
          entered();
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    const refreshing = coordinator.refreshSession(expected);
    await acquired;
    const clearing = store.clearCredentials("app");
    finish({ access_token: "new-token-a" });
    await Promise.all([refreshing, clearing]);
    expect(await store.loadCredentials("app")).toBeNull();
  });

  it("reuses a refresh committed by another coordinator for the same rejected token", async () => {
    const store = memoryStore({ credentials: { app: initial } });
    const acquire = vi.fn(async () => ({ access_token: "new-a", refresh_token: "new-refresh-a" }));
    const a = new OAuthFlowCoordinator({ store, namespace: "app", strategy: { acquire } });
    const b = new OAuthFlowCoordinator({ store, namespace: "app", strategy: { acquire } });
    const results = await Promise.all([a.refreshSession(expected), b.refreshSession(expected)]);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(results.map((token) => token?.access_token)).toEqual(["new-a", "new-a"]);
    expect((await store.loadCredentials("app"))?.sessionId).toBe("session-a");
  });
});

describe("application-scoped auth runtimes", () => {
  it("refreshes the token actually sent when a caller supplies a differently cased header", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const localState = createMemoryLocalState({ credentials: { app: initial } });
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/token")) {
        calls.push("refresh");
        return new Response(JSON.stringify({ access_token: "fresh-a" }));
      }
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push(authorization ?? "");
      return new Response("{}", { status: authorization === "Bearer fresh-a" ? 200 : 401 });
    });
    const app = await defineCliApp({
      name: "demo",
      description: "demo",
      baseUrl: "https://api.test",
      localState,
      plugins: [defineAuth({ credentialNamespace: "app", ...oauth })],
      commands: {
        read: defineCommand({
          name: "read",
          description: "read",
          async run(ctx) {
            return {
              data: (
                await ctx.request({
                  method: "GET",
                  path: "/records",
                  headers: { Authorization: "Bearer caller-value" },
                })
              ).data,
            };
          },
        }),
      },
    });
    await app.run(["read"]);
    expect(process.exitCode).toBe(0);
    expect(calls).toEqual(["Bearer token-a", "refresh", "Bearer fresh-a"]);
  });

  it("binds a reused definition to each application's credential store", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      calls.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}");
    });
    const auth = defineAuth({ credentialNamespace: "app", ...oauth });
    const commands = {
      read: defineCommand({
        name: "read",
        description: "read",
        async run(ctx) {
          return { data: (await ctx.get("/records")).data };
        },
      }),
    };
    const a = await defineCliApp({
      name: "a",
      description: "a",
      baseUrl: "https://a.test",
      localState: createMemoryLocalState({ credentials: { app: { token: "a" } } }),
      commands,
      plugins: [auth],
    });
    const b = await defineCliApp({
      name: "b",
      description: "b",
      baseUrl: "https://b.test",
      localState: createMemoryLocalState({ credentials: { app: { token: "b" } } }),
      commands,
      plugins: [auth],
    });
    await a.run(["read"]);
    await b.run(["read"]);
    expect(calls).toEqual(["Bearer a", "Bearer b"]);
  });

  it("does not retry a rejected request using a newly logged-in account", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const localState = createMemoryLocalState({ credentials: { app: initial } });
    let rejectRequest!: (response: Response) => void;
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      entered();
      return new Promise((resolve) => {
        rejectRequest = resolve;
      });
    });
    const app = await defineCliApp({
      name: "demo",
      description: "demo",
      baseUrl: "https://api.test",
      localState,
      plugins: [defineAuth({ credentialNamespace: "app", ...oauth })],
      commands: {
        read: defineCommand({
          name: "read",
          description: "read",
          async run(ctx) {
            return { data: (await ctx.get("/records")).data };
          },
        }),
      },
    });
    const running = app.run(["read"]);
    await called;
    await localState.store.saveCredentials("app", {
      ...initial,
      sessionId: "session-b",
      token: "token-b",
    });
    rejectRequest(new Response("{}", { status: 401 }));
    await running;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(3);
    expect((await localState.store.loadCredentials("app"))?.token).toBe("token-b");
  });

  it("uses the standard five-second interval when a device response omits it", async () => {
    const client = new OAuthClient(
      oauth,
      async () =>
        new Response(
          JSON.stringify({
            device_code: "device",
            user_code: "code",
            verification_uri: "https://oauth.test/verify",
            expires_in: 600,
          }),
        ),
    );
    expect((await client.authorizeDevice()).interval).toBe(5);
  });
});
