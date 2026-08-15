# 03 · Output Contract

> The unified output format is agent-cli-sdk's most central data structure. All stdout output must be success output, and all stderr errors must be error output. This document defines their exact fields, stability guarantees, and the stdout/stderr allocation rules. **Both agents and implementers must obey this contract.**

---

## Why a Unified Output Format

A world without a unified output format: every command dumps JSON however it likes, fields are inconsistent, and agents can't parse reliably. With a unified output format:

- **Agents use the `ok` field to tell success from failure** — no guessing
- **wire-stable fields** (`type`/`subtype`) let agents write stable branching logic
- **Pagination/notification metadata** has a fixed location (`meta`) and doesn't pollute business data (`data`)
- **stdout/stderr separation**: success goes to stdout (consumable by pipes), errors go to stderr (won't pollute the pipe)

The design borrows lark-cli's RFC 7807-aligned error output + success output pattern. See `00-overview.md`.

---

## Naming Convention: snake_case on the Wire, camelCase in Code

**The unified output format is a wire format (JSON on the wire), and all field names are snake_case**: e.g. `next_token`, `missing_scopes`, `dry_run`. This follows JSON/wire convention (lark-cli and most REST APIs do this), and agents and shell tools (jq) read values by snake_case.

**TS code uses camelCase**: `meta.pagination.nextToken`, `err.missingScopes`. When agent-cli-sdk serializes a command's `run` return value (`CommandResult`) into the unified output format, it **automatically converts camelCase to snake_case** when writing to the wire; business packages write code in camelCase without manual conversion.

> In other words: the field names in all JSON examples in this document are in wire form (snake_case); the field names in the TS code in `02-sdk-guide.md` are in code form (camelCase). The two correspond one-to-one, and agent-cli-sdk handles the conversion. Single words like `ok` / `data` / `meta` have no separators, so they are identical in both forms.

---

## Success Output (stdout)

On success, `run` returns `{ data, meta }` (see `02-sdk-guide.md`), and the framework wraps it into the unified output format written to **stdout**:

```json
{
  "ok": true,
  "identity": "user",
  "source": "orders",
  "data": { ... },
  "meta": {
    "count": 30,
    "pagination": { "complete": false, "pages": 1, "items": 30, "next_token": "abc" }
  },
  "dry_run": false
}
```

### Field Reference

| Field      | Required | Stability      | Description                                                                 |
| ---------- | :------: | -------------- | --------------------------------------------------------------------------- |
| `ok`       | ✅ required | **wire-stable** | Always `true` on success; agents branch on it                              |
| `identity` | ❌ optional | wire-stable     | Caller identity: `user` / `bot`. Omitted when no identity could be resolved |
| `source`   | ✅ required | wire-stable     | Source business namespace; written automatically when `defineCli` runs, for stable pipe routing |
| `data`     | ✅ required | informational   | Business data. `null` when the command has no data to output                |
| `meta`     | ❌ optional | mixed           | Metadata; see below                                                          |
| `dry_run`  | ❌ optional | wire-stable     | `true` indicates dry-run mode (request constructed but not sent). When present it is `true`; omitted for normal requests |

### meta Fields

`meta` carries metadata about this response and holds no business data:

| Subfield     | Type   | Description                                       |
| ------------ | ------ | ------------------------------------------------- |
| `count`      | number | Number of records returned this time (when `data` is an array) |
| `pagination` | object | Pagination info; see below                        |
| `rollback`   | string | Optional: rollback hint for write operations (e.g. "you can undo with xxx") |

> **Why is pagination in `meta` and not `data`?** Because "whether we've pulled everything" is not part of the business resource — it's state synthesized by the CLI. Putting it in `data` both pollutes the payload and forces callers to distinguish "API fields" from "CLI fields".

### pagination Sub-structure (Key)

```json
"pagination": {
  "complete": false,
  "pages": 1,
  "items": 30,
  "next_token": "abc123"
}
```

| Field        | Required | Description                                                                   |
| ------------ | :------: | ----------------------------------------------------------------------------- |
| `complete`   |    ✅    | **true means backend data has been fully pulled**; false means there is more. Agents branch on it to decide whether to keep pulling |
| `pages`      |    ❌    | Number of API pages included in this response (usually 1)                     |
| `items`      |    ❌    | Number of records included in this response (after command-layer filtering)   |
| `next_token` |    ❌    | Continuation cursor. Usually present when `complete:false`; omitted when `complete:true` |

**Business commands must fill `complete` and `next_token` faithfully** (decision checklist #9). See "Pagination implementation" in `02-sdk-guide.md`.

---

## Error Output (stderr)

On failure, output goes to **stderr** (note: not stdout!):

```json
{
  "ok": false,
  "identity": "user",
  "error": {
    "type": "authorization",
    "subtype": "missing_scope",
    "code": 99991679,
    "message": "missing scope `orders:read`",
    "hint": "run `rxcli auth login --scope orders:read` to log in again and obtain the permission",
    "retryable": false,
    "param": null,
    "missing_scopes": ["orders:read"]
  }
}
```

### How Errors Are Produced: throw → observeError/handleError Chain → Rendering

When a command or plugin `throw`s a typed error (`errs.*`), the error first enters the **observeError/handleError chain** (every plugin gets a pass, and can normalize/redact), and after the chain it is rendered as error output to stderr:

```
run / hook throw err
  ↓
Is err of type errs.*? → yes: go straight into the observeError/handleError chain
  ↓ no (bare Error, etc.): agent-cli-sdk wraps it as InternalError(unknown) and sends it into the observeError/handleError chain
observeError/handleError chain (pre→normal→post plugins, each runs; if unhandled return the original err, if handled return the new err)
  ↓
final err → render error output by Category → stderr + matching exit code
```

**Key: throw must use `errs.*` typed errors.** A bare `throw new Error('...')` gets fallback-treated as `internal/unknown` (exit 5), which agents will misread as an agent-cli-sdk bug. See `04-errors.md`.

### Top-Level Fields (Same as Success Output)

| Field      | Required | Stability      | Description                                                  |
| ---------- | :------: | -------------- | ------------------------------------------------------------ |
| `ok`       |    ✅    | **wire-stable** | Always `false` on error                                     |
| `identity` |    ❌    | wire-stable     | Caller identity (`user`/`bot`); omitted when unresolved. Same as success output |
| `error`    |    ✅    | mixed           | Error details object; see the table below                   |

### error Subfield Reference

| Field            | Required | Stability             | Description                                                                                      |
| ---------------- | :------: | --------------------- | ------------------------------------------------------------------------------------------------ |
| `type`           |    ✅    | **wire-stable**       | One of 9 Categories (see `04-errors.md`); agents can branch on it                                |
| `subtype`        |    ✅    | **wire-stable**       | Stable lowercase underscore identifier; agents can branch on it                                  |
| `code`           |    ❌    | wire-stable           | Upstream numeric code (e.g. HTTP status, API code). Omitted when zero                            |
| `message`        |    ✅    | **informational**     | Human-readable description, **stability not guaranteed**; agents must not branch on it           |
| `hint`           |    ❌    | informational         | **Executable recovery instruction for agents** (see `04-errors.md`)                              |
| `retryable`      |    ❌    | wire-stable           | When present and `true`, retryable; omitted when `false`                                         |
| `param`          |    ❌    | per-subtype-stable    | The offending parameter name (used by `ValidationError`), e.g. `"--limit"`                       |
| `params`         |    ❌    | per-subtype-stable    | Array of multi-parameter validation details (used by `ValidationError`)                          |
| extensions by subtype |    ❌    | per-subtype-stable | E.g. `missing_scopes` (array, machine-readable), `console_url`; appears only for the corresponding subtype, stable within that subtype |

### wire-stable vs informational (Key Distinction)

| Type                   | Meaning                   | Can agents branch on it?  |
| ---------------------- | ------------------------- | :-----------------------: |
| **wire-stable**        | Contract fields that don't change across versions | ✅ yes |
| **informational**      | For humans/hints, may change | ❌ don't branch |
| **per-subtype-stable** | Stable within the same subtype | ✅ yes (scoped to subtype) |

**Iron rule: an agent's branching logic may rely only on wire-stable fields (`ok`, `error.type`, `error.subtype`, `error.code`, `retryable`).** `message` is only for display to humans and may be rewritten across versions.

---

## stdout / stderr Allocation Rules

This is the root of why pipes compose, an **iron rule that must not be broken**:

| Content                       | Stream     | Written by                      |
| ----------------------------- | ---------- | ------------------------------- |
| Success output (`{ok:true,...}`)  | **stdout** | Framework serializes the `run` return value |
| Error output (`{ok:false,...}`)   | **stderr** | agent-cli-sdk error rendering layer |
| Logs (info/warn/error)        | **stderr** | `ctx.log.*()`                   |
| Progress bar / spinner        | **stderr** | agent-cli-sdk progress layer    |
| Hints (empty results, guidance) | **stderr** | agent-cli-sdk hint layer      |
| System notifications (e.g. version updates) | **stderr** | `createUpdateNotifier` |

**Business commands must never write non-unified-output content directly to stdout.** All non-data output goes through `ctx.log` (stderr). Otherwise `rxcli-orders list | jq` would get a stray "loading..." line mixed in and the whole pipe would break.

### Version Update Notifications

Version reminders are runtime environment information, not business data. Business packages can explicitly register `createUpdateNotifier`:

```ts
import { createUpdateNotifier, defineCliApp } from "@renxqoo/agent-cli-sdk";

const app = await defineCliApp({
  dir: appStateDir,
  plugins: [
    createUpdateNotifier({
      packageName: "@scope/my-cli",
      currentVersion: "1.2.0",
      updateCommand: "npm install -g @scope/my-cli",
    }),
  ],
  // ...
});
```

The check uses a cache-first, two-stage model: on every app run (successful runs only) it reads a local cache; when the cache expires, a detached background helper queries npm `latest` for use by subsequent runs. By default it checks once every 24 hours and reminds about the same update at most once every 24 hours; network or cache failures are silent and do not change the business result, exit code, or error output. It can be disabled with `NO_UPDATE_NOTIFIER=1`.

Only after the business command succeeds is the reminder written to stderr:

```xml
<system-message type="update-available">
  <package>my-cli</package>
  <current-version>1.2.0</current-version>
  <latest-version>1.3.0</latest-version>
  <action>npm install -g my-cli</action>
  <scope>Operational notice only; it is not business output.</scope>
</system-message>
```

A failed command does not append a system notification, so stderr can still be parsed as a single error JSON. The update command is only a suggestion: the Agent should first complete the current business task and then report to the user; unless the user has explicitly authorized it, it must not auto-install or upgrade. The legacy `_notice` serialization entry point is a low-level compatibility capability only, and runtime version notifications must not be written to stdout.

> **An explicit exception: `skills read`.** It dumps the raw SKILL.md text to stdout (non-unified-output format), for agents to read directly or concatenate in pipes. This is the output contract's **only** success-side exception (the error-side counterpart is `BareError`). Ordinary business commands must not imitate it and must still return the unified output format. See `01-cli-usage.md` / `06-skills.md`.

### Why Errors Also Go to stderr (Not stdout)

Because with `cmd | jq`, jq only reads stdout. If error output went to stdout:

- jq would receive the error JSON and treat it as data → agents misjudge
- the error output's structure differs from success output, so the jq expression would break

Errors go to stderr + a non-zero exit code; agents judge failure by the exit code, then read stderr for details. That way errors don't pollute the data stream in a pipe.

---

## The BareError Exception (Predicate Commands)

A few "predicate commands" (e.g. `auth check` to check whether logged in) already carry the complete answer (yes/no JSON) on stdout, so they only need the matching exit code and don't need the stderr unified output format. These use `BareError`:

```ts
// Predicate command: stdout already has the answer; only the exit code is wanted, no stderr unified output format
if (!loggedIn) throw new errs.BareError(3); // exit 3, no unified format written to stderr
```

`BareError` is the **only** type that bypasses the output contract, and it is only for the predicate scenario where "stdout is already the complete answer". Ordinary commands must not use it.

---

## Handling Empty Results

When a query returns 0 records:

```json
// stdout — a legitimate empty array, not an error
{ "ok": true, "data": [], "meta": { "count": 0, "pagination": { "complete": true } } }
```

**An empty result ≠ an error.** Exit code 0, stdout is the empty-array unified output format. Don't throw an empty result as an error (that would make agents think something went wrong).

Optional: agent-cli-sdk prints a one-line "(0 records)" hint to stderr for humans, but stdout stays clean.

---

## Pipe Records (PipeRecord): What Travels Through a Pipe

When a command is the upstream of a pipe, each record that the downstream reads from stdin out of the `run` return value (serialized by the framework) is a **PipeRecord**:

```json
{
  "type": "orders",
  "id": "o_1001",
  "data": { "total": 199, "status": "paid" },
  "meta": { "source": "rxcli-orders list" }
}
```

| Field  | Required | Description                                                                                                                          |
| ------ | :------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| `type` |    ✅    | Source business package namespace (e.g. `orders`); downstream routes by it (`if rec.type !== 'orders' continue`). `defineCli.name`, filled automatically by the framework during serialization |
| `id`   |    ❌    | Stable identifier. The **core of passing reference+ID through pipes** (decision checklist #11): pass redacted value+ID through the chain, and downstream correlates by ID rather than relying on specific field values. Each record is advised to carry an id when the command outputs an array |
| `data` |    ❌    | payload (already transformed by `transformOutput`)                                                                                    |
| `meta` |    ❌    | Optional metadata (source command, timestamp)                                                                                         |

> **Note: PipeRecord is the form the downstream reads via `ctx.pipe.in()`, not the stdout unified output format itself.** stdout is still a complete unified output format `{ok, data, meta}`; when data is an array, agent-cli-sdk wraps each record into a PipeRecord for downstream to consume one at a time. For a single-object command (data is not an array) in a pipe, the downstream receives a single `{type, id, data}`.

See "Pipe: as a downstream command" in `02-sdk-guide.md`.

---

## Why Use the Unified Output Model

A common traditional CLI pattern is a synchronous `console.log(JSON.stringify(body, null, 2))` with no notion of a unified output format. This framework instead uses the unified output model:

|              | Traditional console.log                   | Unified output model (`run` return value → framework serialization) |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| Output       | Raw JSON body, pretty-printed              | Unified output format `{ok, data, meta}`                              |
| Errors       | exitCode=1 + console.error message         | stderr error output + typed exit code                                 |
| Pagination   | None                                       | `meta.pagination`                                                     |
| Clean stdout | ❌ (pretty-printing has whitespace, pipes break easily) | ✅ (compact JSON)                                       |
| Agent can branch | ❌ (only a message string)              | ✅ (wire-stable type/subtype)                                         |

---

## The Output Contract's Stability Guarantees

- `ok`, `error.type`, `error.subtype`, `error.code`, `error.retryable` are **wire-stable** and don't change across major versions. Renaming them is a breaking change.
- The shape of `data` and `meta.pagination` is decided by the business command; agent-cli-sdk only guarantees that the three top-level keys `ok`/`data`/`meta` are stable.
- `message` / `hint` wording may improve; agents must not branch on specific text.
- Newly added top-level fields (e.g. a future `_deprecation`) use an underscore prefix to mark them as non-business fields, so older consumers can ignore them without error.

---

## The Standard Flow for an Agent to Parse the Unified Output Format

```python
# Pseudocode: an agent processing CLI output
result = run("rxcli-orders list")
if result.exit_code == 0:
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is True
    data = envelope["data"]            # business data
    pagination = envelope.get("meta", {}).get("pagination", {})
    if not pagination.get("complete", True):
        # there is more data; can keep pulling
        next_token = pagination.get("next_token")
else:
    error_envelope = json.loads(result.stderr)
    assert error_envelope["ok"] is False
    err = error_envelope["error"]
    # branch on type/subtype, not on message
    if err["type"] == "authentication":
        run(err["hint"])               # hint is an executable instruction
    elif err["type"] == "authorization" and err["subtype"] == "missing_scope":
        scopes = err["missing_scopes"]
        # guide the user to log in again to get the scope
```
