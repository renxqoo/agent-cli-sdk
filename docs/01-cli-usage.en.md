# 01 · Command usage manual

> For **terminal users and AI agents**. Explains how to invoke commands, how pipes compose, how pagination works, and how to read errors. This doc is the primary reference for an agent using the CLI.

---

## Installation

A business package is a standalone npm package, installed on demand:

```bash
# install one business package (it pulls in agent-cli-sdk automatically)
npm i -g @org/rxcli-orders

# install several
npm i -g @org/rxcli-orders @org/rxcli-invoices
```

After install there are two ways to invoke (same code — see `02-sdk-guide.md`):

```bash
rxcli-orders list              # standalone bin (shorter in pipes, recommended)
rxcli orders list              # after loading into the rxcli main package (needs @renxqoo/cli)
```

---

## Single-command usage (simple to complex)

### Level 1 — the simplest query

The default output is **unified JSON**, meant for agents to read:

```bash
$ rxcli-orders list
{"ok":true,"data":[{"id":"o_1001","total":199,"status":"paid"},...],"meta":{"count":2}}
```

Success is always `{ok:true, data:..., meta:...}` — see `03-envelopes.md`.

### Level 2 — server-side query params pass through

Params declared by a business command (e.g. `--limit`, `--status`) pass straight through to the backend:

```bash
rxcli-orders list --limit 5 --offset 10      # pagination (passes backend pagination params through)
rxcli-orders list --status unpaid            # business param (declared by the command itself)
rxcli-orders get o_1001                      # detail
```

> ⚠️ `--limit/--offset` are server-side pagination params, not local truncation. They affect how much data the backend queries.

### Level 3 — output for humans vs. for agents

Default is for agents (JSON). For a human reading it, switch to a table with `--no-json`:

```bash
$ rxcli-orders list --no-json
ID       TOTAL   STATUS
o_1001   ¥199    paid
o_1002   ¥89     shipped
```

**`--json` is the default** (`--no-json` turns it off). The rule: when `stdout` is a TTY, a human is watching — default table; when piped/redirected (the agent scenario), default JSON. Can be explicitly overridden with `--json`/`--no-json`.

---

## Local filtering, field selection, sorting — all to jq

agent-cli-sdk **does not provide** local filtering flags like `--filter` / `--fields` / `--sort`. The reason: `jq` / `sort` / `uniq` already do this well, and agents don't need to learn a new syntax.

```bash
# filter rows: jq select
rxcli-orders list | jq '.data[] | select(.status=="paid")'

# select fields
rxcli-orders list | jq '.data[] | {id, total}'

# just the value of one field
rxcli-orders list | jq -r '.data[].total'

# filter + extract + sort + dedupe (the full unix toolchain)
rxcli-orders list \
  | jq -r '.data[] | select(.status=="paid") | .total' \
  | sort -n \
  | uniq
```

**The principle: on the left, `rxcli` only produces data (passes the backend through + unified output format); on the right, all filtering/extraction/sorting is unix tools.** This is unix pipe philosophy, and the composition style agents know best.

> Which flags does agent-cli-sdk own, and what goes to jq? The criterion is decision items #12 and #13 in `00-overview.md`.
>
> - **server params** (affect the backend query): `--limit`/`--offset`/`--status` etc. → agent-cli-sdk owns them, because you can't reach the backend locally
> - **local data ops** (change stdout content): filtering/field selection/sorting → to jq
> - **output format** (unified serialization): JSON/table → agent-cli-sdk owns it, because it is bound to the output contract

---

## Pipe usage

### Basic pipe (2 levels)

A downstream command **auto-detects** whether it is in a pipe (by checking whether stdin is a TTY): when invoked in a pipe it reads upstream records from stdin, otherwise it uses argument mode. No flag needs to be declared:

```bash
# list unpaid orders → invoices generate auto-detects stdin has data, consumes it record by record
rxcli-orders list --status unpaid | rxcli-invoices generate
```

### Pipes pass references + IDs (the key mechanism)

**What travels through the pipe is a "redacted reference + a stable ID", not the full real data.** This is the balance point between "context hygiene" and "pipe composability" in an agent flow:

```bash
$ rxcli-orders list --status unpaid | rxcli-invoices generate
# upstream stdout (agent-visible): each record's ID + redacted fields
# {"ok":true,"data":{"id":"o_1001","customer":"[M:c1a2]","total":199},...}
#                                            ^^^^^^^^^^^ redacted, but id is usable
# the downstream joins on id; it doesn't need the customer's real name
```

Downstream command code (written by the developer):

```ts
async run(ctx, args) {
  for await (const rec of ctx.pipe.in()) {       // async-iterate upstream records
    await ctx.post('/invoices', { orderId: rec.id })
  }
}
```

### Multi-level pipe (chained)

```bash
# one business flow: large unpaid orders → look up customer → notify
rxcli-orders list --status unpaid \
  | jq '.data[] | select(.total > 1000)' \
  | rxcli-customers get \
  | rxcli-notifications send --template overdue
```

Any middle stage can insert `jq` for local processing. **Composition works across business packages too** (orders → customers → notifications), as long as they all obey the output contract.

### Pipe discipline (why it never breaks)

Pipes compose reliably because **stdout stays clean**:

| Stream     | Content                                                                      | Written by                                  |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| **stdout** | **only** unified JSON (success `{ok,data,meta}`; an empty array is still valid JSON) | agent-cli-sdk serializing the `run` return value |
| **stderr** | logs, progress, hints, warnings, error output                                | agent-cli-sdk's `ctx.log` + error rendering |

**Iron rule: a business command must never write non-unified-format content directly to stdout.** Everything non-data goes through `ctx.log` (stderr). Otherwise `rxcli-orders list | jq` would mix in a "loading..." line and the whole pipe is ruined.

See "stdout/stderr allocation rules" in `03-envelopes.md`.

---

## Pagination: the agent decides whether to continue

Backend data can be large, so agent-cli-sdk fetches one page by default, but tells you **completeness** and the **continuation cursor** in the `meta` of the unified output format:

```bash
$ rxcli-orders list --limit 30
{
  "ok": true,
  "data": [ /* 30 records */ ],
  "meta": {
    "count": 30,
    "pagination": {
      "complete": false,        # ← false means not done yet
      "pages": 1,               # pages fetched so far
      "items": 30,              # records fetched so far
      "next_token": "abc123"    # ← continuation cursor
    }
  }
}
```

**When the agent sees `complete:false`, it knows there is more** and can continue:

```bash
# fetch the next page (the exact flag name is defined by the business command, usually --page-token or --cursor)
rxcli-orders list --limit 30 --page-token abc123
```

**Why not auto-fetch everything?** Because some queries should not auto-pull 10,000 rows (slow, eats context). agent-cli-sdk gives the agent enough information (`complete` + `next_token`) to decide per scenario whether to continue — more realistic than "force stream everything".

> How does a business command implement the pagination protocol (telling agent-cli-sdk how to page)? See "Pagination implementation" in `02-sdk-guide.md`.

---

## Skill self-service discovery

Agent doesn't know what commands exist? Just ask the CLI:

```bash
# list all skills (each business package ships its own), returns the standard success output
$ rxcli skills list
{
  "ok": true,
  "data": [
    { "name": "orders", "description": "query order list / detail", "version": "1.0.0" },
    { "name": "invoices", "description": "invoice management", "version": "1.0.0" }
  ],
  "meta": { "count": 2 }
}

# read one skill's content (teaches the agent when and how to use it)
$ rxcli skills read orders
# dumps the SKILL.md source to stdout for the agent to read
```

> **`skills read` is an explicit exception to the output contract.** Every other success output is the `{ok,data,meta}` unified format, but `skills read` alone dumps raw Markdown to stdout — because the consumer is an agent, and direct reading/pipe concatenation (like `cat`) is more natural, with no need to deserialize. This mirrors the `BareError` exception on the error side (see `03-envelopes.md`). **Ordinary business commands must not imitate it** and still must return the unified format.

A skill is a Markdown instruction doc meant for an agent to read. Its "command table" part is auto-generated from `defineCommands`; the "when to use / error handling" part is hand-written by a business expert. See `06-skills.md`.

---

## Exit-code table

Agents judge success/failure by exit code, without parsing JSON:

| Code | Meaning                                            | What the agent should do                    |
| ---- | -------------------------------------------------- | ------------------------------------------- |
| 0    | success                                            | read stdout for data                        |
| 1    | generic server error (API returned non-2xx)        | read stderr's error.message, possibly retry |
| 2    | argument error (bad user input)                    | fix the flag, retry                          |
| 3    | auth/authorization/config error (not logged in / no scope / missing config) | guide the user to log in or fix config, see error.hint |
| 4    | network error (DNS/timeout/refused)                | retry later                                 |
| 5    | SDK internal error (shouldn't happen)              | report a bug                                |
| 6    | policy block (risk control / content safety)       | read error.hint                             |
| 10   | confirmation required (high-risk write needs --yes)| add --yes or let the user confirm           |

**Key: error output is on stderr, not stdout.** So `cmd | jq` won't receive error JSON even when the command fails (avoiding the agent mistaking errors for data). See `03-envelopes.md` and `04-errors.md`.

---

## How to read errors

When a command fails, stderr carries a structured error and the exit code is non-zero:

```bash
$ rxcli-orders get o_notexist
# stderr (not stdout):
{
  "ok": false,
  "error": {
    "type": "api",                    # ← wire-stable, agent can branch on it
    "subtype": "not_found",           # ← wire-stable, agent can branch on it
    "code": 404,                      # ← upstream HTTP code
    "message": "order o_notexist does not exist",  # ← for humans, not guaranteed stable
    "hint": "run rxcli-orders list to see valid order IDs"  # ← executable recovery instruction for the agent
  }
}
# exit code: 1
```

**The agent's handling flow:**

1. check the exit code (fast classification)
2. if needed, read stderr's `error.type` / `error.subtype` for precise branching
3. read `error.hint` for the next action (often a directly runnable command)

The `hint` field is the agent-friendly key — it is not a human explanation but an **executable instruction for the agent** (e.g. "run xxx to log in again"). See `04-errors.md`.

---

## Common composition cheat sheet

```bash
# query + filter + count
rxcli-orders list | jq '[.data[] | select(.status=="paid")] | length'

# query + cross-package join
rxcli-orders get o_1001 | jq '.data.customerId' | xargs rxcli-customers get

# batch operation (pipe + downstream command)
rxcli-orders list --status new | rxcli-orders tag --tag vip

# continue fetching everything (pagination stitching)
for token in "" "abc" "def"; do
  rxcli-orders list --page-token "$token" | jq '.data[]'
done

# debug: see the full request/response
rxcli-orders list --verbose 2>&1 | head
```

---

## Usage advice for agents

1. **Always start with `rxcli skills list`** to see what capabilities exist, then `rxcli skills read <name>` to learn usage.
2. **Get data from the stdout `data` field**; judge completeness via `meta.pagination.complete`.
3. **Judge success/failure by exit code**; for failure details read stderr's `error.type` + `error.hint`.
4. **Use jq for local filtering**; don't ask commands to support `--filter`.
5. **Join across pipes by ID**; don't rely on specific field values (they may be redacted).
6. **Dry-run before writes** (if the command supports `--dry-run`) and inspect the request body before confirming.
