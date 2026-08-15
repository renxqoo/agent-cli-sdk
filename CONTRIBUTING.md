# Contributing to rxcli

Thanks for helping improve rxcli and `@renxqoo/agent-cli-sdk`.

## Before opening a change

- Search existing issues and pull requests first.
- Use an issue for security-sensitive reports only as described in `SECURITY.md`.
- Keep changes focused. Public API changes must include motivation, migration notes, tests, and documentation.
- Do not add compatibility branches for an obsolete API unless the maintainers explicitly approve them.

## Local development

Requirements: Node.js 20 or 22 and pnpm 9.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm docs:check
pnpm --filter @renxqoo/agent-cli-sdk test:package
```

Tests should describe observable behavior. For a defect, first add a failing regression test, then implement the smallest coherent fix. Public types require positive and negative fixtures under `type-tests`; npm-facing changes require the package smoke test.

## Pull requests

Every pull request should explain:

- the user-visible problem and intended behavior;
- architecture or compatibility decisions;
- tests actually executed;
- documentation, Skill, or application migrations included.

Keep generated output and unrelated formatting out of the diff. The CI matrix covers Ubuntu, macOS, and Windows on supported Node.js versions.

## Versions and changelog

Publishing never changes versions automatically. A release pull request must update each affected package version explicitly and add a matching root `CHANGELOG.md` heading:

```text
## [@scope/package@1.2.3] - YYYY-MM-DD
```

Record public API changes, user-visible behavior, breaking changes, and migration instructions. The release gate rejects a package version change without its matching changelog entry.

By participating, you agree to follow `CODE_OF_CONDUCT.md`.
