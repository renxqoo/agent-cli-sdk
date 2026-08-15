# 06 · The skill system and automatic command-documentation generation

> A skill is a Markdown instruction document that an AI agent reads, teaching the agent "when to use" and "how to use" the commands of a given business package. This document defines: the skill reader (list/read/sync), the SKILL.md structure, the automatic command-documentation generation mechanism, and the signature generation rules. **Core idea: mechanical information (command signatures/parameters) is generated automatically, semantic information (when to use / error handling) is written by hand, and the two are separated by marker blocks.**

---

## Two kinds of information, produced separately

| Information type | Example                                                                         | Produced by                              |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| **Mechanical**   | Command signature, argument list, types, required, defaults, scope              | `defineCommands` **auto-generated**      |
| **Semantic**     | description (when to use / trigger), error handling, reference details, boundaries | Written by a human                       |

**Why separate them**: if the command table were hand-written, adding one parameter would require updating two places (SKILL.md + code) in sync, which is bound to drift. Mechanical information is generated from code, guaranteeing it always stays in sync; semantic information is written by hand, because only a business expert knows that "the user says 'query orders'" should map to which command.

---

## skill reader: list / read / sync

agent-cli-sdk provides a skill content reader (reusing the previous version's design, aligned with lark-cli's `skillcontent/reader.go`, with path-traversal validation). Agents use these commands for self-service discovery of capabilities:

### `skills list` — list all skills

```bash
$ rxcli skills list
{
  "ok": true,
  "data": [
    { "name": "orders", "description": "Query order list/detail", "version": "1.0.0" },
    { "name": "invoices", "description": "Invoice management", "version": "1.0.0" }
  ],
  "meta": { "count": 2 }
}
```

Scans the `skills/` directory bundled with all installed business packages and returns an aggregated result.

### `skills read <name>` — read skill content

```bash
$ rxcli skills read orders
# Dump the raw SKILL.md to stdout (for the agent to read)
```

> **`skills read` is an explicit exception to the output contract.** It dumps raw Markdown directly to stdout (**not** the `{ok,data,meta}` unified output format), because the consumer is an agent, and reading directly / concatenating in a pipeline (like `cat`) is the most natural. This is the **only** exception on the success-side output contract (the error side corresponds to `BareError`); ordinary business commands must not imitate it. See `03-envelopes.md` for details.

Supports reading sub-files: `rxcli skills read orders/references/orders-list.md`. Includes path-traversal validation (rejects `..` and absolute paths), aligned with lark-cli's `cleanSubPath`.

### `skills sync` — sync to installed agent scan directories (detection mode)

```bash
$ rxcli skills sync
Synced 5 skill(s) to 2 target(s):
  ✓ agents     /home/u/.agents/skills
  ✓ claude     /home/u/.claude/skills
  · codex      (not installed, skipped)
  · cursor     (not installed, skipped)
  · zcode      (not installed, skipped)
  · openclaw   (not installed, skipped)
  · pi         (not installed, skipped)
```

**Detection mode (default)**: `skills sync` only writes to the agent tool directories that the user has **actually installed**, avoiding creating a bunch of empty directories for users who have only 1-2 tools installed:

- **`~/.agents/skills` is always written** (the Agent Skills standard path, discoverable by any compatible tool, as a fallback)
- **Other tools** (`~/.claude`, `~/.codex`, etc.) are written to only when their parent directory already exists (= the user installed that tool)
- Uninstalled tools are recorded as `skipped`; no directory is created and it is not counted as a failure

After the user later installs a new tool, simply re-run `skills sync` to top it up. A single target's write failure (permission/disk) does not interrupt the rest; results are summarized at the end. This is the offline fallback; for online use, the install wizard of the `@renxqoo/cli` meta package is recommended (covers 30+ agent tools).

#### Built-in default target list (`DEFAULT_SKILL_TARGETS`)

| key        | Directory            | Tool                                    |
| ---------- | -------------------- | --------------------------------------- |
| `agents`   | `~/.agents/skills`   | Agent Skills standard (always written)  |
| `claude`   | `~/.claude/skills`   | Claude Code                             |
| `codex`    | `~/.codex/skills`    | OpenAI Codex                            |
| `cursor`   | `~/.cursor/skills`   | Cursor                                  |
| `zcode`    | `~/.zcode/skills`    | ZCode                                   |
| `openclaw` | `~/.openclaw/skills` | OpenClaw                                |
| `pi`       | `~/.pi/agent/skills` | Pi Coding Agent                         |

A business package can override this list via `defineCli({ skillsTargets })` — **when skillsTargets is configured, all specified directories are written unconditionally, without detection** (explicit specification by the business package = forced). See "Custom sync targets" below.

---

## SKILL.md structure

Each skill has its own directory, with `SKILL.md` as the entry point:

```
skills/orders/
├── SKILL.md                    Entry point (command table auto-generated + semantics hand-written)
└── references/                 Deep documentation (optional, hand-written)
    ├── orders-list.md
    └── orders-get.md
```

### SKILL.md template (skill-tpl)

```markdown
---
name: orders
description: Query order list/detail/update. Use when the user needs to query an order, view the order list, or look up the details of a specific order.
version: 1.0.0
metadata:
  requires:
    bins: ["rxcli-orders"]
  category: business
---

# orders

Order query and management. Supports list, detail, and status update.

<!-- AUTO-GEN:START commands -->
<!-- This block is auto-generated by `rxcli skills gen`; do not edit by hand -->

## Commands

| Operation           | Command                                                                        | Permission   |
| ------------------- | ------------------------------------------------------------------------------ | ------------ |
| List orders         | `rxcli-orders list [--limit <number>] [--offset <number>] [--status <string>]` | —            |
| Get order detail    | `rxcli-orders get <id>`                                                        | —            |
| Update order status | `rxcli-orders update <id> [--status <string>]`                                 | orders:write |

### Parameters

**list**

| Argument   | Type   | Required | Default | Description                  |
| ---------- | ------ | :--: | ---- | ----------------------------- |
| `--limit`  | number | No  | 30   | Maximum number of results     |
| `--offset` | number | No  | 0    | Offset                        |
| `--status` | string | No  | —    | Status filter: unpaid/paid/shipped |

**get**

| Argument | Type   | Required |
| -------- | ------ | :--: |
| `<id>`   | string | Yes |

**update**

| Argument   | Type   | Required |
| ---------- | ------ | :--: |
| `<id>`     | string | Yes |
| `--status` | string | No  |

<!-- AUTO-GEN:END -->

## Error handling

| Error                    | Handling                                         |
| ------------------------ | ------------------------------------------------ |
| `not_found` / exit 1     | Order not found; use `orders list` to look up a valid ID |
| exit 3 + `missing_scope` | Re-login to obtain scope; see error.hint         |
| exit 4 network error     | Retry later                                      |
```

### Key design: AUTO-GEN marker blocks (preserved regions)

```
<!-- AUTO-GEN:START commands -->
... auto-generated content ...
<!-- AUTO-GEN:END -->
```

- **Inside the marker block**: auto-generated, overwritten on every `gen`, **do not edit by hand**
- **Outside the marker block**: hand-written semantic content that `gen` **never touches**

This way you can re-run generation repeatedly (add a parameter to a command, re-gen), and the hand-written semantic content such as "Error handling" is never lost. This is a proven practice from swagger/openapi-codegen.

---

## Automatic documentation generation

### Generator input: structured information from `defineCommands`

The generator extracts the following mechanical information from the command definitions:

| Field             | Source                    | Where it lands in the docs                                  |
| ----------------- | ------------------------- | ----------------------------------------------------------- |
| `name`            | defineCommand.name        | The "Operation" column of the command table                 |
| `description`     | defineCommand.description | The command table's description                             |
| `args.*.type`     | Argument type             | The "Type" column of the argument table                     |
| `args.*.required` | Whether required          | The "Required" column of the argument table                 |
| `args.*.default`  | Default value             | The "Default" column of the argument table                  |
| `args.*.desc`     | **Optional** description  | The "Description" column of the argument table (— if not filled in) |
| `requiresScope`   | Required scope            | The "Permission" column of the command table                |

### Generation commands

Both entry points work (the business package bin or the rxcli main package):

```bash
# First time: generate the whole SKILL.md from skill-tpl (with {{FILL}} placeholders)
rxcli-orders skills gen orders --init      # business package bin
rxcli skills gen orders --init             # or via the rxcli main package

# Later: only refresh the AUTO-GEN marker block, preserving hand-written content
rxcli-orders skills gen orders

# --lang controls the skeleton language (English by default; use zh for Chinese projects)
rxcli-orders skills gen orders --init --lang zh
```

### Generation strategies A + B (both used, decision list #15)

| Strategy                    | Behavior                                                                                           | Command             |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| **A. Command doc fragment** | Generates only the `## Commands` + `### Parameters` sections, placed in the marker block           | `gen <name>` (incremental) |
| **B. Full skeleton**        | First time emits the whole SKILL.md (with `{{FILL}}` placeholders), later only refreshes the marker block | `gen <name> --init` |

The first `--init` uses B; later maintenance uses A. Both share the same marker-block mechanism.

## Command signature generation rules

Auto-generated signatures must be stable and predictable, otherwise the agent is prone to misread them. The rules (common conventions from commander/git/jq, decision list):

| Argument feature        | Signature form       | Example               |
| ----------------------- | -------------------- | --------------------- |
| required + positional   | `<name>`             | `get <id>`            |
| optional + positional   | `[<name>]`           | `[<offset>]`          |
| required + flag         | `--name <type>`      | `--status <string>`   |
| optional + flag         | `[--name <type>]`    | `[--limit <number>]`  |
| boolean flag            | `[--flag]`           | `[--json]`            |
| array flag (repeatable) | `[--name <type>...]` | `[--tag <string>...]` |

### Generation examples

```ts
// Command definition
list: defineCommand({
  args: {
    schema: z.object({
      limit: z.coerce.number().default(30),
      offset: z.coerce.number().default(0),
      status: z.string().optional(),
    }),
  },
})

// Generated signature
rxcli-orders list [--limit <number>] [--offset <number>] [--status <string>]
```

```ts
get: defineCommand({
  args: { schema: z.object({ id: z.string() }), pos: ['id'] },
})

// Generated signature
rxcli-orders get <id>
```

All auto-generated signatures are stylistically consistent, so both agents and humans can read them at a glance.

---

## Zod's `.describe()` (improving documentation quality)

Call `.describe()` directly on Zod fields; the description will flow into the generated documentation, and it shows `—` when not filled in:

```ts
args: {
  schema: z.object({
    limit: z.coerce.number().min(1).max(100).default(30).describe("Maximum number of results (1-100)"),
    status: z.enum(["unpaid", "paid", "shipped", "cancelled"])
      .describe("Order status")
      .optional(),
    force: z.boolean().default(false).describe("Skip confirmation"),
  }),
},
```

It is recommended to fill in `.describe()` for every business parameter; this is the text source for the auto-generated help and the Skill parameter documentation.

---

## Skill sync mechanism

The `skills/` directory bundled with the business package is made discoverable to agents in two ways:

### Method 1: `skills sync` (offline fallback, detection-based multi-target)

```bash
rxcli skills sync
# Copy every installed business package's skills/ to the user's installed agent tool discovery directories:
#   ~/.agents/skills (always written) + detected installed tool directories
#   (tools that are not installed get no empty directory created)
```

**Detection logic**: `~/.agents/skills` is always written (standard fallback); other targets (`~/.claude`, `~/.codex`, etc.) are written only when their parent directory already exists (= the user installed that tool). Thus a user who only has Claude Code installed will only get `~/.agents/skills` + `~/.claude/skills` written, without polluting other directories.

#### Custom sync targets (`defineCli({ skillsTargets })`)

The framework ships 7 default targets (see the `DEFAULT_SKILL_TARGETS` table above), which use detection by default. A business package can completely override them:

```ts
import { defineCli } from "@renxqoo/agent-cli-sdk";

defineCli({
  // …
  // Sync only to Claude Code and ZCode (overriding the default 7)
  // Note: once skillsTargets is set, [all specified directories are written unconditionally, without detection]
  skillsTargets: [
    { key: "claude", dir: "~/.claude/skills" },
    { key: "zcode", dir: "~/.zcode/skills" },
  ],
  // [] empty array → disable multi-target (only the install wizard's npx path takes effect)
});
```

`dir` supports the `~/` prefix (automatically expanded to the home directory) and also absolute paths.

> **Detection vs forced**: omit `skillsTargets` → detection mode (only write installed tools); set `skillsTargets` → forced mode (all directories in the list are written, no detection). A business package explicitly specifying the list = saying "I know what I want to install, don't detect for me."

### Method 2: the `@renxqoo/cli` install wizard (online, covers 30+ agent tools)

```bash
npx @renxqoo/cli install
# One-click install to the standard discovery paths of Claude Code / Cursor / Codex / ZCode and 30+ other tools
```

See the `@renxqoo/cli` meta package documentation (later stage).

---

## Skill frontmatter specification

```yaml
---
name: orders # skill name (required, must match the directory name)
description: One-line description of when to use # required; the agent relies on it to semantically match user intent
version: 1.0.0 # optional
metadata: # optional
  requires:
    bins: ["rxcli-orders"] # dependent bins
  category: business # category
  cliHelp: "rxcli-orders --help"
---
```

`description` is the key to the agent triggering a skill — at startup the agent matches user intent semantically against the description. So write clearly **when to use it**, not just **what it is**.

✅ Good description:

```
"Query order list/detail/update. Use when the user needs to query an order, view the order list, or look up the details of a specific order."
```

❌ Bad description (too abstract, hard for the agent to match):

```
"Order management tool"
```

---

## Path-traversal validation in the skill reader (security)

`skills read <name>/<path>` rejects path traversal (aligned with lark-cli's `cleanSubPath`):

```bash
$ rxcli skills read orders/../../../etc/passwd
# error: invalid path: must be a relative path without '..'
```

Validation rules:

- Reject absolute paths (`/etc/...`) and Windows absolute paths (`C:\...`)
- Reject paths containing `..` (checked after normalization)
- Only relative paths are allowed, confined within the skill directory

CLI arguments come from an untrusted agent, so paths must be validated before every file IO operation (aligned with lark-cli's AGENTS.md security spec).

---

## Complete workflow: developing a skill

```bash
# 1. Write commands (defineCommands, fill in desc for args)
# src/commands/orders.ts is already defined

# 2. Generate the SKILL.md skeleton for the first time
rxcli-orders skills gen orders --init
# → Generates skills/orders/SKILL.md, with an AUTO-GEN block (already filled) + {{FILL}} placeholders
# Chinese projects add --lang zh:
# rxcli-orders skills gen orders --init --lang zh

# 3. Edit SKILL.md and fill in the semantic parts (description trigger phrases, error handling)
vi skills/orders/SKILL.md

# 4. When commands change later (add a parameter / change scope), regenerate (only refreshes the AUTO-GEN block)
rxcli-orders skills gen orders
# → The semantic parts stay untouched, the mechanical parts are updated

# 5. Optional: add deep documentation
mkdir skills/orders/references
vi skills/orders/references/orders-list.md   # hand-written; gen does not touch it

# 6. Publish: skills/ ships with the package (package.json's files includes "skills")
```

---

## Relationship between skill and lark-cli

This framework's `skills/reader.ts` and lark-cli's `skillcontent/reader.go` are almost line-for-line identical (both do list/read + path validation + frontmatter parsing). We reuse this directly (already proven), adding only:

- **Automatic command-documentation generation** (new in this framework; lark-cli does it another way)
- **Cross-package skill aggregation** (handled by the business package; lark-cli is a monorepo)
