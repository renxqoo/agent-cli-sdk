/**
 * PKCE(RFC 7636)数学函数 + authorization_code / client_credentials 协议函数测试。
 *
 * L1 协议原语层:纯函数 + 纯 fetch,无状态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateCodeVerifier,
  computeCodeChallenge,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  clientCredentialsToken,
  type OAuthClientConfig,
} from "../oauth.js";

const cfg: OAuthClientConfig = {
  baseUrl: "http://auth-server.test",
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// RFC 7636 附录 B 的标准测试向量
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("PKCE 数学(RFC 7636)", () => {
  it("generateCodeVerifier:返回 base64url 字符串,长度 >= 43", () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/); // base64url 字符集
    expect(v.length).toBeGreaterThanOrEqual(43); // RFC 7636 §4.1 最小长度
  });

  it("generateCodeVerifier:每次生成不同的值", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it("computeCodeChallenge:S256 匹配 RFC 7636 附录 B 测试向量", () => {
    expect(computeCodeChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("computeCodeChallenge:不同 verifier → 不同 challenge", () => {
    const c1 = computeCodeChallenge("verifier-one");
    const c2 = computeCodeChallenge("verifier-two");
    expect(c1).not.toBe(c2);
  });
});

describe("buildAuthorizeUrl(RFC 6749 §4.1.1)", () => {
  it("构建正确的 authorize URL", () => {
    const url = buildAuthorizeUrl(cfg, {
      redirectUri: "http://localhost:3000/callback",
      scope: "orders:read offline_access",
      codeChallenge: RFC_CHALLENGE,
      state: "xyz123",
    });
    expect(url).toContain("http://auth-server.test/authorize");
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("redirect_uri="); // URL-encoded
    expect(url).toContain("scope="); // URL-encoded
    expect(url).toContain("code_challenge=" + RFC_CHALLENGE);
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("state=xyz123");
  });

  it("scope 省略时 URL 不含 scope 参数", () => {
    const url = buildAuthorizeUrl(cfg, {
      redirectUri: "http://localhost:3000/callback",
      codeChallenge: RFC_CHALLENGE,
    });
    expect(url).not.toContain("scope=");
  });

  it("state 省略时 URL 不含 state 参数", () => {
    const url = buildAuthorizeUrl(cfg, {
      redirectUri: "http://localhost:3000/callback",
      codeChallenge: RFC_CHALLENGE,
    });
    expect(url).not.toContain("state=");
  });

  it("始终带 code_challenge_method=S256(OAuth 2.1 强制)", () => {
    const url = buildAuthorizeUrl(cfg, {
      redirectUri: "http://localhost:3000/callback",
      codeChallenge: "anychallenge",
    });
    expect(url).toContain("code_challenge_method=S256");
  });
});

describe("exchangeCodeForToken(RFC 6749 §4.1.3 + PKCE)", () => {
  it("正确 code + code_verifier → 200 TokenInfo", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        access_token: "AT123",
        refresh_token: "RT456",
        expires_in: 3600,
        scope: "orders:read offline_access",
      }),
    );
    const token = await exchangeCodeForToken(cfg, {
      code: "ac_test",
      codeVerifier: RFC_VERIFIER,
      redirectUri: "http://localhost:3000/callback",
    });
    expect(token.access_token).toBe("AT123");
    expect(token.refresh_token).toBe("RT456");
    expect(token.expires_in).toBe(3600);
    expect(token.scope).toBe("orders:read offline_access");

    // 验证请求体
    const callBody = fetchMock.mock.calls[0][1];
    const bodyStr = callBody.body as string;
    expect(bodyStr).toContain("grant_type=authorization_code");
    expect(bodyStr).toContain("code=ac_test");
    expect(bodyStr).toContain("code_verifier=");
    expect(bodyStr).toContain("redirect_uri=");
  });

  it("服务端返 400 → APIError", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
    await expect(
      exchangeCodeForToken(cfg, {
        code: "bad",
        codeVerifier: "verifier",
        redirectUri: "http://localhost:3000/callback",
      }),
    ).rejects.toThrow();
  });
});

describe("clientCredentialsToken(RFC 6749 §4.4)", () => {
  it("正确 client 凭证 → 200 TokenInfo(无 refresh_token)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        access_token: "AT_machine",
        expires_in: 3600,
        scope: "orders:read",
      }),
    );
    const token = await clientCredentialsToken(cfg, "orders:read");
    expect(token.access_token).toBe("AT_machine");
    expect(token.expires_in).toBe(3600);
    expect(token.refresh_token).toBeUndefined(); // client_credentials 通常不发 refresh_token

    const callBody = fetchMock.mock.calls[0][1];
    const bodyStr = callBody.body as string;
    expect(bodyStr).toContain("grant_type=client_credentials");
    expect(bodyStr).toContain("scope=orders");
  });

  it("认证用 Basic header(client_id:client_secret)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { access_token: "AT", expires_in: 3600 }));
    await clientCredentialsToken(cfg);
    const callHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(callHeaders.authorization).toMatch(/^Basic /);
  });
});
