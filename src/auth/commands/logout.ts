/**
 * logout 命令:吊销 token + 清本地凭证。
 */
import { defineCommand } from "../../define.js";
import type { CommandResult, CommandSpec } from "../../types.js";
import type { ConfigStore } from "../../credentials/types.js";
import type { StoredOAuthCredentials } from "../../credentials/types.js";
import type { OAuthClientConfig } from "../../oauth.js";
import { revokeToken } from "../../oauth.js";

export interface LogoutCommandDeps {
  oauth: OAuthClientConfig;
  store: ConfigStore;
  credentialNamespace: string;
}

export function createLogoutCommand(deps: LogoutCommandDeps): CommandSpec {
  const { oauth, store } = deps;
  const credNs = deps.credentialNamespace;

  return defineCommand({
    name: "logout",
    description: "Log out (revoke session + clear local credentials)",
    async run(ctx): Promise<CommandResult> {
      const creds = (await store.loadCredentials(credNs)) as Partial<StoredOAuthCredentials> | null;
      // B6: revoke the long-lived refresh token as well as the access token, so the
      // session is invalidated server-side, not merely cleared locally.
      if (creds?.token) {
        try {
          await revokeToken(oauth, creds.token, "access_token");
        } catch {
          /* 离线/服务不可用仍清本地 */
        }
      }
      if (creds?.refreshToken) {
        try {
          await revokeToken(oauth, creds.refreshToken, "refresh_token");
        } catch {
          /* best-effort: refresh token revocation is optional per RFC 7009 */
        }
      }
      await store.clearCredentials(credNs);
      ctx.log.info("Logged out.");
      return { data: { loggedOut: true } };
    },
  });
}
