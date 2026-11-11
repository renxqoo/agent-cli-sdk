# Changelog

All notable changes to this project are documented in this file.

The format follows the conventions described in `CONTRIBUTING.md`: every release pull request updates the affected package version explicitly and adds a matching heading here, of the form:

```text
## [@scope/package@1.2.3] - YYYY-MM-DD
```

Record public API changes, user-visible behavior, breaking changes, and migration instructions under that heading.

## Unreleased

### Changed

- Runtime baseline is Node.js 26+ and Bun 1.4+, with minimum-version and stable-release CI lanes.
- PluginFactory.setup creates application-scoped Plugin runtimes. setupPlugins returns the assembled runtime list.
- Credential identity is returned in the token snapshot. createOAuthRefresh requires the rejected OAuthSessionRef.
- ConfigStore.transactCredentials stages and atomically commits namespace-exclusive credential changes.
- SQLite transaction locks replace PID/TTL lockfiles and release ownership on process termination.
- Skill sync validates source/manifest boundaries, reuses source snapshots, preserves file permissions and skips unchanged targets.
- Route lookup uses the registry index. Repeated array flags append in linear time.
- Diagnostic errors avoid unparsed values, leading help cannot execute a command, and request observers receive defensive snapshots.

### Migration

- Removed mutable plugin assembly, unbound OAuth refresh, separate provider identity resolution, raw credential lock callbacks, stale-lock options and SkillFileStore injection.
- Consumer changes, stored credential handling and verification are described in [the runtime migration guide](docs/08-runtime-refactor.md).

## [@renxqoo/agent-cli-sdk@1.0.1] - 2026-08-16

### Changed

- **Skill authoring guidance (docs only)**: removed the shared `references/install.md` template-generation concept from `agent-cli-builder` skill references (Chinese and English). The recommended Skill structure no longer includes `install.md`, and the "generate repeated installation references from one template at build time" rule is gone.

### Removed

- Phantom `--check` generator flag mentions in `testing.md` and `skill-optimization.md` (both languages): `skills gen` only supports `--init`, `--force`, and `--lang`. Idempotency is now verified by running `skills gen` twice and confirming no diff.

## [@renxqoo/agent-cli-sdk@1.0.0] - 2026-08-15

Initial public release.

### Added

- **Core API**: `defineCli`, `defineCommand`, `defineAuth`, `definePlugin` for assembling agent-native CLIs from declarative specs (Zod schemas for command arguments and JSON input).
- **Unified output contract**: structured result envelopes (`data` / `errs` / `meta`) so AI agents can consume business data deterministically, with pretty rendering for humans.
- **Error model**: typed `errs` envelope with exit codes, subtypes, params, and hints; exported from `@renxqoo/agent-cli-sdk/errs`.
- **OAuth 2.1 flows**: authorization code + PKCE, device flow, QR-code login, token refresh, and session management.
- **Credentials**: pluggable credential providers and config store, exported from `@renxqoo/agent-cli-sdk/credentials`, with atomic writes and file locking.
- **Structured input**: `--input` / `--input-file` JSON ingestion with size limits, symlink rejection, and strict parsing.
- **Pipes**: composable pipeline stages for cross-command data flow.
- **Skills & progressive disclosure**: bundled `agent-cli-builder` skill, `skills gen` auto-generates agent-facing command documentation from command specs, `skills sync` distributes it to agent directories, exported from `@renxqoo/agent-cli-sdk/skills`.
- **Install wizard & workflows**: guided installation of CLIs and skills into agent environments.
- **Update notifier**: registry-aware update checks for published CLIs.

[1.0.0]: https://github.com/renxqoo/agent-cli-sdk/releases/tag/v1.0.0
