# Changelog

All notable changes to this project are documented in this file.

The format follows the conventions described in `CONTRIBUTING.md`: every release pull request updates the affected package version explicitly and adds a matching heading here, of the form:

```text
## [@scope/package@1.2.3] - YYYY-MM-DD
```

Record public API changes, user-visible behavior, breaking changes, and migration instructions under that heading.

## Unreleased

## [@renxqoo/agent-cli-sdk@2.0.0] - 2026-11-12

### Breaking

- Business HTTP 4xx/5xx now throw typed errors by default. Use per-request `allowHttpErrors: true` for explicit status inspection; final 401 remains an authentication failure.
- Runtime dispatchers, context/transport factories and pipe readers move from the root to `@renxqoo/agent-cli-sdk/advanced`. Skill utilities move to the existing `/skills` entry point. All documented entry points follow SemVer; unexported files are private.
- Business HTTP requests have a 30-second default per-attempt deadline, including body consumption. Configure `requestTimeoutMs` on the application or `timeout` on a request.
- This major release includes the runtime and public API migrations listed below. See [production contracts and migration](docs/09-production-contracts.md).

### Added

- Caller `AbortSignal` and request controls on all context HTTP methods, non-retryable `network/cancelled`, and fallback `api/http_error` classification.
- Release metadata validation against a Git base in CI, with matching versioned changelog entries and increasing SemVer requirements.
- Packaged-consumer checks for entry-point boundaries, request failure semantics and advanced composition.

### Fixed

- Skill sync rejects unavailable or incomplete sources before pruning published content (#3).
- OAuth grants, device authorization and revocation share public/confidential client authentication; Basic credentials form-encode each component before Base64 (#4, #5, #6).
- Repeated Skill generation preserves literal JavaScript replacement tokens in descriptions (#7).
- Structured input and ConfigStore reject unsafe integers in decimal and exponent notation (#8).
- Skill publication retains target-local undo data until the ownership manifest commits, and recovers interrupted publications before another source writes (#9).

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
