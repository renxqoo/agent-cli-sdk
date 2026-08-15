/** 命令运行时：生命周期、输出契约和错误决策只有这一处拥有。 */

import type { CommandContext, CommandResult, CommandSpec, Plugin } from "./types.js";
import * as z from "zod";
import {
  BareError,
  ConfirmationRequiredError,
  InternalError,
  PolicyError,
  exitCodeOf,
  toCliError,
} from "./errs/index.js";
import { serializeError, serializeSuccess } from "./envelope.js";
import { prettyError, prettyPrint } from "./pretty.js";
import {
  handleError,
  observeError,
  observeInput,
  runBeforeCommand,
  transformOutput,
} from "./plugin.js";
import { credentialArgsKey, idempotencyKey } from "./context.js";
import { isRawTextResult, isStructuredData } from "./output.js";
import { commandExecutionKey, type ResolvedCommandArgs } from "./command-schema.js";
import type { CommandSchemaMetadata } from "./command-contracts.js";

export interface RunCommandOptions<State> {
  spec: CommandSpec<any, unknown, State>;
  /** 延迟解析让参数错误也经过统一错误边界。 */
  args:
    | Record<string, unknown>
    | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  ctx: CommandContext<State>;
  plugins: Plugin<State>[];
  identity?: "user" | "bot" | (() => "user" | "bot" | undefined);
  route: string[];
  humanReadable?: boolean;
  pluginArgs?: Record<string, unknown>;
  ownedRoutes?: ReadonlyMap<Plugin<State>, string[][]>;
  source: string;
}

interface RenderOptions {
  identity?: "user" | "bot";
  humanReadable?: boolean;
  source: string;
  dryRun?: boolean;
}

/** 执行一个命令并渲染输出；调用方只负责把返回值设为进程退出码。 */
export async function runCommand<State>(options: RunCommandOptions<State>): Promise<number> {
  const { spec, ctx, plugins } = options;
  const resolveIdentity = (): "user" | "bot" | undefined =>
    typeof options.identity === "function" ? options.identity() : options.identity;

  try {
    const args = await (typeof options.args === "function" ? options.args() : options.args);
    if (options.pluginArgs) {
      (ctx as CommandContext<State> & { [credentialArgsKey]?: Record<string, unknown> })[
        credentialArgsKey
      ] = options.pluginArgs;
    }

    if (!spec.skipPluginHooks) {
      await runBeforeCommand(plugins, ctx, options.route, options.ownedRoutes);
    }

    const invocation = args as ResolvedCommandArgs;
    const execution = invocation[commandExecutionKey];
    const metadata = spec.args
      ? (z.globalRegistry.get(spec.args.schema) as CommandSchemaMetadata | undefined)
      : undefined;
    const redactedArgs = redactArgs(args, metadata?.sensitive);
    if (execution?.json) {
      await observeInput(plugins, ctx, {
        route: options.route,
        meta: execution.json,
        redactedArgs,
      });
    }
    const policy = spec.policy;
    if (policy?.mode === "write") {
      if (policy.idempotency && execution?.idempotencyKey) {
        (ctx as CommandContext<State> & { [idempotencyKey]?: { key: string; header: string } })[
          idempotencyKey
        ] = {
          key: execution.idempotencyKey,
          header: policy.idempotencyHeader ?? "Idempotency-Key",
        };
      }
      if (execution?.dryRun) {
        const preview =
          typeof policy.dryRun === "object" && policy.dryRun.preview
            ? await policy.dryRun.preview(args, readOnlyContext(ctx))
            : {
                data: { args: redactedArgs },
                ...(execution.json
                  ? { meta: { inputDigest: execution.json.validatedDigest } }
                  : {}),
              };
        return await renderCommandResult(preview, spec, ctx, plugins, {
          identity: resolveIdentity(),
          humanReadable: options.humanReadable,
          source: options.source,
          dryRun: true,
        });
      }
      if (policy.confirmation === "required" && !execution?.confirmed) {
        throw new ConfirmationRequiredError({
          subtype: "high_risk_write",
          message: `${options.route.join(" ")} is a write operation and requires confirmation`,
          hint: execution?.json
            ? `Review input ${execution.json.validatedDigest}, then add --yes.`
            : "Review the arguments, then add --yes.",
        });
      }
    }

    const result = await spec.run(ctx, args);
    return await renderCommandResult(result, spec, ctx, plugins, {
      identity: resolveIdentity(),
      humanReadable: options.humanReadable,
      source: options.source,
    });
  } catch (error) {
    return handleCommandError(error, spec, ctx, plugins, {
      identity: resolveIdentity(),
      humanReadable: options.humanReadable,
      source: options.source,
    });
  }
}

function redactArgs(value: unknown, pointers: readonly string[] = []): unknown {
  const clone = structuredClone(value);
  for (const pointer of pointers) {
    const parts = pointer
      .split("/")
      .slice(1)
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let parent: any = clone;
    for (let index = 0; index < parts.length - 1; index++) {
      parent = parent?.[parts[index]!];
      if (!parent || typeof parent !== "object") break;
    }
    const key = parts.at(-1);
    if (key !== undefined && parent && typeof parent === "object" && key in parent) {
      parent[key] = "[REDACTED]";
    }
  }
  return clone;
}

async function renderCommandResult<State>(
  result: CommandResult<unknown> | void,
  spec: CommandSpec<any, unknown, State>,
  ctx: CommandContext<State>,
  plugins: Plugin<State>[],
  options: RenderOptions,
): Promise<number> {
  if (result === undefined) {
    if (options.humanReadable) {
      process.stdout.write("(no output)\n");
    } else {
      process.stdout.write(
        serializeSuccess(null, undefined, {
          identity: options.identity,
          source: options.source,
          dryRun: options.dryRun,
        }),
      );
    }
    return 0;
  }

  if (isRawTextResult(result)) {
    process.stdout.write(result.text);
    return 0;
  }

  if (
    !result ||
    typeof result !== "object" ||
    !Object.prototype.hasOwnProperty.call(result, "data") ||
    !("data" in result) ||
    result.data === undefined
  ) {
    throw contractViolation(`Command ${spec.name} must return { data }, rawText(), or void`);
  }
  if (!isStructuredData(result.data)) {
    throw contractViolation(
      `Command ${spec.name} data must be object/array/null, got ${typeof result.data}`,
    );
  }

  const transformed = await transformOutput(plugins, ctx, result.data);
  const meta = "meta" in result ? result.meta : undefined;
  if (options.humanReadable) {
    const format = spec.humanFormat ?? prettyPrint;
    process.stdout.write(format(transformed, meta) + "\n");
  } else {
    process.stdout.write(
      serializeSuccess(transformed, meta, {
        identity: options.identity,
        source: options.source,
        dryRun: options.dryRun,
      }),
    );
  }
  return 0;
}

function readOnlyContext<State>(ctx: CommandContext<State>): CommandContext<State> {
  const blocked = async (): Promise<never> => {
    throw new PolicyError({
      subtype: "access_denied",
      message: "Write requests are forbidden while building a dry-run preview",
    });
  };
  return {
    ...ctx,
    request: (request) => (request.method === "GET" ? ctx.request(request) : blocked()),
    post: blocked,
    put: blocked,
    patch: blocked,
    delete: blocked,
  };
}

async function handleCommandError<State>(
  error: unknown,
  spec: CommandSpec<any, unknown, State>,
  ctx: CommandContext<State>,
  plugins: Plugin<State>[],
  options: RenderOptions,
): Promise<number> {
  if (error instanceof BareError) return error.exitCode;

  let cliError = toCliError(error);
  await observeError(plugins, ctx, cliError);
  const decision = await handleError(plugins, ctx, cliError);

  if (decision.action === "recover") {
    try {
      return await renderCommandResult(decision.result, spec, ctx, plugins, options);
    } catch (recoveryError) {
      cliError = toCliError(recoveryError);
    }
  } else {
    cliError = toCliError(decision.error);
  }

  if (options.humanReadable) {
    process.stderr.write(prettyError(cliError) + "\n");
  } else {
    process.stderr.write(serializeError(cliError, { identity: options.identity }) + "\n");
  }
  return exitCodeOf(cliError.category);
}

function contractViolation(message: string): InternalError {
  return new InternalError({ subtype: "contract_violation", message });
}
