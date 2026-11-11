import type {
  AttemptOutcome,
  CommandContext,
  ErrorOnStatus,
  HttpAdapter,
  Plugin,
  RequestAttemptEvent,
  RequestOptions,
  TransportResponse,
} from "./types.js";
import { CliError, InternalError, NetworkError, PolicyError } from "./errs/index.js";
import { readOnlyRequestKey } from "./context.js";
import { beforeRequest, compilePlugins, handleUnauthorized, observeRequest } from "./plugin.js";
import { throwForResponse } from "./request.js";
import { cloneRequest } from "./request-snapshot.js";

export interface RequestExecutor<State> {
  execute<T>(
    ctx: CommandContext<State>,
    request: Readonly<RequestOptions>,
  ): Promise<TransportResponse<T>>;
}

export function createRequestExecutor<State>(options: {
  adapter: HttpAdapter;
  plugins?: Plugin<State>[];
  errorOnStatus?: ErrorOnStatus;
}): RequestExecutor<State> {
  const plugins = compilePlugins(options.plugins ?? []);

  return {
    async execute<T>(
      ctx: CommandContext<State>,
      request: Readonly<RequestOptions>,
    ): Promise<TransportResponse<T>> {
      const logicalRequest = cloneRequest(request);

      for (let attempt = 1; attempt <= 2; attempt++) {
        const prepared = await beforeRequest(plugins, ctx, logicalRequest);
        if (
          (ctx as CommandContext<State> & { [readOnlyRequestKey]?: boolean })[readOnlyRequestKey] &&
          prepared.method !== "GET"
        ) {
          throw new PolicyError({
            subtype: "access_denied",
            message: "Write requests are forbidden during dry-run",
          });
        }
        const outcome = await sendAttempt<T>(options.adapter, prepared);
        const event: RequestAttemptEvent<T> = {
          attempt,
          reason: attempt === 1 ? "initial" : "authentication-retry",
          logicalRequest: cloneRequest(logicalRequest),
          request: cloneRequest(prepared),
          outcome,
        };
        await observeRequest(plugins, ctx, event);

        if (outcome.kind === "network-error") {
          if (outcome.error instanceof CliError) throw outcome.error;
          throw new NetworkError({
            subtype: "connection_refused",
            message: `Network error: ${
              outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
            }`,
            retryable: true,
            cause: outcome.error,
          });
        }

        const response = outcome.response;
        if (response.status === 401 && attempt === 1) {
          const decision = await handleUnauthorized(plugins, ctx, event);
          if (decision?.action === "retry") continue;
          if (decision?.action === "reject") throw decision.error;
        }

        throwForResponse(response, options.errorOnStatus);
        return response;
      }

      // M8: keep the typed error taxonomy even for the (unreachable) guard.
      throw new InternalError({
        subtype: "contract_violation",
        message: "unreachable request attempt state",
      });
    },
  };
}

async function sendAttempt<T>(
  adapter: HttpAdapter,
  request: Readonly<RequestOptions>,
): Promise<AttemptOutcome<T>> {
  try {
    return await adapter.send<T>(request);
  } catch (error) {
    return { kind: "network-error", error };
  }
}
