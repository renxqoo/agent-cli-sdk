# 00 · Architecture overview

> This document is the design anchor for agent-cli-sdk. Every follow-up document (command usage, SDK guide, unified output format, errors, credentials, skills) defers to the global decisions here; the implementation must not deviate.

---

## One-line positioning

**`@renxqoo/agent-cli-sdk` is an agent-native CLI framework package: a business package depends on it and only declares "which backend endpoint to call and how to shape the fields", and in return gets the full set of capabilities — auth, redaction, unified output format, error classification, pipe composition, skill discovery, and more.**

The core tension it resolves is: **backend interfaces differ wildly (REST/GraphQL/RPC, OAuth/API-key/mTLS, every field-naming convention), but "how you hand data to an agent" is universal.** The framework leaves the former to the business package and converges the latter into framework capabilities.

---

## Design essentials

| Dimension        | Approach                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| Form             | **SDK framework**: agent-cli-sdk (this repo) + a standalone business npm |
| Business package | Someone writes a standalone npm package that depends on agent-cli-sdk    |
| Coding style     | **function style + config-object declaration** (defineCli/defineCommand) |
| Output           | **Unified output format** (success on stdout / error on stderr)          |
| Errors           | **9 typed error classes + exit-code mapping + structured output**        |
| Credentials      | **provider chain**, extensible to any auth scheme                       |
| Pipes            | **unix pipes**, pass references + IDs, local filtering to jq            |
| Hundreds of APIs | **split files and assemble** (group by business domain via namespaces)  |
| Skill            | **auto-generate command docs from defineCommands** + a human semantic zone |

---

## Three-layer architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  agent / terminal user                                            │
│  — compose commands with unix pipes                               │
│  — read skill self-service discovery commands                     │
│  — parse the stdout envelope for data, the stderr envelope for errors │
├──────────────────────────────────────────────────────────────────┤
│  business package (standalone npm, @org/rxcli-xxx)               │
│  — write function-style commands (defineCommand, <Args, Result>) │
│  — call ctx.get/post (no client layer)                           │
│  — write plugins (standard auth via defineAuth, special protocols │
│    compose base blocks)                                           │
│  — write SKILL.md (semantic part; command table auto-generated)  │
│  — all business knowledge lives here; the SDK knows no business  │
├──────────────────────────────────────────────────────────────────┤
│  @renxqoo/agent-cli-sdk (base package, maintained in this repo)  │
│  — ctx request methods (get/post/... with auth + 401 auto-refresh)│
│  — envelope: the unified success/error contract                   │
│  — error classification: 9 classes + exit codes + typed ctor      │
│  — auth: defineAuth standard factory + composable auth blocks     │
│  — plugin system: vite-style Plugin + 6 hooks + 3 enforce tiers   │
│  — pipes: PipeRecord type + stdin/stdout                          │
│  — skill: list/read/sync + command doc auto-generation            │
│  — config: ConfigStore (namespace-isolated credentials, per-package baseUrl) │
└──────────────────────────────────────────────────────────────────┘
```

**The key boundary: the SDK knows no business, and the business package knows no framework internals.** The contract surface between the two is `ctx` (the command runtime context) and the "unified output format".

---

## Three reference implementations

The design borrows from two industrial-grade CLIs, each for a different aspect:

| Reference                            | What we borrow                                                                                                                  | Why                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **mmx** (MiniMax CLI, TS)            | client capability reuse, shared SDK/CLI request layer, credential-resolution priority chain, exit-code system                   | SDK-form template for a single backend |
| **lark-cli** (Feishu CLI, Go)        | structured error output (RFC 7807), success output + pagination meta, provider chain, skill system, stdout/stderr discipline, command doc auto-generation | governance template for an agent-first CLI |
| **an earlier rxcli** (this author's) | device-flow login, 401 singleflight refresh, gateway middleware proxy, skill reader                                            | direct evolution base — migrate, don't reinvent |

**Note: we borrow the pattern, not the code.** lark-cli is Go, we are TS; mmx is a single-backend product, we are a framework. Every borrowed idea was adapted for a TS framework (see each topic doc).

---

## Repository structure

```
 agent-cli-sdk/
├── src/                         implementation (types/define/oauth/credentials/skills/qrcode/...)
├── docs/                        ★ design docs (this directory, shipped with the package)
├── skills/agent-cli-builder/    bundled skill: teaches an agent to build a CLI with this SDK
├── type-tests/                  type tests (tsconfig.type-tests.json)
├── scripts/                     package smoke test + doc link check
├── package.json                 this package (SDK, no bin; business packages depend on it)
├── tsup.config.ts               build (entry: index / errs / credentials / skills)
└── vitest.config.ts             test config
```

**Business-package integration (standalone npm):**

A business package is a **standalone npm package** that depends on `@renxqoo/agent-cli-sdk`; see `02-sdk-guide.md` for how it is loaded.

---

## Global decision checklist

This is the decision table finalized after the project discussion. **All subsequent docs and the implementation must obey it; changes require re-discussion.**

| #   | Dimension         | Decision                                                                                                                                        | See doc             |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | Architecture      | agent-cli-sdk standalone repo (SDK) + business package standalone npm                                                                           | this doc            |
| 2   | Loading           | standalone bin as primary + loadable as a subcommand by the rxcli main package                                                                  | `02-sdk-guide.md`   |
| 3   | Coding style      | **function style + config-object declaration** (no class inheritance)                                                                           | `02-sdk-guide.md`   |
| 4   | Requests          | **drop the client concept** (no createClient/Client); request methods `get/post/...` all live on `ctx`; auth belongs to SDK internals + auth plugins | `02-sdk-guide.md`   |
| 5   | transport         | low-level `ctx.request` + high-level convenience methods (`ctx.get` etc.); **REST first**                                                        | `02-sdk-guide.md`   |
| 6   | Cross-cutting     | **vite-style plugins** (hooks are the Plugin interface; defineCli takes `plugins: []`, no inline hooks)                                          | `02-sdk-guide.md`   |
| 7   | Errors            | typed errors + structured envelope to stderr + **9-class exit codes**; thrown into the observeError/handleError chain                            | `04-errors.md`      |
| 8   | Envelope          | success is also enveloped `{ok, data, meta}`; **stdout = data / stderr = everything**                                                            | `03-envelopes.md`   |
| 9   | Pagination        | envelope `meta.pagination` + `complete` + `nextToken`, **agent decides whether to continue**                                                     | `03-envelopes.md`   |
| 10  | Auth              | `defineAuth` covers standard OAuth/Bearer/API key/Basic; special protocols compose public Plugins and base blocks                                | `05-credentials.md` |
| 11  | Pipes             | unix pipes; **pass references + IDs**; local filtering to jq                                                                                     | `01-cli-usage.md`   |
| 12  | Filtering         | `--limit/--offset` pass through to the backend; `--filter`/field selection **to jq**                                                              | `01-cli-usage.md`   |
| 13  | Global flags      | `--json` + server-side query params; everything else to jq/sort                                                                                  | `01-cli-usage.md`   |
| 14  | Redaction         | not a feature in this version; to be implemented via the transformOutput plugin later                                                             | `02-sdk-guide.md`   |
| 15  | Skill             | list/read/sync + **auto-generate command docs from defineCommands**                                                                              | `06-skills.md`      |
| 16  | Tests             | vitest + `createTestCtx`                                                                                                                          | `02-sdk-guide.md`   |
| 17  | Types             | command three generics `<Args, Result, State>` + `defineCommands<State>`; strongly-typed `ctx.state`; optional request generic `ctx.get<T>()`      | `02-sdk-guide.md`   |
| 18  | Plugin hooks      | 6 of them: beforeCommand/beforeRequest/observeRequest/handleUnauthorized/transformOutput/handleError; **3 enforce tiers** (pre/normal/post); chained observeError/handleError | `02-sdk-guide.md`   |
| 19  | Not in this ver.  | resource() generator, write confirmation, OpenAPI auto-registration                                                                               | this doc            |

### The "why" behind a few decisions (short form; see topic docs)

- **function over class**: a framework scenario needs composition (pipes), tree-shaking (shipping npm), and easy testing (mock parameters); class inheritance is worse than function on all three.
- **drop the client**: a client conflates "request capability" with "business custom parameters"; attaching requests to `ctx` is more direct, auth goes to the auth plugin, business state goes to `ctx.state` (strongly typed). One fewer layer of indirection, one fewer source of confusion.
- **vite-style plugins over inline hooks**: a plugin is a standalone reusable module (can be published to npm); hooks are the plugin interface; inline needs become anonymous plugins. One unified extension mechanism avoids the "should this live in run or in a hook" confusion.
- **auth is still a Plugin**: `defineAuth` handles standard scenarios and returns an ordinary Plugin; special protocols can still compose the public boundaries — provider chain, context-keyed session, `injectAuthHeader`, and `handleUnauthorized` — without touching framework-private state.
- **three command generics**: like axios declaring request/response types — one command declares its argument, return, and state types clearly, and TS checks them all; progressive (omit generics → default `unknown`/`{}`), never forced.
- **strongly-typed `ctx.state`**: only accessible after declaring `defineCli<State>`; undeclared access errors. Structurally eliminates "stuffing things in" — it is not an open bag but a strongly-typed shared channel (data passed between plugins).
- **3 enforce tiers**: solves the "header-adder runs first, signer runs last" ordering problem (pre adds base params → normal does business → post signs at the end).
- **agent-decided pagination continuation**: never assume "must fetch everything"; give the agent `complete:false + nextToken` and let it decide per scenario whether to continue.
- **local filtering to jq**: the SDK does not reinvent jq. stdout is structured JSON; the filtering/field-selection/sorting on the right side all use the unix toolchain.
- **the stdout/stderr iron rule**: pipes compose only because stdout stays clean. Logs/progress/error hints all go to stderr — otherwise `rxcli a | jq` would mix in a "loading" line and the whole pipe is ruined.

---

## Doc index

| Doc                 | Audience                | Content                                                                                          |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `00-overview.md`    | everyone                | architecture, layering, decision checklist (this doc)                                            |
| `01-cli-usage.md`   | terminal users / agents | how to invoke commands, pipes, pagination, exit codes                                            |
| `02-sdk-guide.md`   | business-package devs   | how to write a business package, the ctx interface, **plugin system**, auth plugins, 3 generics |
| `03-envelopes.md`   | implementers / agents   | the field contract for success/error output                                                      |
| `04-errors.md`      | business-package devs   | 9 error classes, when to throw, hint, observeError/handleError chain                             |
| `05-credentials.md` | business-package devs   | **writing an auth Plugin** (provider chain / injectAuthHeader / oauth), provider chain, custom credentials |
| `06-skills.md`      | business-package devs   | skill system, command doc auto-generation                                                        |

> This directory ships bilingual docs: Chinese as `*.md`, English as `*.en.md` (the one exception is `07-structured-input.md`, which is the English original, plus `07-structured-input.zh-CN.md` as its Chinese version).

---

## Implementation status

Everything above is implemented (code, tests, bundled skill, docs). The decision checklist remains the authoritative constraint: later changes require re-discussion.
