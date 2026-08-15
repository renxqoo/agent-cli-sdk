import type { ConfigStore, StoredOAuthCredentials } from "../credentials/types.js";
import { CliError } from "../errs/index.js";
import type { TokenInfo } from "../oauth-contracts.js";

/** Context handed to a refresh strategy's acquire(). */
export interface RefreshContext {
  refreshToken?: string;
  /** Persisted granted scopes; client_credentials re-requests this exact envelope. */
  scopes?: string[];
}

export interface OAuthRefreshStrategy {
  type?: StoredOAuthCredentials["authMethod"];
  requiresRefreshToken?: boolean;
  acquire(ctx: RefreshContext): Promise<TokenInfo>;
}

export interface OAuthFlowCoordinatorOptions {
  store: ConfigStore;
  namespace: string;
  strategy?: OAuthRefreshStrategy;
  /** Concise default-refresh constructor used by the public OAuth façade. */
  refresh?: (refreshToken: string) => Promise<TokenInfo>;
}

/** Owns refresh singleflight and the refresh-to-persistence transaction. */
export class OAuthFlowCoordinator {
  readonly #store: ConfigStore;
  readonly #namespace: string;
  readonly #strategy: OAuthRefreshStrategy;
  readonly #inflight = new Map<string, Promise<TokenInfo | null>>();

  constructor(options: OAuthFlowCoordinatorOptions) {
    this.#store = options.store;
    this.#namespace = options.namespace;
    if (options.strategy) {
      this.#strategy = options.strategy;
      return;
    }
    if (!options.refresh) throw new TypeError("OAuthFlowCoordinator requires a refresh strategy");
    const refresh = options.refresh;
    this.#strategy = {
      requiresRefreshToken: true,
      acquire(ctx) {
        if (!ctx.refreshToken) throw new TypeError("refresh token is required");
        return refresh(ctx.refreshToken);
      },
    };
  }

  readonly refreshStoredSession = async (): Promise<TokenInfo | null> => {
    const current = (await this.#store.loadCredentials(
      this.#namespace,
    )) as Partial<StoredOAuthCredentials> | null;
    const refreshToken = current?.refreshToken || undefined;
    const requiresToken = this.#strategy.requiresRefreshToken ?? false;
    const authMethod = this.#strategy.type ?? current?.authMethod;
    if ((requiresToken && !refreshToken) || !authMethod) return null;

    const key = refreshToken ?? `${authMethod}:session`;
    const existing = this.#inflight.get(key);
    if (existing) return existing;

    const operation = this.#refreshAndPersist(refreshToken, authMethod).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, operation);
    return operation;
  };

  async #refreshAndPersist(
    refreshToken: string | undefined,
    authMethod: StoredOAuthCredentials["authMethod"],
  ): Promise<TokenInfo | null> {
    // B5: load → refresh → save is guarded by a cross-process lock so concurrent CLI
    // invocations cannot clobber each other's refreshed token.
    return this.#store.withLock(this.#namespace, async () => {
      // Authoritative re-load under the lock: another process may have refreshed first.
      const current = (await this.#store.loadCredentials(
        this.#namespace,
      )) as Partial<StoredOAuthCredentials> | null;
      const rt = current?.refreshToken || refreshToken;
      const scopes = Array.isArray(current?.scopes) ? current!.scopes : undefined;
      try {
        const token = await this.#strategy.acquire({ refreshToken: rt, scopes });
        const now = Date.now();
        const updated: StoredOAuthCredentials = {
          token: token.access_token,
          refreshToken: token.refresh_token ?? rt ?? "",
          ...(typeof token.expires_in === "number"
            ? { expiresAt: now + token.expires_in * 1000 }
            : {}),
          scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : (scopes ?? []),
          storedAt: now,
          authMethod,
          ...(current?.user ? { user: current.user } : {}),
        };
        await this.#store.saveCredentials(
          this.#namespace,
          updated as unknown as Record<string, unknown>,
        );
        return token;
      } catch (error) {
        // L5: retryable transport/decode failures propagate so the caller sees an
        // accurate retryable error instead of a generic "auth expired".
        if (
          error instanceof CliError &&
          (error.category === "network" || error.category === "internal")
        ) {
          throw error;
        }
        // Permanent auth/config failure (e.g. invalid_grant): clear the stale session
        // so the next call surfaces a clean "please log in" instead of a refresh loop.
        await this.#store.clearCredentials(this.#namespace).catch(() => undefined);
        return null;
      }
    });
  }
}
