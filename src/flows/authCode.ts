/**
 * authorization_code + PKCE 策略(RFC 6749 §4.1 + RFC 7636)。
 *
 * 组合 L1(协议原语)+ L2(浏览器 + 回调服务器):
 *  1. 生成 PKCE verifier + challenge(S256)
 *  2. 启动本地回调服务器
 *  3. 构建 authorize URL → 打开浏览器
 *  4. 等待回调拿到 code
 *  5. 用 code + code_verifier 换 token
 */
import {
  generateCodeVerifier,
  computeCodeChallenge,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  type TokenInfo,
} from "../oauth.js";
import { defaultBrowserOpener } from "../infra/browser.js";
import { waitForCallback } from "../infra/callback-server.js";
import { AuthenticationError } from "../errs/index.js";
import type { AuthFlow, FlowDeps } from "./types.js";

export const authCodeFlow: AuthFlow = {
  type: "authorization_code" as const,

  async login(deps: FlowDeps): Promise<TokenInfo> {
    if (deps.type !== "authorization_code") {
      throw new TypeError(`authCodeFlow.login received non-authCode deps (${deps.type})`);
    }
    // 1. PKCE
    const verifier = generateCodeVerifier();
    const challenge = computeCodeChallenge(verifier);

    const state = deps.state ?? generateCodeVerifier().slice(0, 16); // 随机 state 防 CSRF

    // 2. 启动本地回调监听
    const handle = await waitForCallback({
      port: deps.callbackPort,
      timeoutMs: 5 * 60_000, // 5 分钟超时
      expectedState: state,
    });

    // 3. 构建 authorize URL + 打开浏览器
    const authUrl = buildAuthorizeUrl(deps.cfg, {
      redirectUri: handle.redirectUri,
      scope: deps.scope,
      codeChallenge: challenge,
      state,
    });

    deps.log?.info(`\nOpening browser for login:\n  ${authUrl}\n`);
    const browser = deps.browser ?? defaultBrowserOpener();
    // 4. 打开浏览器并等待回调。两步共享同一个资源边界，任一步失败都关闭监听。
    let result;
    try {
      await browser.open(authUrl);
      result = await handle.result;
    } finally {
      handle.close();
    }

    if (result.kind === "error") {
      // L12: a denied consent / state mismatch is a failed authorization, not a
      // revocation of an existing token. Reserve `token_revoked` for real revocation.
      throw new AuthenticationError({
        subtype: "token_expired",
        message: `Authorization denied: ${result.error}`,
      });
    }

    // 5. 用 code + verifier 换 token
    return exchangeCodeForToken(deps.cfg, {
      code: result.code,
      codeVerifier: verifier,
      redirectUri: handle.redirectUri,
    });
  },
  // 不实现 refresh → 框架用默认 OAuthClient.refresh
};
