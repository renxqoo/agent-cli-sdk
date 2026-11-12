# 2.0 Production Contracts and Migration

This document defines the 2.0.0 public contract. See [the earlier runtime migration](08-runtime-refactor.md) for session and file-format history.

## Scope and API boundaries

The baseline is `e82b30d`. Preserve command declarations, validated input, output envelopes, plugin ordering, isolated sessions, one authentication retry, credential transactions and recoverable Skill publication. Change HTTP failure defaults, add deadlines/cancellation and separate business APIs from runtime composition.

| Entry point | Responsibility |
| --- | --- |
| `@renxqoo/agent-cli-sdk` | Application/command/auth factories, plugin and context types, errors, output and test helpers |
| `@renxqoo/agent-cli-sdk/advanced` | Plugin setup/dispatch, context and HTTP adapter factories, command execution and pipe readers |
| `@renxqoo/agent-cli-sdk/credentials` | Credential providers and ConfigStore |
| `@renxqoo/agent-cli-sdk/skills` | Skill discovery, generation, publication and formatting utilities |
| `@renxqoo/agent-cli-sdk/errs` | Error types, classification and exit codes |

All listed entry points follow SemVer. Advanced callers own lifecycle ordering and process I/O; advanced does not mean unstable. Files outside `package.json.exports` are private. Public removals, changed default failure semantics and raised runtime minimums require a major release with migration instructions.

The SDK targets standalone Node.js 26+ / Bun 1.4+ CLIs. App.run uses process streams and exitCode. Embedded callers must serialize invocation or compose a runtime through /advanced. Default credentials remain plaintext JSON protected by POSIX permissions, not an operating-system vault; custom ConfigStore implementations can be injected.

## HTTP contract

- HTTP 4xx/5xx throw by default: 400/422 → validation/invalid_argument; 403 → authorization/forbidden; 404 → api/not_found; 409 → api/conflict; 429 → api/rate_limited; 5xx → api/server_error; other errors → api/http_error.
- Custom errorOnStatus exact mappings win over custom class mappings; both win over built-in defaults. Final 401 retains the authentication category; only authentication mappings apply to it.
- Explicit per-request allowHttpErrors: true returns error responses for command-specific inspection, bypassing status mapping except for final 401. Such callers must handle every remaining error status.
- Each physical business HTTP request has a 30,000 ms default timeout, covering fetch and response body reading. Application requestTimeoutMs changes the default; per-request timeout wins. Values must be integer milliseconds from 1 to 2,147,483,647.
- RequestControls is the third argument of get (after query), post/put/patch (after body), and the second argument of delete. ctx.request accepts the same control fields.
- Caller signal is combined with the deadline. Cancellation is network/cancelled, retryable:false; timeout is network/timeout, retryable:true. Both have exit code 4. Caller reasons remain internal causes and are not echoed.
- Preparation plugins cannot remove caller cancellation. Cancelled requests do not send an authentication retry. A caller may stop waiting for shared refresh; that refresh may finish for other callers.
- Audit delivery starts once for each actual attempt. Cancellation can stop waiting for already-started observers, which continue independently. Cancellation does not roll back an upstream write.
- Only the first 401 can trigger one retry. Each actual attempt is prepared from the logical request and observed once. Network errors and 5xx are not automatically retried. Custom HttpAdapter implementations must honor signal, timeout and single-attempt semantics.
- Per-attempt deadlines do not cover arbitrary plugin work or shared OAuth refresh. OAuthClient retains its own 30-second protocol timeout. Hooks must terminate; callers needing a deadline across the whole operation can pass AbortSignal.timeout(...).

```ts
import { setupPlugins, throwForResponse } from "@renxqoo/agent-cli-sdk/advanced";
import { generateAutogenBlock } from "@renxqoo/agent-cli-sdk/skills";

// defineCli({ ..., requestTimeoutMs: 15_000 }) sets the application default.
const response = await ctx.get("/orders", { limit: 20 }, {
  timeout: 5_000,
  signal: AbortSignal.timeout(10_000),
});
const inspected = await ctx.get(`/orders/${id}`, undefined, { allowHttpErrors: true });
if (inspected.status === 404) { /* command-specific recovery or typed error */ }
throwForResponse(inspected); // classify remaining errors before returning success
```

## Migration and verification

1. Migrate manual HTTP status branches to explicit allowHttpErrors and handle remaining failures.
2. Move runtime composition imports to /advanced and Skill utilities to /skills. Update application and long-operation timeouts.
3. Run consumer types and behavior tests, then the complete repository gates. No credential/Skill data-format migration is introduced by this change. Rollback must restore both consumer code and SDK version together.

The request behavior matrix is covered by production-request and request-network tests, public entry points by type fixtures and actual tarball consumption, release policy by release-gate tests. Existing session, cross-process and Skill recovery suites remain part of the full gates.

pnpm release:check --base <git-ref> requires valid increasing SemVer when the version changes and exactly one matching, validly dated changelog heading. The default base is HEAD; missing Git bases fail closed. CI compares PR base SHA or main push before SHA. The gate checks metadata, not every possible source compatibility break.

Build, typecheck, lint, format, documentation links, Node/Bun tests, coverage and tarball installation are required. Packaged consumers check all five entry points, emitted declarations and failure/cancellation exit codes. Local macOS results and cross-platform CI configuration must be reported separately. Tests do not establish long-term production adoption. Publishing remains an explicit action; this change prepares 2.0.0 without publishing.

## Local acceptance record (2026-11-12)

On macOS arm64, Node.js 26.0.0 / 26.13.0 and Bun 1.4.0 / 1.4.4 each passed all 62 test files and 623 tests, plus actual tarball installation, entry-point checks, emitted consumer types and failure/cancellation behavior. Linux/Windows execution remains for remote CI.

Node 26.13.0 coverage: statements 85.09%, branches 76.68%, functions 89.40%, lines 87.26%, above existing thresholds. Build, source/consumer types, lint, formatting, documentation links, release metadata and diff whitespace checks passed. Existing non-blocking lint warnings remain; no rules or thresholds were weakened.

Two independent read-only reviews covered request lifecycle and public API/release/documentation. Their findings (cancellation while waiting on audit, six manual-status documentation branches) were fixed and rechecked. HTTP failure and audit-wait cancellation regressions were observed failing before the fix and passing after it. Real loopback HTTP tests cover body deadlines and in-flight cancellation. The minimum Bun version requires closing the test listener before force-closing its connections.

No npm publication, Git push or live business OAuth call was performed. Local checks used installed dependencies; where pnpm 11 attempted dependency reinstallation, scripts were run with process-local pnpm_config_verify_deps_before_run=false. Project install configuration was unchanged; CI continues to install from the frozen lockfile.
