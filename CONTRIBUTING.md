# Contributing to rxcli

Thanks for helping improve rxcli and `@renxqoo/agent-cli-sdk`.

## Before opening a change

- Search existing issues and pull requests first.
- Keep changes focused. Public API changes must include motivation, migration notes, tests, and documentation.
- Do not add compatibility branches for an obsolete API unless the maintainers explicitly approve them.

## Local development

Requirements: Node.js 26+ or Bun 1.4+, with Node.js 26+ and pnpm 11 for build tooling.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm lint          # oxlint (.oxlintrc.json)
pnpm format:check  # oxfmt (.oxfmtrc.json); pnpm format rewrites files
pnpm docs:check
pnpm release:check --base HEAD
pnpm --filter @renxqoo/agent-cli-sdk test:package
```

Linting uses [oxlint](https://oxc.rs/docs/guide/usage/linter) and formatting uses [oxfmt](https://oxc.rs/docs/guide/usage/formatter). Git hooks are managed by [husky](https://github.com/typicode/husky): `pre-commit` runs lint and format checks, `pre-push` runs typecheck and tests. Hooks install automatically on `pnpm install`; to skip them for a throwaway commit use `git commit --no-verify`.

Tests should describe observable behavior. For a defect, first add a failing regression test, then implement the smallest coherent fix. Public types require positive and negative fixtures under `type-tests`; npm-facing changes require the package smoke test.

## Pull requests

Every pull request should explain:

- the user-visible problem and intended behavior;
- architecture or compatibility decisions;
- tests actually executed;
- documentation, Skill, or application migrations included.

Keep generated output and unrelated formatting out of the diff. The `main` branch is protected: every change merges through a pull request that passes CI. The CI matrix covers Ubuntu, macOS, and Windows on supported Node.js versions.

## Versions and changelog

Publishing never changes versions automatically. A release pull request must update each affected package version explicitly and add a matching root `CHANGELOG.md` heading:

```text
## [@scope/package@1.2.3] - YYYY-MM-DD
```

Record public API changes, user-visible behavior, breaking changes, and migration instructions. The release gate (`pnpm release:check --base <git-ref>`) validates SemVer, version increases, and one matching dated changelog entry. CI compares pull requests to their base SHA and main pushes to their previous SHA. Public API removals or changed default behavior require a major release and migration notes; the metadata gate does not infer every source-level breaking change.

By participating, you agree to follow `CODE_OF_CONDUCT.md`.
