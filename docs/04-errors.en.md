# 04 · Error categories and exit codes

> agent-cli-sdk turns "command failure" into a structured signal an agent can branch on precisely, using 9 typed error categories plus an exit-code mapping. Business packages throw typed errors, and agent-cli-sdk uniformly renders them as error output to stderr. This document defines the 9 Categories, constructor signatures, hint conventions, and when to throw.

---

## Design principles

1. **Business packages only throw typed errors**, never a bare `Error`. agent-cli-sdk catches them and renders them into a unified output format (see `03-envelopes.md`). **A bare `throw new Error(...)` falls back to `internal/unknown` (exit 5)**, which the agent will misread as an agent-cli-sdk bug — so always use `errs.*`.
2. **The exit code is determined by the Category**; business packages do not set exit codes themselves.
3. **The hint field is an executable instruction for the agent**, not an explanation for humans.
4. **Wrapping an error must not downgrade it**: when a lower layer already returned a typed error, pass it through without re-wrapping.
5. **After throwing, the error enters the observeError/handleError chain** (see below); only when the chain ends is it rendered to stderr.

The error taxonomy aligns with lark-cli's RFC 7807 approach (see `00-overview.md` for details).

---

## The 9 Categories

| Category         | When to use                                    | Exit Code | Typed constructor                         |
| ---------------- | ---------------------------------------------- | :-------: | ----------------------------------------- |
| `validation`     | User-supplied argument/flag is invalid         |     2     | `errs.ValidationError`                    |
| `authentication` | No valid token / login required                |     3     | `errs.AuthenticationError`                |
| `authorization`  | Token valid but missing scope / insufficient permission |     3     | `errs.PermissionError`                    |
| `config`         | Local config missing / unbound                 |     3     | `errs.ConfigError`                        |
| `network`        | DNS / connection refused / timeout / transport layer |     4     | `errs.NetworkError`                       |
| `api`            | Server-side business error (non-2xx HTTP, no specific category) |     1     | `errs.APIError` / `errs.NotFoundError` / `errs.ConflictError` etc. |
| `policy`         | Risk control / content safety / security challenge |     6     | `errs.PolicyError`                        |
| `internal`       | SDK contract violation / decode failure / should never happen |     5     | `errs.InternalError`                      |
| `confirmation`   | High-risk write requires `--yes` confirmation  |    10     | `errs.ConfirmationRequiredError`          |

> **`authentication` vs `authorization`**: the former is "not logged in" (no token), the latter is "logged in but lacking permission" (valid token but missing scope). This is the standard gRPC/Google APIs distinction (`Unauthenticated` vs `PermissionDenied`).

---

## Constructor signatures

All error types inherit from `errs.CliError` (embedding `Problem`) and live in `@renxqoo/agent-cli-sdk/errs`.

### Common Problem structure

```ts
interface Problem {
  category: Category; // one of the 9 categories
  subtype: string; // stable identifier (see the subtype table below)
  code?: number; // upstream numeric code (HTTP status / API code)
  message: string; // for humans; not guaranteed stable
  hint?: string; // executable instruction for the agent
  retryable?: boolean; // whether it can be retried
  cause?: unknown; // preserves the underlying error (errors.Is/Unwrap work)
}
```

### Constructor usage

```ts
import { errs } from "@renxqoo/agent-cli-sdk";

// ① Argument error (user input is wrong)
throw new errs.ValidationError({
  subtype: "invalid_argument",
  param: "--limit", // name of the offending argument
  message: "--limit must be a positive number",
  hint: "use --limit 30 to specify the number of results",
});

// ② Login required (token missing or expired)
throw new errs.AuthenticationError({
  subtype: "no_token",
  message: "not logged in",
  hint: "run `rxcli auth login` to log in",
});

// ③ Insufficient permission (token valid but missing scope)
throw new errs.PermissionError({
  subtype: "missing_scope",
  message: "missing orders:read permission",
  hint: "run `rxcli auth login --scope orders:read` to re-login and obtain the scope",
  missingScopes: ["orders:read"], // extension field (machine-readable)
});

// ④ Config error (local config missing)
throw new errs.ConfigError({
  subtype: "missing_config",
  param: "baseUrl",
  message: "backend URL not configured",
  hint: "run `rxcli config set baseUrl https://...`",
});

// ⑤ Network error (DNS / timeout / refused)
throw new errs.NetworkError({
  subtype: "timeout",
  message: "request timed out",
  retryable: true, // ← retryable
  cause: originalError, // preserves the underlying error
});

// ⑥ API error (server-side business error)
throw new errs.APIError({
  subtype: "server_error",
  code: 500,
  message: "server internal error",
  retryable: true,
});

// ⑥' Resource not found (a common special case of API error)
throw new errs.NotFoundError("order o_1001 does not exist");
// equivalent to new errs.APIError({ subtype: 'not_found', code: 404, message })

// ⑥'' Resource conflict (resource already taken under concurrency; synonymous with HTTP 409; retryable by default)
throw new errs.ConflictError("skill sync already in progress");
// equivalent to new errs.APIError({ subtype: 'conflict', code: 409, message, retryable: true })

// ⑦ Policy block (risk control / content safety)
throw new errs.PolicyError({
  subtype: "content_blocked",
  message: "content triggered the safety policy",
  hint: "modify the content and retry, or contact an administrator",
});

// ⑧ Internal error (a situation that should not occur in the SDK)
throw new errs.InternalError({
  subtype: "decode_failure",
  message: "failed to parse the response",
  cause: parseError,
});

// ⑨ Confirmation required (high-risk write)
throw new errs.ConfirmationRequiredError({
  subtype: "high_risk_write",
  message: "bulk delete requires confirmation",
  hint: "add --yes to skip confirmation",
});
```

---

## param field conventions (how to write argument names)

The `param` / `params` fields of `ValidationError` identify the offending argument. **Rule: the param value equals the form the user actually typed on the command line:**

| Argument kind        | param form                            | Example                   |
| -------------------- | ------------------------------------- | ------------------------- |
| flag argument        | with `--` prefix                      | `'--limit'`, `'--status'` |
| positional argument  | original name, **without** the prefix | `'id'`, `'orderId'`       |

```ts
// flag argument error: param includes --
throw new errs.ValidationError({
  subtype: "invalid_argument",
  param: "--limit",
  message: "--limit must be a positive number",
});

// positional argument error: param uses the original name, without --
throw new errs.ValidationError({
  subtype: "missing_required",
  param: "id",
  message: "missing order ID",
});
```

This way, when an agent or a human sees `param`, they know which token on the command line it is and can directly map it to what to change. When several arguments are wrong, use the `params` array.

---

## subtype identifier conventions

`subtype` is a **wire-stable** identifier the agent branches on. Conventions:

- **lowercase + underscores**: `missing_scope`, `invalid_argument`, `not_found`
- **semantic, not implementation-bound**: `timeout` (not `fetch_timeout`, since the implementation may change)
- **declared subtypes are validated in CI** (undeclared ones fail, preventing typos from silently shipping)

### Common subtype reference (non-exhaustive)

| Category       | Common subtypes                                                           |
| -------------- | ------------------------------------------------------------------------- |
| validation     | `invalid_argument`, `missing_required`, `out_of_range`                    |
| authentication | `no_token`, `token_expired`, `token_revoked`                              |
| authorization  | `missing_scope`, `app_permission_denied`, `forbidden`                     |
| config         | `missing_config`, `invalid_config`, `unbound_env`, `skill_sync_failed`    |
| network        | `timeout`, `connection_refused`, `dns_failure`, `ssl_error`               |
| api            | `not_found`, `already_exists`, `conflict`, `rate_limited`, `server_error` |
| policy         | `content_blocked`, `challenge_required`, `access_denied`                  |
| internal       | `decode_failure`, `unknown`, `contract_violation`                         |
| confirmation   | `high_risk_write`                                                         |

Business packages may define their own subtypes, but must register them in the package's subtype declaration file (agent-cli-sdk will provide lint validation later).

---

## hint field conventions (instructions for the agent)

`hint` is not an explanation for humans; it is an **executable recovery instruction for the agent**. Conventions:

✅ **Good hints** (the agent can execute them directly):

```
"run `rxcli auth login` to log in"
"run `rxcli auth login --scope orders:read` to re-obtain the scope"
"use --limit 30 to specify the number of results (1-100)"
"add --yes to skip bulk-operation confirmation"
```

❌ **Bad hints** (the agent doesn't know what to do):

```
"please check your configuration"  ← check what? how?
"an error occurred, retry later"   ← retry what? when?
"insufficient permission"          ← how to obtain permission?
```

**The criterion: after reading the hint, can the agent immediately know what command or operation to run next?** If yes, it's a good hint; if not, rewrite it.

---

## When to throw vs. when to branch on status

Inside a business command's `run`, you call `ctx.get` / `ctx.post` etc. (returning `TransportResponse`, which contains `status`). Two handling modes:

> **About automatic 401 renewal**: business packages usually do not handle 401 — the agent-cli-sdk request layer detects a 401 internally and automatically triggers a token refresh (singleflight deduplication), with the refresh capability provided by oauthProvider (see `05-credentials.md`). The two cooperate: the request layer handles "detection + single-flight dedup", while the provider handles "how to exchange the token". Business packages are unaware of this and only call `ctx.get`. The two modes below target **non-auth** business statuses (404/403/5xx, etc.).

### Mode A: the command checks status itself and throws a typed error

```ts
async run(ctx, { id }) {
  const res = await ctx.get(`/orders/${id}`)
  if (res.status === 404) throw new errs.NotFoundError(`order ${id} does not exist`)
  if (res.status === 403) throw new errs.PermissionError({ subtype: 'forbidden', message: 'not allowed to access this order' })
  if (res.status >= 500) throw new errs.APIError({ subtype: 'server_error', code: res.status, message: 'server error', retryable: true })
  return { data: res.data }
}
```

**Use when: the business package wants to give a specific status business semantics** (e.g. 404 = "order does not exist").

### Mode B: enable auto-throw (agent-cli-sdk converts status by rule)

```ts
// configure in defineCli: which statuses auto-throw
export default defineCli({
  // ...
  errorOnStatus: {
    // optional: status → subtype mapping
    404: "not_found",
    403: "forbidden",
    "5xx": "server_error",
  },
});
```

The **value** of `errorOnStatus` **is a subtype string** (not a constructor name). **The subtype implies the category** (see the "Common subtype reference" table above; each subtype belongs to a fixed category), and agent-cli-sdk uses that to automatically pick the matching typed constructor + exit code, so business packages don't hand-write ifs. The built-in mapping for the example above:

| status | subtype        | → category    | → constructor                            | → exit |
| ------ | -------------- | ------------- | ---------------------------------------- | :----: |
| `404`  | `not_found`    | api           | `APIError` (NotFoundError is its alias)  |   1    |
| `403`  | `forbidden`    | authorization | `PermissionError`                        |   3    |
| `5xx`  | `server_error` | api           | `APIError`                               |   1    |

> If you configure a subtype that is not registered in the subtype registry, agent-cli-sdk fails validation at startup (and also fails in CI, preventing typos from silently shipping).

When enabled, client.request automatically throws the matching typed error for matching statuses, so business packages don't hand-write ifs. **Disabled by default** (decision: business errors pass through the status without auto-throw — but business packages may opt in).

---

## Error pass-through and wrapping rules

### Lower layer already returned a typed error → pass it through

```ts
async run(ctx, args) {
  try {
    const res = await ctx.get('/orders')
    return { data: res.data }
  } catch (err) {
    // ✅ lower layer (client) already threw a typed error (e.g. NetworkError); pass it through
    if (err instanceof errs.CliError) throw err
    // ❌ do not re-wrap: throw new errs.APIError({ cause: err }) — this downgrades the category
    // only "untyped errors" need wrapping
    throw new errs.InternalError({ subtype: 'unknown', message: 'unexpected error', cause: err })
  }
}
```

**Re-wrapping an already-typed error loses the original category/subtype — it's a downgrade.** Check with `instanceof errs.CliError`, and pass it through if it matches.

### Preserve cause

When wrapping, preserve the underlying error in the `cause` field so `errors.is` / `errors.Unwrap` still work:

```ts
throw new errs.NetworkError({
  subtype: "timeout",
  message: "request timed out",
  cause: originalFetchError, // ← preserve
});
```

---

## The retryable field

`retryable: true` tells the agent "retrying this error may succeed". Typical cases:

- network timeout, 429 rate limiting, 5xx transient server error → `retryable: true`
- argument error, not logged in, insufficient permission, 404 → `retryable: false` (omit the field)

Seeing `retryable: true`, the agent can retry automatically (with backoff).

---

## observeError / handleError: observation and explicit recovery

The error is first normalized to `CliError`, then passes through two boundaries with distinct responsibilities: `observeError` only reports or audits and returns `void`, so it never swallows the error; `handleError` must return an explicit decision — `pass`, `replace`, or `recover`. If a hook itself throws, the framework logs a warning and keeps the most recent valid business error.

Error plugins can be used to:

- normalize backend-specific error codes into standard subtypes
- redact sensitive information in error messages (e.g. tokens leaking into message)
- add hints to specific errors
- retry specific errors (e.g. 502/503)

```ts
// error-normalization plugin
const errorNormalizePlugin = {
  name: 'error-normalize',
  async observeError(ctx, err) {
    await telemetry.capture(err)
  },
  async handleError(ctx, err) {
    // redact: message may contain a token
    if (err instanceof errs.CliError && err.message) {
      err.message = err.message.replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    }
    // add a hint to network errors
    if (err instanceof errs.NetworkError && !err.hint) {
      err.hint = 'check your network connection, or retry later'
    }
    return { action: 'replace', error: err }
  },
}

defineCli({ plugins: [auth, errorNormalizePlugin], ... })
```

The new error from `replace` is passed to subsequent handlers; `recover` is the only success exit and may carry a proper `CommandResult`. `undefined` is treated only as `pass` and logged as a contract warning.

---

## BareError: the only exception that bypasses error output

`errs.BareError` does **not belong** to the 9 Categories; it is a special type for "predicate command" scenarios (see "BareError exception" in `03-envelopes.md`):

```ts
// predicate command: stdout already has the complete answer (e.g. auth check's yes/no JSON), and only the matching exit code is wanted
if (!loggedIn) throw new errs.BareError(3); // exit 3, no error output rendered to stderr
```

- **sets only the exit code, renders no stderr error output** — because stdout already carries the answer
- is the **only** exception on the error side of the output contract (the success-side exception is `skills read`, see `03-envelopes.md`)
- **forbidden for ordinary business commands**: a normal failure must throw one of the 9 typed error categories so agent-cli-sdk renders unified output

---

## Exit code mapping table

agent-cli-sdk sets the exit code automatically from the Category; business packages don't need to worry about it:

| Category                                      | Exit Code |
| --------------------------------------------- | :-------: |
| (success)                                     |     0     |
| `api`                                         |     1     |
| `validation`                                  |     2     |
| `authentication` / `authorization` / `config` |     3     |
| `network`                                     |     4     |
| `internal`                                    |     5     |
| `policy`                                      |     6     |
| `confirmation`                                |    10     |

> Note: 1 (api) and 5 (internal) are separate in lark-cli — api is "server-side business error", internal is "SDK contract violation", the latter being more severe. We keep this distinction.

---

## Common error scenarios reference

| Scenario                                      | What to throw                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| User passed `--limit abc` (non-numeric)       | `ValidationError` subtype `invalid_argument` param `--limit`                              |
| User calls a business command while not logged in | client throws `AuthenticationError` internally (business package doesn't handle it)    |
| Logged in but missing the orders:read scope   | client or command throws `PermissionError` subtype `missing_scope` missingScopes `['orders:read']` |
| Calling `/orders/x` returns 404               | `NotFoundError`                                                                           |
| Network down                                  | client throws `NetworkError` subtype `connection_refused` retryable                       |
| Backend returns 500                           | `APIError` subtype `server_error` retryable                                               |
| Backend returns 429                           | `APIError` subtype `rate_limited` retryable + `Retry-After` hint                          |
| Bulk delete without --yes                     | `ConfirmationRequiredError` hint "add --yes"                                              |
| Response JSON parse failed                    | `InternalError` subtype `decode_failure`                                                  |
