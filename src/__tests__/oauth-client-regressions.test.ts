import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthClient } from "../oauth-client.js";
import { createLogoutCommand } from "../auth/commands/logout.js";
import { memoryStore } from "../credentials/config-store.js";
import { createTestCtx } from "../test-utils.js";
import { createMemoryLocalState, defineAuth, defineCliApp, defineCommand } from "../index.js";

const oauth = { baseUrl: "https://oauth.test", clientId: "client", clientSecret: "secret" };
const decodeFormComponent = (part: string) => new URLSearchParams(`x=${part}`).get("x");
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("OAuth client authentication across endpoints", () => {
  it.each([
    ["team:cli", "a+b% c", "team%3Acli:a%2Bb%25+c"],
    ["团队", "密钥:/+", "%E5%9B%A2%E9%98%9F:%E5%AF%86%E9%92%A5%3A%2F%2B"],
    ["client", "secret", "client:secret"],
  ])(
    "form-encodes %j and its secret independently for every endpoint",
    async (clientId, clientSecret, expected) => {
      const requests: string[] = [];
      const client = new OAuthClient({ ...oauth, clientId, clientSecret }, async (_url, init) => {
        const header = new Headers(init?.headers).get("authorization") ?? "";
        const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
        requests.push(decoded);
        expect(header.startsWith("Basic ")).toBe(true);
        expect(decoded).toBe(expected);
        const [id, secret] = decoded.split(":");
        expect([decodeFormComponent(id!), decodeFormComponent(secret!)]).toEqual([
          clientId,
          clientSecret,
        ]);
        expect(new URLSearchParams(String(init?.body)).has("client_secret")).toBe(false);
        return Response.json({
          access_token: "access",
          device_code: "dc",
          user_code: "uc",
          verification_uri: "https://oauth.test/verify",
          expires_in: 60,
        });
      });
      await client.exchangeCode({
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://localhost/callback",
      });
      await client.refresh("refresh");
      await client.clientCredentials();
      await client.authorizeDevice();
      await client.pollDevice("dc");
      await client.revoke("access");
      expect(requests).toEqual(Array(6).fill(expected));
    },
  );

  it("keeps public code exchange, refresh, device and revocation free of empty-password Basic", async () => {
    const grants: Array<string | null> = [];
    const client = new OAuthClient({ ...oauth, clientSecret: "" }, async (_url, init) => {
      const form = new URLSearchParams(String(init?.body));
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(form.get("client_id")).toBe("client");
      grants.push(form.get("grant_type"));
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        device_code: "dc",
        user_code: "uc",
        verification_uri: "https://oauth.test/verify",
        expires_in: 60,
      });
    });
    const token = await client.exchangeCode({
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://localhost/callback",
    });
    await client.refresh(token.refresh_token!);
    await client.authorizeDevice();
    await client.pollDevice("dc");
    await client.revoke("access");
    expect(grants).toEqual([
      "authorization_code",
      "refresh_token",
      null,
      "urn:ietf:params:oauth:grant-type:device_code",
      null,
    ]);
  });

  it("refreshes a public client's rejected business request and persists the rotated session", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const localState = createMemoryLocalState({
      credentials: {
        app: {
          sessionId: "session",
          token: "old",
          refreshToken: "refresh",
          authMethod: "authorization_code",
        },
      },
    });
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (String(url).endsWith("/token")) {
        expect(auth).toBeNull();
        expect(new URLSearchParams(String(init?.body)).get("client_id")).toBe("client");
        calls.push("refresh");
        return Response.json({ access_token: "fresh", refresh_token: "rotated" });
      }
      calls.push(auth ?? "");
      return Response.json({ value: "record" }, { status: auth === "Bearer fresh" ? 200 : 401 });
    });
    const app = await defineCliApp({
      name: "demo",
      description: "demo",
      baseUrl: "https://api.test",
      localState,
      plugins: [
        defineAuth({
          credentialNamespace: "app",
          ...oauth,
          clientSecret: "",
          flow: "authorization_code",
        }),
      ],
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
    await app.run(["read"]);
    expect(process.exitCode).toBe(0);
    expect(calls).toEqual(["Bearer old", "refresh", "Bearer fresh"]);
    expect(await localState.store.loadCredentials("app")).toMatchObject({
      token: "fresh",
      refreshToken: "rotated",
    });
  });

  it.each(["crm", "orders"])(
    "revokes both tokens for %s while isolating other namespaces",
    async (namespace) => {
      const store = memoryStore({
        credentials: {
          [namespace]: { token: "access", refreshToken: "refresh" },
          untouched: { token: "keep" },
        },
      });
      const revoked: Array<[string | null, string | null]> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth !== "Basic Y2xpZW50OnNlY3JldA==")
          return Response.json({ error: "invalid_client" }, { status: 401 });
        const form = new URLSearchParams(String(init?.body));
        revoked.push([form.get("token"), form.get("token_type_hint")]);
        return new Response(null, { status: 200 });
      });
      const result = await createLogoutCommand({
        oauth,
        store,
        credentialNamespace: namespace,
      }).run(createTestCtx(), {});
      expect(result?.data).toEqual({ loggedOut: true });
      expect(revoked).toEqual([
        ["access", "access_token"],
        ["refresh", "refresh_token"],
      ]);
      expect(await store.loadCredentials(namespace)).toBeNull();
      expect(await store.loadCredentials("untouched")).toEqual({ token: "keep" });
    },
  );

  it("clears the local session even when neither remote revocation is confirmed", async () => {
    const store = memoryStore({
      credentials: { app: { token: "access", refreshToken: "refresh" } },
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const result = await createLogoutCommand({ oauth, store, credentialNamespace: "app" }).run(
      createTestCtx(),
      {},
    );
    expect(result?.data).toEqual({ loggedOut: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await store.loadCredentials("app")).toBeNull();
  });
});
