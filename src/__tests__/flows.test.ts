/**
 * L3 Flow 策略测试。
 *
 * 每个 flow 的 login() 单独测试(mock L1 协议函数 + L2 基础设施)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Module mocks are intentionally top-level:Vitest hoists them before imports/tests.
const callbackRef = vi.hoisted(() => ({
  code: "ac_test" as string | null,
  error: null as string | null,
}));
vi.mock("../infra/callback-server.js", () => ({
  waitForCallback: vi.fn(async () => ({
    redirectUri: "http://127.0.0.1:9999/callback",
    result: Promise.resolve({
      get kind() {
        return callbackRef.error ? "error" : "success";
      },
      get code() {
        return callbackRef.code;
      },
      get error() {
        return callbackRef.error;
      },
    }),
    close: vi.fn(),
  })),
}));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("device flow", () => {
  it("login:申请设备码 → 轮询 → 返回 TokenInfo", async () => {
    const { deviceFlow } = await import("../flows/device.js");
    const cfg = { baseUrl: "http://test", clientId: "cid", clientSecret: "csec" };

    // device_authorization 响应
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        device_code: "dc_123",
        user_code: "ABCD-EFGH",
        verification_uri: "http://test/verify",
        expires_in: 600,
        interval: 1,
      }),
    );

    // pollDeviceToken 响盼(第一次 pending,第二次 ok)
    const mockPoller = vi.fn();
    mockPoller.mockResolvedValueOnce({ status: "pending" });
    mockPoller.mockResolvedValueOnce({
      status: "ok",
      token: { access_token: "AT", expires_in: 3600, refresh_token: "RT", scope: "orders:read" },
    });

    const token = await deviceFlow.login({
      type: "device",
      cfg,
      scope: "orders:read",
      log: { info: vi.fn() },
      poller: mockPoller,
    });

    expect(token.access_token).toBe("AT");
    expect(token.refresh_token).toBe("RT");
    expect(mockPoller).toHaveBeenCalled();
  });

  it("不实现 refresh(框架用默认)", async () => {
    const { deviceFlow } = await import("../flows/device.js");
    expect(deviceFlow.refresh).toBeUndefined();
  });
});

describe("authorization_code flow", () => {
  it("login:PKCE → 浏览器 → 回调 code → 换 token", async () => {
    callbackRef.code = "ac_test";
    callbackRef.error = null;

    const { authCodeFlow } = await import("../flows/authCode.js");
    const cfg = { baseUrl: "http://test", clientId: "cid", clientSecret: "csec" };
    const browser = { open: vi.fn().mockResolvedValue(undefined) };

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: "AT_pkce",
        refresh_token: "RT_pkce",
        expires_in: 3600,
        scope: "orders:read offline_access",
      }),
    );

    const token = await authCodeFlow.login({
      type: "authorization_code",
      cfg,
      scope: "orders:read offline_access",
      browser,
      log: { info: vi.fn() },
      state: "test-state",
    });

    expect(token.access_token).toBe("AT_pkce");
    expect(browser.open).toHaveBeenCalled();
  });

  it("回调返回 error → 抛 AuthenticationError", async () => {
    callbackRef.code = null;
    callbackRef.error = "access_denied";

    const { authCodeFlow } = await import("../flows/authCode.js");
    const cfg = { baseUrl: "http://test", clientId: "cid", clientSecret: "csec" };

    await expect(
      authCodeFlow.login({
        type: "authorization_code",
        cfg,
        browser: { open: vi.fn().mockResolvedValue(undefined) },
        log: { info: vi.fn() },
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it("L12: 回调返回 error → subtype 为 token_expired(非 token_revoked)", async () => {
    callbackRef.code = null;
    callbackRef.error = "access_denied";

    const { authCodeFlow } = await import("../flows/authCode.js");
    await expect(
      authCodeFlow.login({
        type: "authorization_code",
        cfg: { baseUrl: "http://test", clientId: "cid", clientSecret: "csec" },
        browser: { open: vi.fn().mockResolvedValue(undefined) },
        log: { info: vi.fn() },
      }),
    ).rejects.toMatchObject({ subtype: "token_expired" });
  });
});

describe("client_credentials flow", () => {
  it("login:直接换 token(无用户参与)", async () => {
    const { clientCredentialsFlow } = await import("../flows/clientCredentials.js");
    const cfg = { baseUrl: "http://test", clientId: "cid", clientSecret: "csec" };

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "AT_machine", expires_in: 3600, scope: "orders:read" }),
    );

    const token = await clientCredentialsFlow.login({
      type: "client_credentials",
      cfg,
      scope: "orders:read",
    });
    expect(token.access_token).toBe("AT_machine");
    expect(token.refresh_token).toBeUndefined();
  });

  it("refresh:重新 login(没有 refresh_token)", async () => {
    const { clientCredentialsFlow } = await import("../flows/clientCredentials.js");
    const cfg = { baseUrl: "http://test", clientId: "cid", clientSecret: "csec" };

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "AT_new", expires_in: 3600 }),
    );

    const token = await clientCredentialsFlow.refresh!({ type: "client_credentials", cfg });
    expect(token.access_token).toBe("AT_new");
  });
});
