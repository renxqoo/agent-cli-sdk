import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineAuth,
  defineCli,
  defineCommand,
  memoryStore,
  createMemoryLocalState,
  type CredentialProvider,
} from "../index.js";

let stdout = "";
let stderr = "";
let stdinIsTTY: boolean | undefined;

beforeEach(() => {
  stdout = "";
  stderr = "";
  stdinIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  if (stdinIsTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdin, "isTTY", { value: stdinIsTTY, configurable: true });
});

describe("auth runtime isolation", () => {
  it("defineAuth 的并发 401 只刷新一次", async () => {
    const localState = createMemoryLocalState({
      credentials: {
        demo: {
          token: "old-token",
          refreshToken: "old-refresh",
          expiresAt: Date.now() + 60_000,
          scopes: [],
          storedAt: Date.now(),
          authMethod: "device",
        },
      },
    });
    let refreshCalls = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        refreshCalls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(
          JSON.stringify({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const authorization = new Headers(init?.headers).get("authorization");
      return new Response("{}", {
        status: authorization === "Bearer new-token" ? 200 : 401,
        headers: { "content-type": "application/json" },
      });
    });

    const auth = defineAuth({
      credentialNamespace: "demo",
      baseUrl: "https://auth.example",
      clientId: "id",
      clientSecret: "secret",
    });
    await auth.apply?.({ localState, appName: "demo" });
    const app = defineCli({
      name: "demo",
      description: "demo",
      defaultFormat: "json",
      plugins: [auth],
      commands: {
        get: defineCommand({
          name: "get",
          description: "get",
          async run(ctx) {
            await ctx.get("https://api.example/data");
            return { data: { ok: true } };
          },
        }),
      },
    });

    await Promise.all([app.run(["get"]), app.run(["get"]), app.run(["get"])]);
    expect(refreshCalls).toBe(1);
  });

  it("并发 App.run 使用各自上下文中的凭证", async () => {
    const provider: CredentialProvider = {
      name: () => "flag-only",
      priority: () => 1,
      async resolveToken(ctx) {
        return typeof ctx.args.apiKey === "string"
          ? { token: ctx.args.apiKey, type: "api-key", source: "flag" }
          : null;
      },
    };
    const auth = defineAuth({
      credentialNamespace: "demo",
      baseUrl: "https://auth.example",
      clientId: "id",
      clientSecret: "secret",
      providers: [provider],
    });
    await auth.apply?.({ localState: createMemoryLocalState(), appName: "demo" });

    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const headers: string[] = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });

    const app = defineCli({
      name: "demo",
      description: "demo",
      defaultFormat: "json",
      plugins: [auth],
      commands: {
        get: defineCommand({
          name: "get",
          description: "get",
          async run(ctx) {
            arrived++;
            if (arrived === 2) release();
            await gate;
            await ctx.get("https://api.example/data");
            return { data: { ok: true } };
          },
        }),
      },
    });

    await Promise.all([app.run(["get", "--api-key", "one"]), app.run(["get", "--api-key", "two"])]);
    expect(headers.sort()).toEqual(["Bearer one", "Bearer two"]);
  });
});

describe("skills sync command failure contract", () => {
  it("所有目标写入失败时返回非零退出码和错误 envelope", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "rxcli-skills-sync-failure-"));
    const blockingFile = join(fixtureDir, "not-a-directory");
    writeFileSync(blockingFile, "block child directory creation");

    try {
      const app = defineCli({
        name: "demo",
        description: "demo",
        commands: {},
        skillsDir: new URL("../../skills", import.meta.url).pathname,
        skillsTargets: [{ key: "broken", dir: join(blockingFile, "skills") }],
        defaultFormat: "json",
      });

      await app.run(["skills", "sync"]);
      expect(process.exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr).ok).toBe(false);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
