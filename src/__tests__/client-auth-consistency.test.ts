/**
 * client 认证一致性测试:所有 token 端点调用应使用 HTTP Basic auth,
 * 而不是在 body 里传 client_secret(除 PKCE public client 外)。
 *
 * RFC 6749 §2.3.1:推荐用 Basic auth。body 传 secret 不安全(可能被记日志)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pollDeviceToken,
  exchangeCodeForToken,
  clientCredentialsToken,
  OAuthClient,
  type OAuthClientConfig,
} from "../oauth.js";

const cfg: OAuthClientConfig = {
  baseUrl: "http://test",
  clientId: "cid",
  clientSecret: "csec",
};

const publicCfg: OAuthClientConfig = {
  baseUrl: "http://test",
  clientId: "cid",
  clientSecret: "", // PKCE public client:无 secret
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getCallHeaders(): Record<string, string> {
  return fetchMock.mock.calls[0]?.[1]?.headers ?? {};
}

function getCallBody(): string {
  return fetchMock.mock.calls[0]?.[1]?.body ?? "";
}

describe("client 认证一致性:token 端点用 Basic auth", () => {
  it("pollDeviceToken:用 Basic auth(不在 body 里传 secret)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        access_token: "AT",
        expires_in: 3600,
        refresh_token: "RT",
        scope: "s",
      }),
    );
    await pollDeviceToken(cfg, "dc_123");
    const headers = getCallHeaders();
    const body = getCallBody();
    expect(headers.authorization).toMatch(/^Basic /);
    expect(body).not.toContain("client_secret");
  });

  it("OAuthClient.refresh:用 Basic auth(不在 body 里传 secret)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        access_token: "AT",
        expires_in: 3600,
        refresh_token: "RT2",
        scope: "s",
      }),
    );
    await new OAuthClient(cfg).refresh("rt_old");
    const headers = getCallHeaders();
    const body = getCallBody();
    expect(headers.authorization).toMatch(/^Basic /);
    expect(body).not.toContain("client_secret");
  });

  it("exchangeCodeForToken:confidential client 用 Basic auth", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        access_token: "AT",
        expires_in: 3600,
        refresh_token: "RT",
        scope: "s",
      }),
    );
    await exchangeCodeForToken(cfg, {
      code: "ac_123",
      codeVerifier: "verifier",
      redirectUri: "http://localhost/cb",
    });
    const headers = getCallHeaders();
    expect(headers.authorization).toMatch(/^Basic /);
  });

  it("exchangeCodeForToken:public client(无 secret)不发 Basic auth,只在 body 传 client_id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        access_token: "AT",
        expires_in: 3600,
        scope: "s",
      }),
    );
    await exchangeCodeForToken(publicCfg, {
      code: "ac_123",
      codeVerifier: "verifier",
      redirectUri: "http://localhost/cb",
    });
    const headers = getCallHeaders();
    expect(headers.authorization).toBeUndefined(); // public client 不发 Basic
    const body = getCallBody();
    expect(body).toContain("client_id=cid");
    expect(body).not.toContain("client_secret");
  });

  it("clientCredentialsToken:已用 Basic auth(不变)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        access_token: "AT",
        expires_in: 3600,
        scope: "s",
      }),
    );
    await clientCredentialsToken(cfg, "s");
    const headers = getCallHeaders();
    expect(headers.authorization).toMatch(/^Basic /);
  });
});
