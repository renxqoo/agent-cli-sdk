import { describe, it, expect, vi } from "vitest";
import { injectAuthHeader, createOn401Hook } from "../oauth.js";
import { memoryStore } from "../credentials/config-store.js";
import type { RequestOptions } from "../types.js";

describe("injectAuthHeader: header 注入工具(开发者写 Plugin 用)", () => {
  it("bearer → Authorization: Bearer xxx", () => {
    const req: RequestOptions = { method: "GET", path: "/x", headers: {} };
    injectAuthHeader(req, "tok_bearer", "bearer");
    expect(req.headers!.authorization).toBe("Bearer tok_bearer");
  });

  it("x-api-key → X-Api-Key: xxx", () => {
    const req: RequestOptions = { method: "GET", path: "/x", headers: {} };
    injectAuthHeader(req, "sk_x", "x-api-key");
    expect(req.headers!["x-api-key"]).toBe("sk_x");
  });

  it("basic → Authorization: Basic xxx", () => {
    const req: RequestOptions = { method: "GET", path: "/x", headers: {} };
    injectAuthHeader(req, "base64tok", "basic");
    expect(req.headers!.authorization).toBe("Basic base64tok");
  });

  it("保留已有 header(不覆盖其它字段)", () => {
    const req: RequestOptions = { method: "GET", path: "/x", headers: { "x-trace": "abc" } };
    injectAuthHeader(req, "tok", "bearer");
    expect(req.headers!["x-trace"]).toBe("abc");
    expect(req.headers!.authorization).toBe("Bearer tok");
  });
});

/** The public 401-refresh façade wraps the coordinator + default OAuth refresh. */
function on401(cfg: { baseUrl: string; clientId: string; clientSecret: string }) {
  return (store: ReturnType<typeof memoryStore>, namespace: string) =>
    createOn401Hook({ cfg, store, namespace });
}

describe("401 singleflight: 并发复用同一次 refresh + 落盘", () => {
  it("并发 401 复用同一个 refresh Promise", async () => {
    let refreshCalls = 0;
    const refreshSpy = vi.fn(async () => {
      refreshCalls++;
      return {
        access_token: "new_tok",
        refresh_token: "new_rt",
        expires_in: 3600,
        scope: "orders:read",
      };
    });

    const store = memoryStore({
      credentials: {
        orders: {
          token: "old_tok",
          refreshToken: "old_rt",
          expiresAt: 1,
          scopes: ["orders:read"],
          user: { userId: "u1" },
          storedAt: 1,
          authMethod: "device",
        },
      },
    });

    const cfg = { baseUrl: "http://mock", clientId: "c", clientSecret: "s" };
    const refresh = on401(cfg)(store, "orders");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: URL | RequestInfo, init?: RequestInit) => {
        const u = String(url);
        const body = init?.body as string;
        if (u.endsWith("/token") && body?.includes("refresh_token")) {
          return new Response(JSON.stringify(await refreshSpy()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      });

    const [r1, r2, r3] = await Promise.all([refresh(), refresh(), refresh()]);
    expect(r1).toBe("new_tok");
    expect(r2).toBe("new_tok");
    expect(r3).toBe("new_tok");
    // singleflight:3 并发只 refresh 1 次
    expect(refreshCalls).toBe(1);
    // 落盘修正:新 token 写回 store
    const snap = store._snapshot();
    expect(snap.credentials.orders.token).toBe("new_tok");
    expect(snap.credentials.orders.refreshToken).toBe("new_rt");

    fetchSpy.mockRestore();
  });

  it("refresh 失败(refreshToken 失效)→ 返回 null 且清空过期会话", async () => {
    const store = memoryStore({
      credentials: {
        orders: {
          token: "old",
          refreshToken: "bad",
          expiresAt: 1,
          scopes: [],
          storedAt: 1,
          authMethod: "device",
        },
      },
    });
    const cfg = { baseUrl: "http://mock", clientId: "c", clientSecret: "s" };
    const refresh = on401(cfg)(store, "orders");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));

    const result = await refresh();
    expect(result).toBeNull();
    // L5: permanent auth failure clears the stale session.
    expect(store._snapshot().credentials.orders).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it("refresh 响应未轮换 refresh_token 时保留原 token", async () => {
    const store = memoryStore({
      credentials: {
        orders: {
          token: "old",
          refreshToken: "keep-me",
          expiresAt: 1,
          scopes: ["orders:read"],
          storedAt: 1,
          authMethod: "device",
        },
      },
    });
    const refresh = on401({
      baseUrl: "http://mock",
      clientId: "c",
      clientSecret: "s",
    })(store, "orders");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 }),
      );

    await expect(refresh()).resolves.toBe("new");
    expect(store._snapshot().credentials.orders.refreshToken).toBe("keep-me");
    expect(store._snapshot().credentials.orders.scopes).toEqual(["orders:read"]);
    fetchSpy.mockRestore();
  });
});
