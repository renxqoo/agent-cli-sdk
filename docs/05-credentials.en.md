# 05 · Credentials & Authentication (auth is a Plugin)

> Use `defineAuth` for standard OAuth, Bearer, API key, and Basic authentication. Write a Plugin by hand only for HMAC, mTLS, or composite protocols; a custom implementation must isolate sessions by `CommandContext` and decide retries through an explicit `handleUnauthorized`.

---

## The Two Layers of Authentication

| Layer                                | What it does                                            | Who is responsible                                       |
| ------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------- |
| **Getting the token** (credentials)  | Where the key/token comes from (flag/env/file/keychain) | provider chain (the auth Plugin calls `resolveWithChain`) |
| **Using the token** (injection)      | Putting the token into request headers (bearer/api-key) | the auth Plugin's `beforeRequest` calls `injectAuthHeader` |

**Both layers are orchestrated by the auth Plugin.** For standard scenarios `defineAuth` creates a complete plugin; for special protocols you can compose the building blocks below yourself. The plugin resolves credentials through `beforeCommand`, returns a new request through `beforeRequest`, and isolates concurrent requests with a context-keyed session.

---

## Building Blocks Provided by agent-cli-sdk

Import from the main package `@renxqoo/agent-cli-sdk`, no subpath needed:

| Building block                                                                                                                                               | What it does                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `createLocalState({ dir })` / `createMemoryLocalState()`                                                                                                     | the app's unified local state (including `ConfigStore`)                                        |
| `defaultProviders()` / `flagProvider` / `envProvider` / `envBearerProvider` / `fileProvider` / `oauthProvider`                                               | the provider chain's default providers (5 by default)                                          |
| `resolveWithChain(providers, pctx)`                                                                                                                          | runs the chain to get a `TokenResult` (stops on first hit)                                     |
| `resolveIdentityWithChain(providers, pctx)`                                                                                                                  | runs the chain to get an `IdentityHint` (unified top-level user/bot output format)             |
| `injectAuthHeader(req, token, style)`                                                                                                                        | injects the header per authStyle (`bearer`/`x-api-key`/`basic`)                                |
| `createOn401Hook({cfg, store, namespace})`                                                                                                                   | the 401 singleflight refresh primitive (called by the public `handleUnauthorized` hook)        |
| `deviceAuthorization` / `pollDeviceToken` / `getUserInfo` / `revokeToken` / `registerClient`                                                                 | OAuth 2.1 endpoint primitives (device authorization + user info/revoke/register)               |
| Types: `Plugin` / `CredentialsApi` / `CommandContext` / `ProviderContext` / `TokenResult` / `IdentityHint` / `ConfigStore` / `CredentialProvider` / `AuthStyle` | —                                                                                              |

**Prefer `defineAuth`.** The building blocks below are for HMAC, mTLS, composite authentication, or custom providers — don't reinvent the wheel for ordinary OAuth scenarios.

---

## How to Write an auth Plugin

See `createCrmAuth` in `apps/crm/src/auth.ts` for a reference implementation. Below is the skeleton (see "How to write an auth Plugin" in `02-sdk-guide.md` for the complete runnable version):

```ts
import {
  type Plugin,
  type CommandContext,
  type ProviderContext,
  type ConfigStore,
  defaultProviders,
  resolveWithChain,
  injectAuthHeader,
  createOn401Hook,
  AuthenticationError,
} from "@renxqoo/agent-cli-sdk";

export function createCrmAuth<State extends { user?: unknown }>(opts: {
  namespace: string;
  authStyle?: "bearer" | "x-api-key" | "basic";
  oauth?: { baseUrl: string; clientId: string; clientSecret: string };
}): Plugin<State> {
  const authStyle = opts.authStyle ?? "bearer";
  const sessions = new WeakMap<CommandContext<State>, { token: string; refreshable: boolean }>();

  // Assembly-time state: filled in apply after resolving from services.localState.store (the factory takes no dir/store parameter).
  let ready!: {
    store: ConfigStore;
    providers: ReturnType<typeof defaultProviders>;
    on401?: () => Promise<Record<string, unknown> | null>;
  };

  return {
    name: `auth:${opts.namespace}`,
    enforce: "pre",

    async apply(services) {
      const store = services.localState.store;
      ready = {
        store,
        providers: defaultProviders(),
        on401: opts.oauth
          ? createOn401Hook({ cfg: opts.oauth, store, namespace: opts.namespace })
          : undefined,
      };
    },

    async beforeCommand(ctx: CommandContext<State>) {
      const { store, providers } = ready;
      const pctx: ProviderContext = {
        namespace: opts.namespace,
        configStore: store,
        args: {},
        env: process.env,
      };
      const resolved = await resolveWithChain(providers, pctx); // ① provider chain gets the token
      if (!resolved)
        throw new AuthenticationError({
          subtype: "no_credentials",
          message: "No credentials configured",
          hint: "Set the XXX_API_KEY environment variable",
        });
      // ② wrap store into ctx.credentials; ③ inject scopes; ④ fetch identity into state.user
      // ⑤ cache the token for beforeRequest
      sessions.set(ctx, {
        token: resolved.token.token,
        refreshable: resolved.token.refreshable === true,
      });
    },

    async beforeRequest(ctx, req) {
      const prepared = { ...req, headers: { ...req.headers } };
      const session = sessions.get(ctx);
      if (session) injectAuthHeader(prepared, session.token, authStyle);
      return prepared;
    },

    async handleUnauthorized(ctx) {
      const session = sessions.get(ctx);
      if (!ready.on401 || !session?.refreshable) return { action: "decline" };
      const token = await ready.on401();
      if (!token)
        return {
          action: "reject",
          error: new AuthenticationError({ subtype: "token_expired", message: "refresh failed" }),
        };
      sessions.set(ctx, { ...session, token });
      return { action: "retry" };
    },
  };
}
```

**The three hooks' responsibilities:**

| Hook                 | What it does in the auth Plugin                                                             |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `beforeCommand`      | runs the provider chain to get the token; wraps `store` into `ctx.credentials`; establishes a context-keyed session |
| `beforeRequest`      | injects the header by authStyle with `injectAuthHeader(req, token, authStyle)`              |
| `handleUnauthorized` | calls `createOn401Hook(...)`; on success updates the session and returns `{ action: "retry" }` |

**Key disciplines:**

- Use the two standard hooks `beforeCommand` + `beforeRequest` for authentication; don't invent new mechanisms.
- Isolate tokens with context-keyed structures such as `WeakMap<CommandContext, Session>` to avoid crosstalk between concurrent commands.
- 401 refresh is a request-layer (framework) capability, but the **execution capability** (how to refresh, how to persist) is provided by the auth Plugin via `on401`. An auth Plugin without an `on401` doesn't support automatic 401 renewal.
- A business package can write its own auth Plugin without any reference to the `createCrmAuth` skeleton — as long as it honors the `Plugin` interface and the contract above.

For the fully annotated version (with credentials wrapping, scopes, identity), see the "How to write an auth Plugin" section of `02-sdk-guide.md` and `apps/crm/src/auth.ts`.

---

## The Internals of the provider chain

> This section explains how `resolveWithChain` fetches the token internally. **Business packages usually only need `defaultProviders()` when writing an auth Plugin** — you only need to understand the provider interface and add your own provider when you want custom authentication (HMAC/mTLS, etc.).

### Chain Design: Try Providers in Order of priority

```
resolveWithChain(providers, pctx) calls each provider in ascending priority:
  provider[0] (priority=1, flag)       → hit? use its token
  provider[1] (priority=5, env api-key) → hit? use it
  provider[2] (priority=6, env bearer) → hit? use it
  provider[3] (priority=10, file)      → hit? use it
  provider[4] (priority=20, oauth)     → hit? use it
  none hit → return null (the auth Plugin throws AuthenticationError accordingly, triggering first-run onboarding)
```

**Stop on first hit**: once a provider returns a valid token, subsequent providers are not called. Lower priority values are tried first (aligned with lark-cli: lower first, default 10).

### Default Providers (`defaultProviders()` ships 5)

`defaultProviders()` returns these 5:

| Provider            | priority | Where it comes from                                      | Use case                          |
| ------------------- | :------: | -------------------------------------------------------- | --------------------------------- |
| `flagProvider`      |    1     | `--api-key <key>` global flag                            | temporary override (single command) |
| `envProvider`       |    5     | `$<NS>_API_KEY` env var (`NS` = uppercased namespace)    | CI/containers                     |
| `envBearerProvider` |    6     | `$<NS>_BEARER_TOKEN` env var                             | pre-issued JWT / sandbox          |
| `fileProvider`      |    10    | the `apiKey` field of `~/.rxcli/credentials/<ns>.json`   | persistence (default main path)   |
| `oauthProvider`     |    20    | the OAuth token (with refresh) of `~/.rxcli/credentials/<ns>.json` | OAuth flow (the rxcli middle layer) |

> Business packages usually don't need to care about these — `defaultProviders()` installs these 5 by default. Only when you want custom authentication do you write your own `providers = [...defaultProviders(), customProvider]` (note: priority determines the insertion position).

### The Provider Interface (for custom authentication)

```ts
export interface CredentialProvider {
  name(): string; // provider name (logging/tracing)
  priority?(): number; // priority; lower values tried first, default 10
  resolveToken(pctx: ProviderContext): Promise<TokenResult | null>; // null = none, the chain continues
  resolveIdentity?(pctx: ProviderContext): Promise<IdentityHint | null>;
}

export interface ProviderContext {
  namespace: string; // namespace
  configStore: ConfigStore; // agent-cli-sdk's config storage (reads/writes files directly, not via the chain)
  args: Record<string, unknown>; // command args (reads --api-key, etc.)
  env: NodeJS.ProcessEnv; // environment variables
}

export interface TokenResult {
  token: string;
  type: "api-key" | "bearer" | "basic" | "custom";
  scopes?: string[];
  source: string; // source description (e.g. 'env:ORDERS_API_KEY')
  expiresAt?: number; // expiration timestamp (ms)
  refreshToken?: string; // OAuth refresh token
}
```

> **Note**: the provider's argument is `ProviderContext` (named `pctx`), not the command's `CommandContext`. It has `configStore` (direct file read/write) for the provider to fetch credentials internally.

### Custom Provider Example (HMAC)

```ts
// src/hmac-provider.ts
export class HmacProvider implements CredentialProvider {
  constructor(private opts: { namespace: string }) {}
  name() {
    return "hmac";
  }
  priority() {
    return 15;
  } // after file (10), before oauth (20)

  async resolveToken(pctx: ProviderContext): Promise<TokenResult | null> {
    const creds = await pctx.configStore.loadCredentials(this.opts.namespace);
    if (!creds?.accessKey || !creds?.secretKey) return null; // none, the chain continues
    return { token: creds.accessKey, type: "custom", source: "config:hmac" };
  }
}
```

When using it, put it into the auth Plugin's providers (change it in `createCrmAuth` to `providers = [...defaultProviders(), new HmacProvider(...)]`):

```ts
// inside the auth Plugin factory (simplified)
const providers = [...defaultProviders(), new HmacProvider({ namespace: opts.namespace })];
const resolved = await resolveWithChain(providers, pctx);
```

If HMAC also needs to compute a signature and put it in a header, add it in the auth Plugin's `beforeRequest`, or write a separate signing plugin (enforce: 'post', sign after all headers are added):

```ts
const signPlugin = {
  name: "hmac-sign",
  enforce: "post",
  async beforeRequest(ctx, req) {
    const creds = await ctx.credentials.get("orders");
    return {
      ...req,
      headers: { ...req.headers, "X-Signature": hmacSign(req.body, creds.secretKey) },
    };
  },
};

defineCli({ plugins: [auth, signPlugin], ... })
```

> **Key distinction**: the auth Plugin handles "getting the token + injecting the auth header" (standard authentication); the signing plugin handles "non-standard signing" (HMAC/mTLS). The two cooperate without conflict.

---

## The Relationship Between the provider chain and Plugins

| Extension type                                              | Mechanism                                   | Entry point                              |
| ----------------------------------------------------------- | ------------------------------------------- | ---------------------------------------- |
| **Authentication** (get token, inject header, fill user)   | `defineAuth`; special protocols use the provider chain | put the returned Plugin into `plugins` |
| **Non-auth cross-cutting** (fixed args, signing, formatting, errors, audit) | ordinary plugin hooks               | write a Plugin object and put it into `plugins` |

**The provider chain is provided by agent-cli-sdk's `resolveWithChain`/`resolveIdentityWithChain`**; business packages do not call `credentials.register()` directly (removed). All authentication goes through a self-written auth Plugin (which calls the provider chain); non-auth cross-cutting uses ordinary plugins and does not go through the provider chain.

---

## Credential Storage

The app decides the root directory exactly once via `defineCliApp({ dir })`. The assembler creates a single localState and injects it into every plugin; the ConfigStore inside it centrally manages config and credentials, and update notifications use a deletable cache under the same root directory:

```
<dir>/
├── config/
│   ├── orders.json                     ← orders' app config (registers clientId, etc.)
│   └── invoices.json                   ← isolated by namespace, never overwrite each other
├── credentials/
│   ├── orders.json                     ← orders' credentials (determined by namespace)
│   └── invoices.json
└── cache/
    └── updates/                        version-check cache
```

**Config and credentials are both isolated by business-package namespace** (the auth Plugin's `credentialNamespace`), with permission `0600`. When multiple CLI apps share one root directory, their registered configs don't overwrite each other.

> **Security contract**:
> - Credentials and config are stored **in plaintext at-rest**, protected only by filesystem permissions (no obfuscation/encryption). If you need at-rest encryption, keep them in an external store such as the OS keychain.
> - `0600` (files) / `0700` (directories) only take effect on **POSIX**; Windows doesn't support chmod, and file ACLs inherit from the parent directory.
> - The storage directory is decided exactly once by the business app via `defineCliApp({ dir })`; `defineAuth`, `createUpdateNotifier`, and `defineInstaller` receive the same localState through `apply(services)`. agent-cli-sdk **does not ship a default directory**, and the high-level APIs never accept a directory parameter.
> - Credential/config file reads go through the same **strict bounded parser** as command input (rejects duplicate keys and unsafe keys, limits depth/size).
> - The OAuth refresh "read → exchange token → write" transaction is protected by a **cross-process file lock** (`ConfigStore.withLock`), avoiding lost updates when concurrent CLIs overwrite each other.

### Credential File Structure

```json
{
  "apiKey": "sk_xxx",
  "token": "ey...",
  "refreshToken": "ry...",
  "expiresAt": 1735689600000,
  "scopes": ["orders:read", "orders:write"],
  "user": { "openId": "u_1", "name": "alice" },
  "storedAt": 1735686000000,
  "authMethod": "oauth"
}
```

All fields are optional — OAuth uses `token`/`refreshToken`/`expiresAt`, API key uses `apiKey`, HMAC uses custom fields (`accessKey`/`secretKey`). agent-cli-sdk does not impose a structure.

### Reading/Writing Credentials at Runtime in a Business Package

In `run(ctx, args)`, the business package reads/writes via `ctx.credentials` (the auth Plugin wraps store into this API in beforeCommand):

```ts
// read (prefers the provider chain, returns on hit; returns null if none hit)
const creds = await ctx.credentials.get("orders");

// write (after a successful login, bypass the chain and persist directly)
await ctx.credentials.save("orders", {
  token: "...",
  refreshToken: "...",
  expiresAt: Date.now() + 3600000,
});

// clear (logout)
await ctx.credentials.clear("orders");
```

> **Note the two distinct layers**: `ctx.credentials.*` is used at command runtime (goes through the provider chain); the provider internally uses `ProviderContext.configStore` (direct file read/write, not via the chain). The former is the user-facing API for business packages, the latter is the API for provider implementers.

### The ConfigStore Interface (for provider implementers)

`ProviderContext.configStore` is agent-cli-sdk's config/credential storage abstraction, reading/writing disk files directly (not via the provider chain). Interface:

```ts
export interface ConfigStore {
  loadCredentials(namespace: string): Promise<Record<string, unknown> | null>; // null = file doesn't exist
  saveCredentials(namespace: string, data: Record<string, unknown>): Promise<void>; // permission 0600
  clearCredentials(namespace: string): Promise<void>;
  loadConfig(namespace: string): Promise<Record<string, unknown>>; // <dir>/config/<ns>.json, missing = {}
  saveConfig(namespace: string, data: Record<string, unknown>): Promise<void>; // full replacement, permission 0600
  withLock<T>(namespace: string, fn: () => Promise<T>): Promise<T>; // credential read-modify-write transaction lock
}
```

**Side-by-side comparison of the two API layers (method names are intentionally different to avoid mixing them up):**

| Layer              | API                                               | Where it's used                              | Goes through the chain?                     |
| ------------------ | ------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| business runtime   | `ctx.credentials.get/save/clear`                  | inside command `run`, signing plugins        | ✅ goes through the provider chain (get returns on hit) |
| provider implementer | `configStore.loadCredentials/saveCredentials/...` | inside `CredentialProvider`, first-run onboarding | ❌ reads files directly                  |

> Provider implementers use `configStore.loadCredentials`; business packages/commands use `ctx.credentials.get`. The two have different semantics (one reads directly, one goes through the chain); the method-name styles keep them apart to avoid misuse.

---

## First-Run Onboarding

When the provider chain misses entirely, the auth Plugin throws `AuthenticationError`, and agent-cli-sdk triggers first-run onboarding (only on an interactive TTY; CI/non-interactive environments error out directly):

```bash
$ rxcli-orders list
⚠ orders requires credentials (stored to ~/.rxcli/credentials/orders.json, permission 0600)
  API Key: ********
  Secret Key: ********
✓ Credentials saved
{ "ok": true, "data": [...] }
```

The onboarding copy can be injected by the business package (via defineCli's `messages.credentialsPrompt`). Non-interactive environments (agent scenarios) don't onboard; they return an error output + hint directly:

```json
{
  "ok": false,
  "error": {
    "type": "authentication",
    "subtype": "no_credentials",
    "message": "orders business package has no credentials configured",
    "hint": "run `rxcli-orders config set apiKey <your-key>` to configure the API key"
  }
}
```

---

## Credential Redaction (Logging Discipline)

Credential values must **never** appear in visible stdout/stderr output. agent-cli-sdk enforces:

- When `ctx.log` prints a request, the auth header is redacted automatically: `Authorization: Bearer ey...` → `Authorization: Bearer [REDACTED]`
- If credentials leak into error messages, the `handleError` plugin must redact them (see `04-errors.md`)
- When `verbose` mode prints request details, auth fields are placeholder-ed with `[REDACTED]`

```bash
$ rxcli-orders list --verbose 2>&1 | grep -i auth
> Auth: Bearer [REDACTED]     # ← you never see the real token
```

> Note: this framework doesn't implement a full field-level redaction feature (decision list #14), but **log redaction of credentials themselves is a baseline**, enforced since the first version.

---

## Design Highlights of the Credential System

| Traditional approach                        | This framework                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loadCredentials()` reads a fixed file      | `ctx.credentials.get(namespace)` reads by namespace (goes through the provider chain)                                                                              |
| fixed priority chain                        | `resolveWithChain` + `defaultProviders()` (5 providers by default)                                                                                                 |
| hardcoded OAuth token renewal               | 401 detection + singleflight reuse at the framework's **request layer**; refresh execution is provided by the auth Plugin's `createOn401Hook`. The two cooperate (see "About 401 automatic renewal" in `04-errors.md`) |
| single middle-layer baseUrl                 | each business package declares its own baseUrl (defineCli config); ConfigStore only manages credentials                                                            |
| fixed auth implementation                   | `defineAuth` covers standard scenarios; special protocols extend via public Plugins and building blocks                                                             |

---

## Integration Guide for Common Auth Methods

| Auth method                    | How to write the auth Plugin                                                              | What the business package does              |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| OAuth (rxcli middle layer)     | `defineAuth`; when customizing, use a context-keyed session + the public `handleUnauthorized` | prefer the framework factory               |
| Bearer token                   | same as above (drop on401)                                                                | same                                        |
| API key (`X-Api-Key` header)   | authStyle `'x-api-key'`                                                                   | same; covered by default providers          |
| Basic Auth                     | authStyle `'basic'`                                                                       | provider stores user/pass                   |
| HMAC signing                   | the auth Plugin uses a custom `HmacProvider` to get the token; write signing as a separate enforce: 'post' plugin | implement HmacProvider + signing logic |
| mTLS                           | custom provider (reads the cert path) + beforeRequest injects the cert                    | implement cert loading                      |

### authStyle Configuration

API key and Bearer are both supported by the default providers; the difference is which header they go into. authStyle is passed to `injectAuthHeader(req, token, style)`:

```ts
injectAuthHeader(req, token, "bearer"); // → Authorization: Bearer xxx (default)
injectAuthHeader(req, token, "x-api-key"); // → X-Api-Key: xxx
injectAuthHeader(req, token, "basic"); // → Authorization: Basic base64(user:pass)
```

authStyle is passed in via opts in the auth Plugin factory (e.g. `createCrmAuth({ authStyle: 'bearer' })`).
