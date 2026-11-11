# Custom Authentication Plugins and Providers

Use this only when `defineAuth` cannot express the protocol, such as HMAC, mTLS, or composite signing. Custom auth relies on lower-level APIs, so pin the framework version and test provider priority, persistence, refresh, retry, and redaction.

## Contents

1. Auth plugin skeleton
2. Plugin-owned login commands
3. Provider chains
4. HMAC signing
5. 401 refresh behavior

## 1. Auth plugin skeleton

An auth plugin resolves a token in `beforeCommand`, stores it in a context-keyed `WeakMap`, injects it in `beforeRequest`, and may implement `handleUnauthorized` for one refresh and retry. Never keep one mutable token directly in a plugin closure: one plugin instance serves concurrent `App.run()` calls. The store comes from `setup(services)` — factories take no directory or state parameters:

```ts
import {
  AuthenticationError,
  createOAuthRefresh,
  defaultProviders,
  injectAuthHeader,
  resolveWithChain,
  type CommandContext,
  type OAuthClientConfig,
  type PluginFactory,
  type TokenResult,
} from "@renxqoo/agent-cli-sdk";

export function createCustomAuth<State>(options: {
  namespace: string;
  oauth: OAuthClientConfig;
}): PluginFactory<State> {
  return {
    name: `auth:${options.namespace}`,
    async setup({ localState }) {
      const store = localState.store;
      const providers = defaultProviders();
      const refresh = createOAuthRefresh({
        cfg: options.oauth,
        store,
        namespace: options.namespace,
      });
      const sessions = new WeakMap<CommandContext<State>, TokenResult>();
      return {
        name: `auth:${options.namespace}`,
        enforce: "pre",
        async beforeCommand(ctx) {
          const resolved = await resolveWithChain(providers, {
            namespace: options.namespace,
            configStore: store,
            args: {},
            env: process.env,
          });
          if (!resolved)
            throw new AuthenticationError({
              subtype: "no_credentials",
              message: "Sign in before running this command",
            });
          sessions.set(ctx, resolved.token);
        },
        async beforeRequest(ctx, request) {
          const prepared = { ...request, headers: { ...request.headers } };
          const session = sessions.get(ctx);
          if (session) injectAuthHeader(prepared, session.token, "bearer");
          return prepared;
        },
        async handleUnauthorized(ctx, event) {
          const session = sessions.get(ctx);
          if (!session?.refreshable || !session.sessionId) return { action: "decline" };
          const authorization = Object.entries(event.request.headers ?? {}).find(
            ([name]) => name.toLowerCase() === "authorization",
          )?.[1];
          if (!authorization?.startsWith("Bearer ")) return { action: "decline" };
          const token = await refresh({
            sessionId: session.sessionId,
            token: authorization.slice("Bearer ".length),
          });
          if (!token)
            return {
              action: "reject",
              error: new AuthenticationError({
                subtype: "token_expired",
                message: "Sign in again",
              }),
            };
          sessions.set(ctx, { ...session, token: token.access_token });
          return { action: "retry" };
        },
      };
    },
  };
}
```

`handleUnauthorized` returns an explicit `decline`, `retry`, or `reject` decision. The session is keyed by `CommandContext`, so concurrent invocations cannot overwrite one another. Standard OAuth/API-key/Bearer/Basic integrations should use `defineAuth`; it owns the same isolation and canonical output identity without exposing private runtime channels.

## 2. Plugin-owned login commands

A command contributed through `provides` skips that same plugin's `beforeCommand`. Therefore `ctx.credentials` is still the default no-op implementation. Plugin-owned login and logout commands must use the store captured during `setup` (`store` in the skeleton above):

```ts
const authCommands = defineCommands({
  login: defineCommand({
    name: "login",
    description: "Persist an API key from a controlled environment variable",
    async run() {
      const apiKey = process.env.MY_CLI_API_KEY;
      if (!apiKey) {
        throw new errs.ConfigError({
          subtype: "unbound_env",
          message: "MY_CLI_API_KEY is not set",
        });
      }
      await store.saveCredentials(options.namespace, { apiKey });
      return { data: { saved: true } };
    },
  }),
  logout: defineCommand({
    name: "logout",
    description: "Clear stored credentials",
    async run() {
      await store.clearCredentials(options.namespace);
      return { data: { cleared: true } };
    },
  }),
});
```

Never design long-lived secrets as `login --secret <value>`; command arguments may appear in history and process listings. Use a controlled environment variable or a genuinely masked prompt, and never return the secret.

## 3. Provider chains

`resolveWithChain` tries providers by ascending priority and stops at the first token. The default chain contains flag, API-key environment, Bearer environment, file, and OAuth providers.

The framework-global `--api-key` reaches `defineAuth` through an internal channel. The custom skeleton above sets `ProviderContext.args` to `{}` and therefore does not support that flag. Use environment, file, or a custom provider; do not advertise an unconnected flag.

A provider implements:

```ts
interface CredentialProvider {
  name(): string;
  priority?(): number;
  resolveToken(context: ProviderContext): Promise<TokenResult | null>;
}
```

Example:

```ts
class HmacProvider implements CredentialProvider {
  name() {
    return "hmac";
  }
  priority() {
    return 15;
  }
  async resolveToken(context: ProviderContext): Promise<TokenResult | null> {
    const credentials = await context.configStore.loadCredentials(context.namespace);
    if (!credentials?.accessKey || !credentials?.secretKey) return null;
    return {
      token: String(credentials.accessKey),
      type: "custom",
      source: "hmac",
    };
  }
}
```

Inside a provider, use `configStore.loadCredentials/saveCredentials`. In ordinary business commands, use `ctx.credentials` after `beforeCommand` initializes it.

## 4. HMAC signing

Sign in a post plugin after every other plugin finalizes method, path, body, and headers:

```ts
import { createHmac } from "node:crypto";

function hmacSigningPlugin(namespace: string): Plugin {
  return {
    name: "hmac-signing",
    enforce: "post",
    async beforeRequest(ctx, request) {
      const credentials = await ctx.credentials.get(namespace);
      if (!credentials?.secretKey) return { ...request, headers: { ...request.headers } };
      const body =
        typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? "");
      const signature = createHmac("sha256", credentials.secretKey)
        .update(`${request.method}\n${request.path}\n${body}`)
        .digest("hex");
      return { ...request, headers: { ...request.headers, "X-Signature": signature } };
    },
  };
}
```

Treat canonicalization, timestamp, nonce, encoding, and header order as protocol facts. Derive them from the service specification and test known vectors; never invent them.

## 5. 401 refresh behavior

With `handleUnauthorized` configured, the request runtime:

1. Receives 401 and runs the refresh hook.
2. Reuses one in-flight refresh for concurrent requests when the underlying hook supports singleflight.
3. Persists the refreshed token.
4. Applies the token, reruns all `beforeRequest` hooks, and retries once.
5. Throws `AuthenticationError(token_expired)` if refresh fails or the retry is still 401.

The plugin must update its context-bound session before retry hooks run. Re-signing plugins must recompute timestamps, nonces, and signatures on retry. Business commands should not implement a second 401 retry loop.
