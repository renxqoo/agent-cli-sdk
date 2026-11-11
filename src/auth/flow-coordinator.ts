import type { ConfigStore, OAuthSessionRef, StoredOAuthCredentials } from "../credentials/types.js";
import { oauthSessionId } from "../credentials/oauth-session.js";
import { AuthenticationError } from "../errs/index.js";
import type { TokenInfo } from "../oauth-contracts.js";

export interface RefreshContext {
  refreshToken?: string;
  scopes?: string[];
}

export interface OAuthRefreshStrategy {
  type?: StoredOAuthCredentials["authMethod"];
  requiresRefreshToken?: boolean;
  acquire(context: RefreshContext): Promise<TokenInfo>;
}

export interface OAuthFlowCoordinatorOptions {
  store: ConfigStore;
  namespace: string;
  strategy: OAuthRefreshStrategy;
}

/** Refreshes only the session that authenticated the rejected request. */
export class OAuthFlowCoordinator {
  readonly #options: OAuthFlowCoordinatorOptions;
  readonly #inflight = new Map<string, Promise<TokenInfo | null>>();

  constructor(options: OAuthFlowCoordinatorOptions) {
    this.#options = options;
  }

  readonly refreshSession = (expected: OAuthSessionRef): Promise<TokenInfo | null> => {
    const key = JSON.stringify([expected.sessionId, expected.token]);
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const operation = this.#refresh(expected).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, operation);
    return operation;
  };

  #refresh(expected: OAuthSessionRef): Promise<TokenInfo | null> {
    const { store, namespace, strategy } = this.#options;
    return store.transactCredentials(namespace, async (transaction) => {
      const document = transaction.read();
      if (!document || oauthSessionId(document) !== expected.sessionId) return null;
      const current = document as unknown as StoredOAuthCredentials;
      if (typeof current.token !== "string" || !current.authMethod) return null;
      if (current.token !== expected.token) {
        return {
          access_token: current.token,
          ...(current.refreshToken ? { refresh_token: current.refreshToken } : {}),
          ...(current.expiresAt === undefined
            ? {}
            : { expires_in: Math.max(0, (current.expiresAt - Date.now()) / 1000) }),
          scope: current.scopes?.join(" "),
        };
      }
      if (strategy.requiresRefreshToken && !current.refreshToken) return null;
      let token: TokenInfo;
      try {
        token = await strategy.acquire({
          refreshToken: current.refreshToken,
          scopes: current.scopes,
        });
      } catch (error) {
        if (error instanceof AuthenticationError && !error.retryable) {
          transaction.clear();
          return null;
        }
        throw error;
      }
      const now = Date.now();
      const updated: StoredOAuthCredentials = {
        sessionId: expected.sessionId,
        token: token.access_token,
        refreshToken: token.refresh_token ?? current.refreshToken ?? "",
        ...(typeof token.expires_in === "number"
          ? { expiresAt: now + token.expires_in * 1000 }
          : {}),
        scopes:
          token.scope === undefined
            ? (current.scopes ?? [])
            : token.scope.split(/\s+/).filter(Boolean),
        storedAt: now,
        authMethod: strategy.type ?? current.authMethod,
        ...(current.user ? { user: current.user } : {}),
      };
      transaction.write(updated as unknown as Record<string, unknown>);
      return token;
    });
  }
}
