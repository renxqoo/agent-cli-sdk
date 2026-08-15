/**
 * oauth.ts 端点测试 —— M8:非 JSON 响应应抛 decode_failure,不抛裸 SyntaxError。
 *
 * 修复前:5 处 res.json() 无保护,网关返回 HTML 错误页 / 空响应时
 * res.json() 抛裸 SyntaxError → 被 pipeline 兜底成 internal/unknown(语义不准)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  deviceAuthorization,
  pollDeviceToken,
  getUserInfo,
  registerClient,
  OAuthClient,
  type OAuthClientConfig,
} from "../oauth.js";
import { InternalError, APIError, AuthenticationError, NetworkError } from "../errs/index.js";

const cfg: OAuthClientConfig = {
  baseUrl: "http://test",
  clientId: "cid",
  clientSecret: "csec",
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 非 JSON 响应(如网关 HTML 错误页)。用真实 Response 以保留 .json()/.text() 行为。 */
function htmlResponse(status: number): Response {
  return new Response("<html>Gateway Error</html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

/** 空响应体。 */
function emptyResponse(status: number): Response {
  return new Response("", { status });
}

/** JSON 响应。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("M8: 非 JSON 响应应抛 InternalError(decode_failure),不抛裸 SyntaxError", () => {
  it("deviceAuthorization: 网关返回 HTML → decode_failure", async () => {
    fetchMock.mockResolvedValue(htmlResponse(500));
    try {
      await deviceAuthorization(cfg, "scope");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InternalError);
      expect((err as InternalError).subtype).toBe("decode_failure");
    }
  });

  it("pollDeviceToken: 非 JSON → decode_failure(而非裸 SyntaxError)", async () => {
    fetchMock.mockResolvedValue(htmlResponse(200));
    await expect(pollDeviceToken(cfg, "code")).rejects.toThrow(InternalError);
  });

  it("OAuthClient.refresh: 非 JSON → decode_failure", async () => {
    fetchMock.mockResolvedValue(htmlResponse(200));
    await expect(new OAuthClient(cfg).refresh("rt")).rejects.toThrow(InternalError);
  });

  it("getUserInfo: 非 JSON → decode_failure", async () => {
    fetchMock.mockResolvedValue(htmlResponse(200));
    await expect(getUserInfo(cfg, "at")).rejects.toThrow(InternalError);
  });

  it("registerClient: 非 JSON → decode_failure", async () => {
    fetchMock.mockResolvedValue(htmlResponse(500));
    await expect(registerClient("http://test", "tok")).rejects.toThrow(InternalError);
  });

  it("空响应体也不崩(视为无可解析 body)", async () => {
    // 空响应不应抛 decode_failure;具体后续行为依各函数(!res.ok 路径)
    fetchMock.mockResolvedValue(emptyResponse(500));
    // deviceAuthorization:空 500 → 应抛(APIError,因 !res.ok),不抛 SyntaxError
    await expect(deviceAuthorization(cfg, "scope")).rejects.toBeInstanceOf(APIError);
  });
});

describe("oauth: 正常 JSON 路径仍工作(回归保护)", () => {
  it("deviceAuthorization 成功返回 DeviceAuthInfo", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        device_code: "dc",
        user_code: "uc",
        verification_uri: "uri",
        expires_in: 100,
        interval: 5,
      }),
    );
    const info = await deviceAuthorization(cfg, "scope");
    expect(info.device_code).toBe("dc");
    expect(info.interval).toBe(5);
  });

  it("OAuthClient.refresh 失败(!ok)→ AuthenticationError(token_expired)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
    await expect(new OAuthClient(cfg).refresh("rt")).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("OAuth transport boundary", () => {
  it("classifies fetch failures as NetworkError", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(getUserInfo(cfg, "token")).rejects.toBeInstanceOf(NetworkError);
  });

  it("rejects a successful response whose required fields are missing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await expect(getUserInfo(cfg, "token")).rejects.toBeInstanceOf(InternalError);
  });
});
