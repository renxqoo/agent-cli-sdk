/**
 * login 命令:纯委托 flow 策略。
 * - 正常:flow.login() → persistCredentials
 * - device flow --no-wait:flow 抛 SplitFlowSignal → 框架返回 JSON/url
 * - device flow --device-code:flow 恢复轮询
 */
import { defineCommand } from "../../define.js";
import * as z from "zod";
import { errs } from "../../errs/index.js";
import type { CommandResult, CommandSpec } from "../../types.js";
import type { ConfigStore, StoredOAuthCredentials } from "../../credentials/types.js";
import { getUserInfo, type OAuthClientConfig, type TokenInfo } from "../../oauth.js";
import type { AuthFlow, FlowType, FlowDeps } from "../../flows/types.js";
import { SplitFlowSignal } from "../../flows/device.js";

export interface LoginCommandDeps {
  oauth: OAuthClientConfig;
  store: ConfigStore;
  credentialNamespace: string;
  commandNamespace: string;
  scope?: string;
  flow: AuthFlow;
  redirectPort?: number;
}

/** 统一落盘(被 login 命令调)。 */
export async function persistCredentials(
  store: ConfigStore,
  namespace: string,
  oauth: OAuthClientConfig,
  token: TokenInfo,
  flowType: FlowType,
  log?: { info(...args: unknown[]): void },
): Promise<{ loggedIn: boolean; user?: { id: string; name: string } }> {
  const creds: StoredOAuthCredentials = {
    token: token.access_token,
    refreshToken: token.refresh_token ?? "",
    ...(typeof token.expires_in === "number"
      ? { expiresAt: Date.now() + token.expires_in * 1000 }
      : {}),
    scopes: token.scope?.split(/\s+/).filter(Boolean) ?? [],
    storedAt: Date.now(),
    authMethod: flowType,
  };

  // client_credentials 没有 user;device/authCode 查 user_info
  if (flowType !== "client_credentials") {
    try {
      const user = await getUserInfo(oauth, token.access_token);
      creds.user = { userId: user.open_id, name: user.name };
      await store.saveCredentials(namespace, creds as unknown as Record<string, unknown>);
      log?.info(`\n✓ Login successful: ${user.name} (${user.open_id})`);
      return { loggedIn: true, user: { id: user.open_id, name: user.name } };
    } catch {
      await store.saveCredentials(namespace, creds as unknown as Record<string, unknown>);
      log?.info("\n✓ Login successful (could not fetch user info)");
      return { loggedIn: true };
    }
  }

  await store.saveCredentials(namespace, creds as unknown as Record<string, unknown>);
  log?.info("\n✓ Login successful (client credentials)");
  return { loggedIn: true };
}

export function createLoginCommand(deps: LoginCommandDeps): CommandSpec<any> {
  const { oauth, store, scope, flow } = deps;
  const credNs = deps.credentialNamespace;
  const cmdNs = deps.commandNamespace;

  return defineCommand({
    name: "login",
    description: `Log in via the middleware (OAuth ${flow.type.replace("_", " ")} flow)`,
    args: {
      schema: z.object({
        wait: z.boolean().describe("Block and poll; --no-wait returns immediately").default(true),
        deviceCode: z
          .string()
          .describe("Complete login with an existing device_code (split-flow step 2)")
          .optional(),
      }),
    },
    async run(ctx, args): Promise<CommandResult> {
      // 校验:--no-wait / --device-code 只对 device flow 有效
      const deviceCode = args.deviceCode;
      const noWait = args.wait === false;
      if ((deviceCode || noWait) && flow.type !== "device") {
        throw new errs.ValidationError({
          subtype: "invalid_argument",
          param: deviceCode ? "--device-code" : "--no-wait",
          message: `--${deviceCode ? "device-code" : "no-wait"} is only supported for device flow (current: ${flow.type})`,
        });
      }

      // 构造 deps:C2 按 flow.type 构造判别联合的对应变体。
      const flowDeps: FlowDeps =
        flow.type === "device"
          ? {
              type: "device",
              cfg: oauth,
              scope,
              log: ctx.log,
              noWait: args.wait === false,
              resumeDeviceCode: args.deviceCode,
            }
          : flow.type === "authorization_code"
            ? {
                type: "authorization_code",
                cfg: oauth,
                scope,
                log: ctx.log,
                callbackPort: deps.redirectPort,
              }
            : { type: "client_credentials", cfg: oauth, scope, log: ctx.log };

      try {
        // 委托 flow.login() → 统一落盘
        const token = await flow.login(flowDeps);
        const result = await persistCredentials(store, credNs, oauth, token, flow.type, ctx.log);
        return { data: result };
      } catch (e) {
        // device flow --no-wait:flow 抛 SplitFlowSignal,框架捕获后返回 JSON/url
        if (e instanceof SplitFlowSignal) {
          ctx.log.info(
            `\nPlease complete login in your browser:\n  ${e.verificationUrl}\n  user code: ${e.userCode}\n\ndevice_code: ${e.deviceCode}\n(not polling. After authorizing, run: ${cmdNs} login --device-code ${e.deviceCode})`,
          );
          return {
            data: {
              device_code: e.deviceCode,
              user_code: e.userCode,
              verification_url: e.verificationUrl,
              verification_uri_complete: e.verificationUriComplete,
              verification_uri: e.verificationUri,
              expires_in: e.expiresIn,
              interval: e.interval,
            },
          };
        }
        throw e;
      }
    },
  });
}
