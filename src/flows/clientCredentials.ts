/**
 * client_credentials 策略(RFC 6749 §4.4)。
 *
 * 机器对机器:无用户参与,直接用 client_id + client_secret 换 token。
 * 通常不发 refresh_token → 401 时重新 login(覆盖 refresh)。
 */
import { clientCredentialsToken, type TokenInfo } from "../oauth.js";
import type { AuthFlow, FlowDeps } from "./types.js";

export const clientCredentialsFlow: AuthFlow = {
  type: "client_credentials" as const,

  async login(deps: FlowDeps): Promise<TokenInfo> {
    if (deps.type !== "client_credentials") {
      throw new TypeError(`clientCredentialsFlow.login received non-cc deps (${deps.type})`);
    }
    return clientCredentialsToken(deps.cfg, deps.scope);
  },

  /**
   * client_credentials 没有 refresh_token → 401 时重新用 client 凭证换 token。
   * scope 沿用 deps.scope(由框架从持久化的已授予 scopes 重组,见 flow-coordinator)。
   */
  async refresh(deps: FlowDeps): Promise<TokenInfo> {
    if (deps.type !== "client_credentials") {
      throw new TypeError(`clientCredentialsFlow.refresh received non-cc deps (${deps.type})`);
    }
    return clientCredentialsToken(deps.cfg, deps.scope);
  },
};
