import type {
  CommandContext,
  CredentialsApi,
  RequestOptions,
  UnauthorizedDecision,
} from "../types.js";
import type {
  ConfigStore,
  CredentialProvider,
  IdentityHint,
  ProviderContext,
  TokenResult,
} from "../credentials/index.js";
import { resolveWithChain } from "../credentials/index.js";
import { AuthenticationError } from "../errs/index.js";
import { injectAuthHeader } from "../oauth.js";
import type { TokenInfo } from "../oauth-contracts.js";
import { identityKey } from "../context.js";

interface AuthSession {
  token: TokenResult;
  identity?: IdentityHint;
}

export interface AuthSessionManagerOptions {
  namespace: string;
  commandNamespace: string;
  store: ConfigStore;
  providers: CredentialProvider[];
  refresh: () => Promise<TokenInfo | null>;
}

/** Owns provider resolution, per-command auth state, identity, injection and refresh. */
export class AuthSessionManager {
  readonly #options: AuthSessionManagerOptions;
  readonly #sessions = new WeakMap<CommandContext<any>, AuthSession>();

  constructor(options: AuthSessionManagerOptions) {
    this.#options = options;
  }

  async authenticate<State>(
    ctx: CommandContext<State>,
    credentialArgs?: Record<string, unknown>,
  ): Promise<void> {
    const providerContext = this.#providerContext(credentialArgs);
    const resolved = await resolveWithChain(this.#options.providers, providerContext);
    if (!resolved) {
      throw new AuthenticationError({
        subtype: "no_credentials",
        message: `${this.#options.namespace} is not logged in`,
        hint: `run \`${this.#options.commandNamespace} login\` to log in`,
      });
    }

    const identity = resolved.provider.resolveIdentity
      ? ((await resolved.provider.resolveIdentity(providerContext)) ?? undefined)
      : undefined;
    this.#sessions.set(ctx, { token: resolved.token, identity });
    (ctx as CommandContext<State> & { [identityKey]?: IdentityHint })[identityKey] = identity;
    (ctx as { credentials: CredentialsApi }).credentials = this.#credentialsApi();

    if (identity?.identity === "user") {
      (ctx.state as Record<string, unknown>).user = {
        ...(identity.userId ? { userId: identity.userId } : {}),
        ...(identity.name ? { name: identity.name } : {}),
      };
    }
  }

  prepare<State>(ctx: CommandContext<State>, logical: Readonly<RequestOptions>): RequestOptions {
    const request: RequestOptions = {
      ...logical,
      ...(logical.query ? { query: { ...logical.query } } : {}),
      headers: { ...logical.headers },
    };
    const session = this.#sessions.get(ctx);
    // OAuth 2.1 access token 一律 Bearer(RFC 6750);其它风格属于自定义插件(injectAuthHeader)。
    if (session) injectAuthHeader(request, session.token.token, "bearer");
    return request;
  }

  async handleUnauthorized<State>(ctx: CommandContext<State>): Promise<UnauthorizedDecision> {
    const session = this.#sessions.get(ctx);
    if (!session?.token.refreshable) return { action: "decline" };

    const refreshed = await this.#options.refresh();
    if (!refreshed) {
      return {
        action: "reject",
        error: new AuthenticationError({
          subtype: "token_expired",
          code: 401,
          message: "Authentication expired (token refresh failed)",
          hint: "Please log in again",
        }),
      };
    }

    // L4: rebuild the full session token (access token, expiry, refresh token) from
    // the refreshed TokenInfo — previously only the access-token string was replaced,
    // leaving expiresAt/refreshToken stale and inconsistent with the persisted store.
    const nextToken: TokenResult = {
      ...session.token,
      token: refreshed.access_token,
      ...(typeof refreshed.expires_in === "number"
        ? { expiresAt: Date.now() + refreshed.expires_in * 1000 }
        : { expiresAt: undefined }),
      ...(refreshed.refresh_token ? { refreshToken: refreshed.refresh_token } : {}),
    };
    this.#sessions.set(ctx, { ...session, token: nextToken });
    return { action: "retry" };
  }

  #providerContext(credentialArgs?: Record<string, unknown>): ProviderContext {
    return {
      namespace: this.#options.namespace,
      configStore: this.#options.store,
      args: { apiKey: credentialArgs?.apiKey },
      env: process.env,
    };
  }

  #credentialsApi(): CredentialsApi {
    const store = this.#options.store;
    return {
      async get(namespace) {
        const credentials = await store.loadCredentials(namespace);
        if (!credentials) return null;
        const serialized: Record<string, string> = {};
        for (const [key, value] of Object.entries(credentials)) {
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            serialized[key] = String(value);
          }
        }
        return serialized;
      },
      save: (namespace, data) => store.saveCredentials(namespace, data),
      clear: (namespace) => store.clearCredentials(namespace),
    };
  }
}
