# 02 · SDK Development Guide

> For **business-package developers**. Explains how to use `@renxqoo/agent-cli-sdk` to write a business package: directory structure, ctx, commands, plugins, auth, pagination, testing. This is the document developers reach for most often.

---

## Quick start: a minimal business package

### 1. Create the project

```bash
mkdir rxcli-orders && cd rxcli-orders
pnpm init
pnpm add @renxqoo/agent-cli-sdk
```

### 2. Directory structure

```
rxcli-orders/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          ← entry: defineCli assembly (plugins + commands)
│   └── commands/
│       ├── orders.ts     ← command group (can split into multiple files)
│       └── invoices.ts
└── skills/
    └── orders/
        └── SKILL.md      ← teaches the agent how to use it (command table auto-generated)
```

> Note: there is no `client.ts`. agent-cli-sdk removes the client concept; request methods hang directly on `ctx`. For standard OAuth, Bearer, API key, and Basic auth, prefer `defineAuth`; only special protocols like HMAC and mTLS require a hand-written Plugin.

### 3. package.json

```jsonc
{
  "name": "@org/rxcli-orders",
  "version": "1.0.0",
  "type": "module",
  "bin": { "rxcli-orders": "./dist/index.js" }, // standalone bin
  "main": "./dist/index.js",
  "files": ["dist", "skills"], // ship skills with the package
  "scripts": {
    "build": "tsc",
    "test": "vitest",
  },
  "dependencies": { "@renxqoo/agent-cli-sdk": "^1.2.0" },
}
```

`@renxqoo/agent-cli-sdk` ships ESM only. Business packages must use `"type": "module"` and ESM `import`; CommonJS `require()` is not supported.

### 4. Entry point src/index.ts

```ts
#!/usr/bin/env node
import { defineCliApp, defineAuth } from "@renxqoo/agent-cli-sdk";
import { ordersCommands } from "./commands/orders.js";
import { homedir } from "node:os";
import { join } from "node:path";

type OrdersState = {
  user: { userId: string } | null;
};

export default await defineCliApp<OrdersState>({
  name: "orders",
  description: "Query and manage orders",
  dir: join(homedir(), ".orders"), // the only directory decision
  plugins: [
    defineAuth({
      credentialNamespace: "orders", // → config/orders.json + credentials/orders.json
      baseUrl: "https://auth.example.com",
      scope: "orders.read offline_access",
    }),
  ],
  commands: ordersCommands,
  skillsDir: "./skills",
});
```

> `defineAuth` is a synchronous factory that returns an ordinary `Plugin` and automatically contributes the login/status/logout/register commands; `defineCliApp` runs each plugin's `apply(services)` before route compilation to complete assembly. For special protocols, hand-write a Plugin using the public building blocks — provider chain, context-keyed session, and `handleUnauthorized`; see `05-credentials.md`.

**That's it.** The rest goes block by block through `ctx`, `defineCommand`, the plugin system, and auth.

---

## Programming style: function, not class

agent-cli-sdk uses a **function style + config-object declaration** (decision list #3). Reasons:

- **Composition > inheritance**: framework scenarios need composition (pipelines), tree-shaking (publishing to npm), and testability (mock arguments). Class inheritance is inferior to functions on all three fronts.
- **Dependency injection rather than implicit this**: the command `run(ctx, args)` obtains framework-injected capabilities (`ctx.get`, `ctx.log`, etc.) through `ctx`, instead of relying on the implicit `this` of a class inheritance chain. The agent reads the code without ambiguity.

Comparison:

```ts
// ❌ class style (not used): tight coupling, implicit this, hard to compose
class Orders extends Client {
  async list() { return this.request(...) }   // where does this come from? tests have to mock the whole inheritance chain?
}

// ✅ function style (adopted): run gets capabilities via ctx; pure function, easy to test
async run(ctx, args) {
  const res = await ctx.get('/orders', args)        // ctx.get hangs directly on ctx
  return { data: res.data.items }                   // return data; the framework handles serialization
}
```

**Two ways to write functions**: call `ctx.get` directly inside a command's `run` (injected); if you extract the "call the backend" logic into a standalone pure function (for reuse in unit tests), pass a requester-capable object explicitly:

```ts
// extract into a standalone function: pass the requester object explicitly; pure function, testable without ctx
async function listOrders(requester: { get: (...)=>... }, params: Record<string, unknown>) {
  const res = await requester.get('/orders', params)
  return res.data.items
}

// call it inside run (pass ctx in — ctx already has a get method)
async run(ctx, args) {
  const items = await listOrders(ctx, args)   // ctx has get, pass it directly
  return { data: items }
}
```

**Convention: simple commands use `ctx.get` directly; complex or reusable logic is extracted into a standalone function and `ctx` (or a requester-capable object) is passed explicitly.** Both are function style. There is no class inheritance, and no client object.

---

## TS typing conventions (pin constraints with types)

agent-cli-sdk uses the TS type system to enforce structural constraints. The table below distinguishes "what TS can pin down" from "what TS can't and needs a runtime check":

| Constraint                                          | How it's pinned                                              | TS or runtime                    |
| --------------------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| `name`/`description`/`run` required                 | required CommandSpec fields                                  | TS compile error                 |
| `args.type` only 4 kinds                            | ArgType union literal                                        | TS                               |
| `args` strongly typed after parsing                 | ParsedArgs inference **or** explicit interface declaration   | TS                               |
| `ctx.state` strongly typed (prevents stuffing)      | `defineCli<State>` generic; accessing undeclared fields errors | TS                             |
| `commands`/`namespaces` type separation             | top-level commands vs sub-namespace groups use separate fields, no union-type ambiguity | TS                   |
| `ctx.get<T>()` response type                        | request generic (optional)                                   | TS                               |
| `transformOutput` must not return string            | return StructuredData                                        | TS                               |
| `run` output data                                   | return CommandResult                                         | TS (missing return → runtime warning) |
| forbid console.log to stdout                        | —                                                            | runtime/lint (TS can't enforce)  |

### Three generics: command `<Args, Result>` + package-level `<State>`

This is the core of the typing conventions. **A command declares both its argument type and its return type clearly** (similar to how axios declares request/response types); **the state type is declared once at the package level**:

```ts
// define the package types first
interface OrdersState {
  user: { userId: string } | null
}

interface OrderListArgs {
  limit?: number
  status?: 'paid' | 'unpaid' | 'shipped'   // union literal; spec cannot infer it
}

interface OrderItem { id: string; total: number; status: string }
interface OrderListPayload { items: OrderItem[]; hasMore: boolean; nextCursor?: string }

// command: <Args, Result> (State is declared in defineCli)
// Result is the type of the data field run returns. list puts an array in data → Result = OrderItem[]
list: defineCommand<OrderListArgs, OrderItem[]>({
  name: 'list',
  description: 'List orders',
  args: { limit: { type: 'number', default: 30 }, status: { type: 'string' } },
  async run(ctx, args) {
    // args: OrderListArgs (strongly typed, autocompleted; args.foo errors)
    // ctx.state.user: { userId } | null (inferred from defineCli<State>)
    const res = await ctx.get<OrderListPayload>('/orders', args)   // the generic is the response body type
    return {
      data: res.data.items,                                         // ← data holds an array (OrderItem[])
      meta: { pagination: { complete: !res.data.hasMore, nextToken: res.data.nextCursor } },
    }
  },
})

// package: <State> (declares the shape of ctx.state)
defineCli<OrdersState>({ ... })
```

| Type     | Declared at                                  | Responsibility                                        |
| -------- | -------------------------------------------- | ----------------------------------------------------- |
| `State`  | `defineCli<State>`                           | the type of `ctx.state`, package-level (shared by all commands) |
| `Args`   | Zod output of `args.schema`                  | the sole type source for `args` in `run(ctx, args)`   |
| `Result` | inferred automatically from the `{ data }` returned by `run` | the command output type                  |

**One entry point, one type source.** `defineCommand({...})` infers and validates parameters only from the Zod object in `args.schema`; it does not accept a hand-written `Args` generic override, and there is no adapter or second schema.

### args: Zod parameter spec

```ts
type CommandArgs =
  | { type?: "argv"; schema: ZodObject; pos?: string[] }
  | { type: "json"; schema: ZodObject; pos?: never };
```

- Omit `args`: no business parameters; `run` receives `{}`.
- Omit `type`: defaults to `argv`; `pos` lists, in order, the positional-parameter fields that can only be passed bare, and does not also accept a same-named long flag; the remaining fields map to kebab-case long flags.
- `type: "json"`: the entire argument object comes from one JSON document; mixing in business flags or positional parameters is not allowed.
- required, default, enum, coerce, refine, descriptions, and type inference all use Zod's standard capabilities directly.

### CommandSpec: required command structure

```ts
interface CommandSpec<Args, Result = unknown, State = unknown> {
  name: string; // required; missing it is a compile error
  description: string; // required
  args?: CommandArgs;
  policy?: CommandPolicy<Args, State>;
  run: (ctx: CommandContext<State>, args: Args) => Promise<CommandResult<Result> | void>;
}
```

### CommandResult + StructuredData

```ts
interface CommandResult<T = unknown> {
  data: T; // structured data
  meta?: Meta; // optional (pagination, etc.)
}
// run returns CommandResult or void (pure side-effect command)

type StructuredData = Record<string, unknown> | unknown[] | null;
// transformOutput returns StructuredData; a string doesn't match → compile error
// note: don't use object (object is too wide under strict mode; it can't block string)
```

### The defineCli generic: the strong-type source for ctx.state

```ts
const ordersCommands = defineCommands<OrdersState>({
  list: defineCommand({
    name: "list",
    description: "List orders",
    args: {},
    async run(ctx, _args) {
      return { data: { userId: ctx.state.user?.userId } };
    },
  }),
});

defineCli<OrdersState>({ commands: ordersCommands, ... });
```

Componentized command groups use `defineCommands<State>({...})` to obtain the context type; individually exported commands can use `defineCommand<Args, Result, State>`. When State is not declared it is `unknown`, so arbitrary fields cannot be silently accessed; command groups with incompatible state also cannot be attached to `defineCli<State>`.

---

## ctx: requests and context

`ctx` is the context agent-cli-sdk injects into every `run(ctx, args)`. **Request methods hang directly on ctx (no client layer); auth is handled by the auth plugin + agent-cli-sdk internals, invisible to the business package.**

```ts
interface CommandContext<State = {}> {
  // —— request methods (hang directly on ctx, no client layer) ——
  // T is the response body type, optional (without it, data is unknown)
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<TransportResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<TransportResponse<T>>;
  put<T = unknown>(path: string, body?: unknown): Promise<TransportResponse<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<TransportResponse<T>>;
  delete<T = unknown>(path: string): Promise<TransportResponse<T>>;
  request<T = unknown>(opts: RequestOptions): Promise<TransportResponse<T>>; // low-level fallback

  // —— state: data shared between plugins, strongly typed (declared in defineCli<State>) ——
  state: State;

  // —— logging: forced to stderr (never pollutes stdout/pipeline) ——
  log: { info(msg: unknown): void; warn(msg: unknown): void; error(msg: unknown): void };

  // —— pipe: as a downstream, read upstream records ——
  pipe: { in(): AsyncIterable<PipeRecord>; isInPipe(): boolean };

  // —— credentials (runtime read/write; see 05-credentials.md) ——
  credentials: {
    get(namespace: string): Promise<Record<string, string> | null>;
    save(namespace: string, creds: Record<string, unknown>): Promise<void>;
    clear(namespace: string): Promise<void>;
  };

  // —— auth state ——
  auth: { status(): AuthStatus; requireScope(scope: string): void };
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
}

interface TransportResponse<T> {
  status: number;
  data: T; // T defaults to unknown
  headers: Record<string, string>;
}
```

### Request generics (optional, axios-style)

The `T` in `ctx.get<T>()` is the response body type. **Either way works**:

- **Specified**: `res.data` is the type you declared — autocompleted, typos error
- **Omitted**: degrades to `unknown`; the business package asserts on its own

```ts
// specify the generic: res.data is strongly typed
const res = await ctx.get<OrderListResult>("/orders", { limit: 30 });
res.data.items; // ✅ autocompleted

// no generic: res.data is unknown
const res = await ctx.get("/orders", { limit: 30 });
res.data; // unknown
```

**The generic is purely an enhancement, not required.**

### Auth: handled by the auth plugin + the agent-cli-sdk request layer

The business package **does not touch** auth details (token/refresh/header injection). These are handled automatically by two parts:

1. **auth plugin** (written by the business package, assembled from agent-cli-sdk building blocks): beforeCommand fills `ctx.state.user` and caches the token; beforeRequest injects the token header
2. **agent-cli-sdk request layer**: automatic refresh on 401 (singleflight) — provided the auth plugin implements the public `handleUnauthorized` hook

The business package just issues requests with `ctx.get(...)`; the token/header is attached automatically. See `05-credentials.md` for details.

### state: data shared between plugins (strongly typed)

`ctx.state` is the channel for **sharing runtime data between plugins, and between plugins and commands**. It is strongly typed — you can read and write only what `defineCli<State>` declares:

```ts
defineCli<{ user: { userId: string } | null }>({ ... })

// auth plugin (producer): fills state.user in beforeCommand
async beforeCommand(ctx) {
  ctx.state.user = { userId: 'u1' }   // ✅ type is correct
}
```

> In a real project the auth plugin would run the provider chain to get the token and then fill state.user; see `05-credentials.md`.

// command run (consumer): reads state.user
async run(ctx, args) {
ctx.state.user?.userId // ✅ strongly typed
ctx.state.foo // ❌ error: not declared
}

````

**Read/write discipline**: a producer plugin (e.g. auth) declares and writes the fields it owns; consumers (other plugins, command run) only read. This relies on naming conventions + docs (e.g. the auth plugin writes the `user` field); TS does not enforce the read/write split.

> Why keep state: the data computed by plugin A (auth) — `user` — must be used by plugin B (audit) or command run, so there must be a shared channel. Without state you'd be stuck with global variables (worse). Once state is strongly typed it is no longer "an open bag you stuff things into" — accessing an undeclared field is a compile error.

### Output mechanism: run returns data, the framework serializes

**Commands output data by `return`, never by calling any out method.** run returns a `CommandResult`; the framework wraps it into a unified output format and serializes it to stdout.

```ts
async run(ctx, args): Promise<CommandResult | void> {
  const res = await ctx.get<OrderListResult>('/orders', args)
  return {
    data: res.data.items,
    meta: { pagination: { complete: !res.data.hasMore, nextToken: res.data.nextCursor } },
  }
}
````

Framework internal execution order:

```
1. run plugin beforeCommand (fill state)
2. run command run(ctx, args), capture the return value
3. if there is a return value: run plugin transformOutput (transform data)
4. framework wraps into the unified output format + serializes to stdout
```

**Key discipline:**

- Business commands **must never write directly to stdout**. To output, `return { data, meta }`; to log, use `ctx.log` (stderr).
- A pure side-effect command (e.g. a pipeline downstream that reads and writes as it goes) may not return (void is legal), but returning a summary is recommended.

---

## Commands: defineCommand

Every command is declared with `defineCommand`. Commands can be defined individually or assembled into a command-group object.

### A single command (with the three generics)

```ts
import { defineCommand, errs } from "@renxqoo/agent-cli-sdk";
import * as z from "zod";
interface Order {
  id: string;
  total: number;
  status: string;
}

export const getOrder = defineCommand({
  name: "get",
  description: "Get order details",
  args: {
    schema: z.object({ id: z.string().describe("Order ID") }),
    pos: ["id"],
  },
  async run(ctx, { id }) {
    const res = await ctx.get<Order>(`/orders/${id}`);
    if (res.status === 404) throw new errs.NotFoundError(`order ${id} not found`);
    return { data: res.data };
  },
});
```

### Command groups (assembling multiple commands)

```ts
// src/commands/orders.ts
import { defineCommands, defineCommand, errs } from "@renxqoo/agent-cli-sdk";
import * as z from "zod";
interface OrderListResult {
  items: Order[];
  hasMore: boolean;
  nextCursor?: string;
}

export const ordersCommands = defineCommands({
  list: defineCommand({
    name: "list",
    description: "List orders",
    args: {
      schema: z.object({
        limit: z.coerce.number().describe("maximum number to return").default(30),
        offset: z.coerce.number().describe("offset").default(0),
        status: z.enum(["unpaid", "paid", "shipped"]).optional(),
      }),
    },
    async run(ctx, args) {
      const res = await ctx.get<OrderListResult>("/orders", {
        limit: args.limit,
        offset: args.offset,
        ...(args.status && { status: args.status }),
      });
      return {
        data: res.data.items,
        meta: {
          count: res.data.items.length,
          pagination: {
            complete: !res.data.hasMore,
            nextToken: res.data.nextCursor,
          },
        },
      };
    },
  }),

  get: defineCommand({
    name: "get",
    description: "Get order details",
    args: { schema: z.object({ id: z.string() }), pos: ["id"] },
    async run(ctx, { id }) {
      const res = await ctx.get<Order>(`/orders/${id}`);
      if (res.status === 404) throw new errs.NotFoundError(`order ${id} not found`);
      return { data: res.data };
    },
  }),

  update: defineCommand({
    name: "update",
    description: "Update order",
    args: {
      schema: z.object({ id: z.string(), status: z.enum(["paid", "shipped"]) }),
      pos: ["id"],
    },
    async run(ctx, { id, status }) {
      const res = await ctx.patch(`/orders/${id}`, { status });
      return { data: res.data };
    },
  }),
});
```

### args field spec

| Field    | Type                  | Description                                                        |
| -------- | --------------------- | ------------------------------------------------------------------ |
| `type`   | `"argv" \| "json"`    | omitted defaults to argv; json is mutually exclusive with flags/positional parameters |
| `schema` | Zod object            | the sole source of validation, defaults, descriptions, and types   |
| `pos`    | array of schema field names | argv only; maps raw positional parameters in order           |

The SDK only handles the deterministic mapping from Shell tokens to an object plus Zod validation; it does not take part in business-parameter semantics. Whether the backend wants `page/pageSize` or `cursor`, the business package translates it inside `run`.

### Permission checks: declarative `requiresScope` vs imperative `ctx.auth.requireScope()`

| Approach                              | Usage               | Best for                                  |
| ------------------------------------- | ------------------- | ----------------------------------------- |
| `requiresScope` (declarative)         | command config option | **the default**. scope is fixed and static |
| `ctx.auth.requireScope()` (imperative) | call inside run     | scope depends on runtime conditions       |

Both throw an equivalent `PermissionError` (exit 3). The declarative form is clearer and lands in the docs' "permissions" column, so prefer it.

---

## Plugin system (Vite-style)

Cross-cutting concerns (auth/format/fixed parameters/error handling/audit) are implemented via **plugins**. A plugin is a standalone object with a name — composable, reusable, and distributable (as an independent npm package). **Hooks are the plugin's interface, not inline config on defineCli.**

### The Plugin interface

```ts
interface Plugin<State = {}> {
  name: string; // required: plugin name (logging/tracing)
  enforce?: "pre" | "normal" | "post";
  apply?(services: Readonly<AppServices>): void | Promise<void>; // once at assembly time (defineCliApp calls it automatically)
  onAppRun?(event: Readonly<AppRunEvent>): void | Promise<void>; // once per app.run
  afterAppRun?(event: Readonly<AppExitEvent>): void | Promise<void>; // once at the end of each app.run
  beforeCommand?(ctx: CommandContext<State>): Promise<void>;
  beforeRequest?(
    ctx: CommandContext<State>,
    req: Readonly<RequestOptions>,
  ): Promise<RequestOptions>;
  observeRequest?(ctx: CommandContext<State>, event: Readonly<RequestAttemptEvent>): Promise<void>;
  handleUnauthorized?(
    ctx: CommandContext<State>,
    event: Readonly<RequestAttemptEvent>,
  ): Promise<UnauthorizedDecision | undefined>;
  transformOutput?(
    ctx: CommandContext<State>,
    data: Readonly<StructuredData>,
  ): Promise<StructuredData>;
  observeError?(ctx: CommandContext<State>, err: unknown): Promise<void>;
  handleError?(ctx: CommandContext<State>, err: unknown): Promise<ErrorDecision | undefined>;
}
```

### Hook responsibilities

| Hook                 | When it fires                              | What it can change                                     | Typical use                                      |
| -------------------- | ------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------ |
| `apply`              | assembly time (before route compilation)   | resolve services, fill provides, build runtime state   | assemble auth from `services.localState.store`   |
| `onAppRun`           | start of every app.run                     | observe only; failure is silently isolated             | startup metrics                                  |
| `afterAppRun`        | end of every app.run                       | observe only; failure is silently isolated             | version-aware notification (update-notifier)     |
| `beforeCommand`      | before the command's run                   | `ctx.state` (fill data)                                | auth fills user, argument preprocessing          |
| `beforeRequest`      | before every attempt                       | return a new request object                            | add fixed headers, HMAC signature, inject tenantId |
| `observeRequest`     | after every attempt                        | read-only event (`response` / `network-error`)         | audit, metrics, request logging                  |
| `handleUnauthorized` | after the first 401                        | explicit `retry` / `decline` / `reject`                | context-isolated credential renewal              |
| `transformOutput`    | after run returns, before serialization    | return new `data` (StructuredData)                     | transform, redact, drop internal fields, custom format |
| `observeError`       | after error normalization                  | observe only, void does not change the result          | reporting, audit                                 |
| `handleError`        | before error rendering                     | explicit `pass` / `replace` / `recover`                | normalize or recover                             |

### Execution order: the three enforce tiers

Within each hook, plugins run in the three `enforce` tiers:

```
pre plugins (registration order)    ← base setup (add base headers, auth injects token)
  ↓
normal plugins (registration order) ← business-related
  ↓
post plugins (registration order)   ← final wrapping (signing, cleanup)
  ↓
(real execution: send the request / serialize the output)
```

Failures in observing hooks (`observeRequest` / `observeError`) only log a warning; control flow can only be changed by an explicit handle decision.

The app-level hooks (`onAppRun` / `afterAppRun`) are observers that run exactly once per process run: they cover help, --version, unknown commands, and error paths; exceptions are silently isolated and cannot change the exit code or any output. They suit only operational hints that need no reliable delivery; audit, writes, or telemetry that must complete must not go here. `apply` belongs to assembly (failure = startup failure) and is run by `defineCliApp` in registration order before route compilation.

### beforeRequest: uniform handling of request parameters

beforeRequest receives an immutable complete request description and must return a new request object:

```ts
// plugin: add a fixed parameter to every endpoint's query
const tenantPlugin = {
  name: "tenant",
  enforce: "pre",
  async beforeRequest(ctx, req) {
    return { ...req, query: { ...req.query, tenantId: "acme" } };
  },
};

// plugin: add fixed values to every endpoint's headers
const headerPlugin = {
  name: "fixed-headers",
  enforce: "pre",
  async beforeRequest(ctx, req) {
    return {
      ...req,
      headers: { ...req.headers, "X-Client": "rxcli", "X-Trace-Id": ctx.state.traceId },
    };
  },
};

// plugin: HMAC signing (post: computed after all headers/body are finalized)
const hmacPlugin = {
  name: "hmac",
  enforce: "post",
  async beforeRequest(ctx, req) {
    return { ...req, headers: { ...req.headers, "X-Sig": sign(req.headers, req.body) } };
  },
};
```

beforeRequest can also return a new path (rewrite the request) or throw to abort. Changing the path is a high-risk operation.

### Usage: registering plugins in defineCli

```ts
defineCli<{
  user: { userId: string } | null;
  traceId: string;
}>({
  name: "orders",
  plugins: [
    auth, // the business package's own auth plugin (createCrmAuth, enforce: 'pre')
    tenantPlugin, // add fixed query
    headerPlugin, // add fixed header
    hmacPlugin, // signing (post)
    auditPlugin, // observeRequest audit
  ],
  commands: ordersCommands,
});
```

**All extensions are unified into plugins — defineCli has no inline hook fields like `beforeRequest`, only the `plugins` array.** To inline simple logic in a business package, write an anonymous plugin:

```ts
plugins: [
  {
    name: "inline",
    enforce: "pre",
    async beforeRequest(ctx, req) {
      return { ...req, headers: { ...req.headers, "X-Foo": "bar" } };
    },
  },
];
```

### Plugins are standalone reusable modules

A plugin can be published as a standalone npm package and reused across multiple business packages:

```ts
// @org/rxcli-plugin-tenant (standalone npm)
export const tenantPlugin = (tenantId: string): Plugin => ({
  name: 'tenant',
  enforce: 'pre',
  async beforeRequest(ctx, req) { return { ...req, query: { ...req.query, tenantId } } },
})

// use it from any business package
import { tenantPlugin } from '@org/rxcli-plugin-tenant'
defineCli({ plugins: [tenantPlugin('acme')], ... })
```

### Auth plugin: use defineAuth for standard cases, combine building blocks for special protocols

`defineAuth` is the standard auth factory, and what it returns is still an ordinary `Plugin`. Use it directly for OAuth, Bearer, API key, and Basic scenarios; only HMAC, mTLS, or composite auth require hand-writing `beforeCommand`, `beforeRequest`, and `handleUnauthorized` from the building blocks below.

Building blocks provided by agent-cli-sdk (imported from the main package `@renxqoo/agent-cli-sdk`):

| Building block                                                                                                           | What it does                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `defineCliApp({ dir, plugins })` / `defineCli({ plugins })`                                                              | app assembler (the single directory decision, auto-applies plugins) / low-level synchronous assembler |
| `createLocalState({ dir })` / `createMemoryLocalState()`                                                                 | local state (includes ConfigStore; inject either dir or localState into defineCliApp)          |
| `defaultProviders()` / `flagProvider` / `envProvider` / `fileProvider` / `oauthProvider`                                 | default providers for the provider chain                                                       |
| `resolveWithChain(providers, pctx)` / `resolveIdentityWithChain(providers, pctx)`                                        | run the chain to obtain a token / identity                                                     |
| `injectAuthHeader(req, token, style)`                                                                                    | inject the header according to authStyle (bearer/x-api-key/basic)                              |
| `createOn401Hook({cfg, store, namespace})`                                                                               | the 401 singleflight refresh primitive (called by a Plugin's `handleUnauthorized`)             |
| `deviceAuthorization` / `pollDeviceToken` / `getUserInfo` / `revokeToken` / `registerClient`                             | OAuth 2.1 endpoint primitives (device authorization + user info/revoke/register)               |

#### How to write an auth Plugin (see `createCrmAuth` in `apps/crm/src/auth.ts`)

Below is a complete auth Plugin factory example. Business packages can follow this skeleton and swap the provider, header injection, or identity source. The directory/store is not a factory argument: it is obtained from the assembler via `apply(services)` (which defineCliApp runs automatically):

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
  // assembly-time state: filled in apply from services.localState.store
  let ready!: { store: ConfigStore; providers: ReturnType<typeof defaultProviders>; on401?: () => Promise<any> };
  const authStyle = opts.authStyle ?? "bearer";
  const sessions = new WeakMap<CommandContext<State>, { token: string; refreshable: boolean }>();

  return {
    name: `auth:${opts.namespace}`,
    enforce: "pre",

    async apply(services) {
      const store = services.localState.store;
      const providers = defaultProviders();
      // 401 singleflight refresh hook (created only when oauth is configured)
      const on401 = opts.oauth
        ? createOn401Hook({ cfg: opts.oauth, store, namespace: opts.namespace })
        : undefined;
      ready = { store, providers, on401 };
    },

    async beforeCommand(ctx) {
      const { store, providers } = ready;
      // ① run the provider chain to get a token (stop on first hit)
      const pctx: ProviderContext = {
        namespace: opts.namespace,
        configStore: store,
        args: {},
        env: process.env,
      };
      const resolved = await resolveWithChain(providers, pctx);
      if (!resolved)
        throw new AuthenticationError({
          subtype: "no_credentials",
          message: "no credentials configured",
          hint: "set the XXX_API_KEY environment variable",
        });

      // ② wrap store as ctx.credentials (the command's runtime API)
      (ctx as any).credentials = {
        get: async (ns: string) => store.loadCredentials(ns),
        save: (ns: string, d: Record<string, unknown>) => store.saveCredentials(ns, d),
        clear: (ns: string) => store.clearCredentials(ns),
      };

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

**What the three hooks do:**

| Hook                 | What it does in the auth Plugin                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeCommand`      | run the provider chain to get a token; wrap `store` as `ctx.credentials`; obtain identity from the matched provider; establish a context-keyed session |
| `beforeRequest`      | use `injectAuthHeader(req, token, authStyle)` to inject `Authorization: Bearer xxx` / `X-Api-Key: xxx` / `Authorization: Basic xxx` according to authStyle |
| `handleUnauthorized` | call `createOn401Hook(...)`; update the context-keyed session, then explicitly return `retry`                                                          |

**Key discipline:**

- Auth uses the two standard hooks `beforeCommand` + `beforeRequest`; don't invent new mechanisms.
- The token must be isolated per `CommandContext` (e.g. `WeakMap<CommandContext, Session>`); sharing via a single closure variable is forbidden.
- 401 refresh is a request-layer (framework) capability, but the **execution capability** (how to refresh, how to persist) is provided by the auth Plugin through the public `handleUnauthorized`.
- A business package may ignore the `createCrmAuth` skeleton entirely and write its own — as long as it honors the `Plugin` interface and the contracts above.

See `05-credentials.md` for details.

### The transform vs format layering

`transformOutput` (transform) and output formatting (format) are **two layers and must not be merged**:

```
run() returns structured data
  ↓ transformOutput plugin (business-package defined) → changes the payload, but still structured (StructuredData)
  ↓ agent-cli-sdk wraps into the unified output format + serializes (format: JSON/table)
  ↓ stdout
```

| Layer                      | Defined by            | input→output             | Example                                |
| -------------------------- | --------------------- | ------------------------ | -------------------------------------- |
| transform (`transformOutput`) | business-package plugin | structured→StructuredData | drop fields, rename fields, (later) redact |
| format                     | agent-cli-sdk         | structured→byte stream   | `{...}`→JSON text or a table           |

**transform must never return a string** (the StructuredData type excludes it), otherwise the pipeline contract is broken.

### Lifecycle overview

```
plugin beforeCommand (pre→normal→post)     fill state, modify args
  ↓
command run(ctx, args)                     business logic, ctx.get sends the request, return {data, meta}
  ├ each ctx.get/post:
  │    plugin beforeRequest (pre→normal→post)  modify req (add header/sign/change path)
  │    → actually send the request (inside agent-cli-sdk, with auth)
  │    plugin observeRequest (pre→normal→post)   audit/log (read-only res)
  ↓
plugin transformOutput (pre→normal→post)      transform data (return StructuredData)
  ↓
framework serializes → stdout                unified output format (framework calls, business package does not)

an error thrown at any stage → plugin observeError/handleError chain (each runs) → render error output to stderr + exit code
```

---

## Pagination implementation

Business commands drive it manually inside `run` and fill in `meta.pagination` themselves (decision list #9: the agent decides to continue fetching on its own, no forced streaming).

### Simple pagination (pass through the backend's page/pageSize)

```ts
list: defineCommand({
  name: "list",
  description: "List orders",
  args: {
    schema: z.object({
      limit: z.coerce.number().default(30),
      offset: z.coerce.number().default(0),
    }),
  },
  async run(ctx, args) {
    const res = await ctx.get("/orders", { limit: args.limit, offset: args.offset });
    return {
      data: res.data.items,
      meta: {
        count: res.data.items.length,
        pagination: {
          complete: !res.data.hasMore,
          pages: 1,
          items: res.data.items.length,
          nextToken: res.data.hasMore ? String(args.offset + args.limit) : undefined,
        },
      },
    };
  },
});
```

### Cursor pagination (GraphQL/modern APIs)

```ts
list: defineCommand({
  name: "list",
  description: "List orders",
  args: {
    schema: z.object({
      cursor: z.string().describe("pagination cursor (taken from nextToken)").optional(),
    }),
  },
  async run(ctx, args) {
    const res = await ctx.get("/orders", { cursor: args.cursor });
    return {
      data: res.data.edges.map((e) => e.node),
      meta: {
        pagination: {
          complete: !res.data.pageInfo.hasNextPage,
          nextToken: res.data.pageInfo.endCursor,
        },
      },
    };
  },
});
```

**Key point: `complete` and `nextToken` must be filled in truthfully.** The agent relies on them to decide whether to keep fetching. See `03-envelopes.md` for details.

---

## Hundreds of endpoints: split files and assemble

When there are many endpoints, split files by business domain and assemble them at the entry point (decision list #19: no resource generator). The assembly rule uses an **explicit `namespaces` field**:

- **Top-level commands** go in `commands` (its key is the command name) → `rxcli-crm <cmd>`
- **Sub-namespace groups** go in `namespaces` (its key is the sub-namespace) → `rxcli-crm <ns> <cmd>`

```ts
// src/commands/orders.ts
export const ordersCommands = defineCommands({ list: ..., get: ..., update: ... })

// src/commands/invoices.ts
export const invoicesCommands = defineCommands({ list: ..., generate: ... })

// src/index.ts —— entry-point assembly
export default defineCli<...>({
  name: 'crm',
  plugins: [auth],
  commands: {
    health: healthCmd,           // top-level command (optional) → rxcli-crm health
  },
  namespaces: {
    orders:   ordersCommands,    // sub-namespace → rxcli-crm orders list
    invoices: invoicesCommands,  // sub-namespace → rxcli-crm invoices generate
  },
})
```

> **Why use an explicit `namespaces` field rather than spread/nested duck-typing:** spread (`...ordersCommands`) flattens `list`/`get`; same-named `list`/`get` across business domains collide and overwrite each other, and the sub-namespace hierarchy is lost. Duck-typing (guessing command vs namespace by whether a value has `run`) introduces TS union-type ambiguity. An explicit field keeps the `commands` and `namespaces` types clearly separated — no ambiguity, no collisions.

**A single business domain (standalone bin) needs no namespaces**: `defineCli({ name: 'orders', commands: ordersCommands })`, the namespace is `name` (the PipeRecord.type fallback); the terminal command name `binName` is auto-detected from package.json's bin, so it needn't be written by hand.

### defineCli full config reference

```ts
defineCli<State>({
  name: 'orders',                  // required: namespace (PipeRecord.type fallback, used for skill identification)
  binName?: 'rxcli-orders',        // optional: terminal bin name (help/SKILL.md signature); auto-detected from package.json, usually no need to write it
  description: '...',              // required
  plugins: Plugin[],               // required: all extensions (including auth, see below)
  commands: { ... },               // required: top-level command group (key = command name) → rxcli-<name> <cmd>
  namespaces?: { ... },            // optional: sub-namespace groups (key = sub-namespace) → rxcli-<name> <ns> <cmd>; not filled in for a single business domain
  skillsDir?: './skills',          // optional: skill directory (default ./skills)
  errorOnStatus?: Record<number | `${number}xx`, string>,  // optional: status→error auto-throw
  messages?: { ... },              // optional: onboarding copy i18n
})
```

**Auth**: `defineAuth({...})` is a synchronous factory; put its return value directly into `defineCliApp`'s `plugins` (the assembler runs `apply` automatically); hand-write a Plugin only for special protocols (see `05-credentials.md`).

---

## Loading methods (same codebase, two usages)

### Method A: standalone bin (default)

The business package's `bin` field in `package.json` determines the bin name:

```json
{ "bin": { "rxcli-orders": "./dist/index.js" } }
```

After installation: `rxcli-orders list`.

### Method B: install into the rxcli main package (become a subcommand)

Add the `"rxcli": {"plugin": true}` marker, and the `@renxqoo/cli` meta package auto-discovers and registers it as a subcommand at startup:

```bash
npm i -g @org/rxcli-orders
rxcli orders list             # ← auto-registered (namespace = defineCli.name)
```

**The business package's code is unchanged.**

### Method C: compose in a pipeline

```bash
rxcli-orders list --status unpaid | rxcli-invoices generate
rxcli-orders list | rxcli-customers get
```

Downstream commands auto-detect whether stdin is a pipe call (`ctx.pipe.isInPipe()`) — no flag to declare.

---

## Pipeline: as a downstream command

A downstream command reads upstream records with `ctx.pipe.in()`:

```ts
generate: defineCommand({
  name: 'generate', description: 'Generate invoices',
  args: { orderId: { type: 'string' } },
  async run(ctx, args) {
    if (ctx.pipe.isInPipe()) {
      let count = 0
      for await (const rec of ctx.pipe.in()) {     // async-iterate upstream records (PipeRecord)
        if (rec.type && rec.type !== 'orders') continue   // filter by source (optional)
        await ctx.post('/invoices', { orderId: rec.id })
        count++
      }
      return { data: { generated: count } }
    }
    if (!args.orderId) throw new errs.ValidationError({ param: 'orderId', message: 'orderId or pipeline input is required' })
    const res = await ctx.post('/invoices', { orderId: args.orderId })
    return { data: res.data }
  },
}),
```

**Pipelines pass reference + ID** (decision list #11): pass a redacted value + a stable ID through the chain; the downstream relates them by ID. See `01-cli-usage.md` for details.

---

## Testing: vitest + createTestCtx

agent-cli-sdk provides `createTestCtx`; business packages use it to mock ctx and test run logic:

```ts
// src/commands/orders.test.ts
import { describe, it, expect } from "vitest";
import { createTestCtx, errs } from "@renxqoo/agent-cli-sdk";
import { ordersCommands } from "./orders";

describe("orders list", () => {
  it("returns the order list", async () => {
    // ① build a mock ctx: mock the request method (the high-level get/post both go through request; mocking it covers both)
    const ctx = createTestCtx({
      request: async (opts) => {
        if (opts.path === "/orders") {
          return { status: 200, data: { items: [{ id: "o_1", total: 100 }] }, headers: {} };
        }
        throw new Error(`unexpected ${opts.path}`);
      },
      state: {}, // initial state
    });
    // ② call run(ctx, args) directly and assert on the return value
    const result = await ordersCommands.list.run(ctx, { limit: 30, offset: 0 });
    expect(result.data).toEqual([{ id: "o_1", total: 100 }]);
  });

  it("404 throws NotFoundError", async () => {
    const ctx = createTestCtx({ request: async () => ({ status: 404, data: {}, headers: {} }) });
    await expect(ordersCommands.get.run(ctx, { id: "x" })).rejects.toBeInstanceOf(
      errs.NotFoundError,
    );
  });
});
```

**Pure-function testing**: `run(ctx, args)` is an ordinary function and ctx is injected, so mocking `request` tests all the business logic without a real server. `createTestCtx` can also inject mock `log`/`pipe` and so on.

---

## Complete business package example (orders)

```ts
// src/commands/orders.ts
import { defineCommands, defineCommand, errs } from '@renxqoo/agent-cli-sdk'
import * as z from 'zod'

interface Order { id: string; total: number; status: string }
interface OrderListResult { items: Order[]; hasMore: boolean; nextCursor?: string }

export const ordersCommands = defineCommands({
  list: defineCommand({
    name: 'list', description: 'List orders',
    args: { schema: z.object({ limit: z.coerce.number().default(30), status: z.string().optional() }) },
    async run(ctx, args) {
      const res = await ctx.get<OrderListResult>('/orders', { limit: args.limit, ...(args.status && { status: args.status }) })
      return {
        data: res.data.items,
        meta: { pagination: { complete: !res.data.hasMore, nextToken: res.data.nextCursor } },
      }
    },
  }),
  get: defineCommand({
    name: 'get', description: 'Get order details',
    args: { schema: z.object({ id: z.string() }), pos: ['id'] },
    async run(ctx, { id }) {
      const res = await ctx.get<Order>(`/orders/${id}`)
      if (res.status === 404) throw new errs.NotFoundError(`order ${id} not found`)
      return { data: res.data }
    },
  }),
})

// src/index.ts
#!/usr/bin/env node
import { defineCli } from '@renxqoo/agent-cli-sdk'
import { ordersCommands } from './commands/orders'
import { createCrmAuth } from './auth'

const auth = createCrmAuth<{ user: { userId: string } | null }>({
  namespace: 'orders',
  authStyle: 'bearer',
})

export default defineCli<{
  user: { userId: string } | null
}>({
  name: 'orders',
  description: 'Query and manage orders',
  plugins: [auth],
  commands: ordersCommands,
  skillsDir: './skills',
})
```

---

## Common developer mistakes (pitfalls to avoid)

1. **Calling `console.log` directly to stdout** → ❌ breaks the pipeline. Log with `ctx.log` (stderr); to output data, `return { data, meta }`.
2. **Handling auth inside run** → ❌ auth is the auth plugin's job. Use `defineAuth` for standard cases and combine public building blocks only for special protocols; commands just call `ctx.get`.
3. **Returning a string from `transformOutput`** → ❌ breaks the pipeline contract. Return StructuredData (object/array/null).
4. **Not filling in `pagination.complete`** → ❌ the agent will wrongly think fetching is done. Fill it in truthfully.
5. **Throwing a bare Error** → ❌ use the `errs.*` typed errors. A bare Error gets caught and turned into `internal/unknown`, the exit code is wrong, and the agent misreads it. After throwing, it enters the observeError/handleError chain (plugins can intercept) before rendering to stderr.
6. **Stuffing runtime state into ctx** → ❌ ctx has no open extension points (state is strongly typed; accessing undeclared fields errors). Runtime state (user/traceId) is filled into `ctx.state` (declared fields) by the auth plugin; business data goes through args and the return value.
7. **Hand-writing the SKILL.md command table** → ❌ generate it with `rxcli skills gen` (see `06-skills.md`); hand-write only the semantic part.
8. **Writing inline hooks on defineCli** → ❌ all extensions are unified into plugins. For inline needs, write an anonymous plugin and put it in `plugins`.
