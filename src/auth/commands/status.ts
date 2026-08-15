/**
 * status 命令:显示当前登录状态。
 * client_credentials/机器 session 跳过 getUserInfo(无用户上下文)。
 */
import { defineCommand } from "../../define.js";
import { errs, AuthenticationError } from "../../errs/index.js";
import type { CommandResult, CommandSpec } from "../../types.js";
import type { ConfigStore, StoredOAuthCredentials } from "../../credentials/types.js";
import { getUserInfo, type OAuthClientConfig } from "../../oauth.js";

export interface StatusCommandDeps {
  oauth: OAuthClientConfig;
  store: ConfigStore;
  credentialNamespace: string;
  commandNamespace: string;
}

export function createStatusCommand(deps: StatusCommandDeps): CommandSpec {
  const { oauth, store } = deps;
  const credNs = deps.credentialNamespace;
  const cmdNs = deps.commandNamespace;

  return defineCommand({
    name: "status",
    description: "Show current login status",
    async run(ctx): Promise<CommandResult> {
      const creds = (await store.loadCredentials(credNs)) as Partial<StoredOAuthCredentials> | null;
      if (!creds?.token) {
        ctx.log.info(`Not logged in. Run \`${cmdNs} login\` to log in.`);
        return { data: { loggedIn: false } };
      }
      const expired = creds.expiresAt ? Date.now() >= creds.expiresAt : false;

      // client_credentials/机器 session:无用户上下文,跳过 getUserInfo
      if (creds.authMethod === "client_credentials") {
        ctx.log.info(
          `Logged in (machine): ${oauth.baseUrl}\ntoken ${expired ? "expired (will auto-refresh on next call)" : "valid"}`,
        );
        return { data: { loggedIn: true, expired } };
      }

      // L3: 用户态 session 在 token 已过期时短路返回(与机器态同形结构),
      // 不再用可能过期的 token 调 getUserInfo 导致命令失败。框架会在下次调用时续期。
      if (expired) {
        return { data: { loggedIn: true, expired } };
      }

      try {
        const user = await getUserInfo(oauth, creds.token);
        ctx.log.info(
          `Logged in: ${user.name} (${user.open_id})\nMiddleware: ${oauth.baseUrl}\ntoken ${expired ? "expired (will auto-refresh on next call)" : "valid"}`,
        );
        return { data: { loggedIn: true, user: { id: user.open_id, name: user.name }, expired } };
      } catch (err) {
        if (!(err instanceof AuthenticationError)) throw err;
        ctx.log.info("Authentication expired. Please log in again.");
        throw new errs.AuthenticationError({
          subtype: "token_expired",
          message: "Authentication expired",
          hint: `run \`${cmdNs} login\` to log in again`,
        });
      }
    },
  });
}
