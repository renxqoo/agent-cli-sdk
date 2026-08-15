/**
 * register 命令:用注册令牌 + client_metadata 换独立 client(RFC 7591)。
 */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { defineCommand } from "../../define.js";
import * as z from "zod";
import { errs } from "../../errs/index.js";
import type { CommandResult, CommandSpec } from "../../types.js";
import type { ConfigStore } from "../../credentials/types.js";
import { registerClient, type ClientMetadata } from "../../oauth.js";

export interface RegisterCommandDeps {
  baseUrl: string;
  store: ConfigStore;
  credentialNamespace: string;
  commandNamespace: string;
  clientMetadata?: ClientMetadata;
}

export function createRegisterCommand(deps: RegisterCommandDeps): CommandSpec<any> {
  const { baseUrl, store } = deps;
  const cmdNs = deps.commandNamespace;

  return defineCommand({
    name: "register",
    description:
      "Register this machine's CLI client (exchange a registration token for standalone credentials)",
    args: {
      schema: z.object({
        token: z.string().describe("Registration token (interactive prompt if omitted)").optional(),
      }),
    },
    async run(ctx, args): Promise<CommandResult> {
      let token = args.token as string | undefined;
      if (!token) {
        if (!stdin.isTTY) {
          throw new errs.ValidationError({
            subtype: "missing_required",
            param: "--token",
            message: "--token is required in a non-interactive environment",
            hint: `run \`${cmdNs} register --token <registration-token>\``,
          });
        }
        const rl = readline.createInterface({ input: stdin, output: stdout });
        try {
          token = (await rl.question("Please enter the registration token: ")).trim();
        } finally {
          rl.close();
        }
      }
      if (!token) {
        throw new errs.ValidationError({
          subtype: "missing_required",
          param: "--token",
          message: "No token entered",
        });
      }

      const { clientId, clientSecret } = await registerClient(baseUrl, token, deps.clientMetadata);
      const namespace = deps.credentialNamespace;
      const config = (await store.loadConfig(namespace)) as Record<string, unknown>;
      config.clientId = clientId;
      config.clientSecret = clientSecret;
      await store.saveConfig(namespace, config);

      ctx.log.info(`\n✓ Registered successfully. clientId=${clientId}`);
      return { data: { registered: true, clientId } };
    },
  });
}
