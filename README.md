# AI Umpire

`@tjalve/aiu` provides the `aiu` CLI and runtime foundation for safe agent continuation. It is being built to read configured trusted state commands, evaluate continuation policy, and wire supported host tools to package-backed Umpire entrypoints.

## What It Ships

- a package-backed `aiu` CLI
- shared CLI metadata, help, schema, and JSON behavior through `@tjalve/qube-cli`
- package metadata for the `@tjalve/aiu` npm package
- a package-backed `aiu` executable
- TypeScript source, build, typecheck, test, and package dry-run checks
- a minimal `aiu paths` command for package asset inspection

It does not bundle companion CLIs or keep copied helper scripts as a runtime fallback path. Repositories configure trusted commands explicitly.

## Install

```bash
pnpm add -D --save-exact --ignore-scripts @tjalve/aiu
```

System requirements:

- Node.js 24+
- pnpm for development and documented local workflows
- host tool trust/enablement for project hooks where required

Install companion tools separately only when repository policy uses their commands as trusted state inputs.

## Quick Start

Inspect package paths:

```bash
pnpm exec aiu paths
pnpm exec aiu paths --json
pnpm exec aiu schema --json
```

Run release checks:

```bash
pnpm run release:check
```

Host init, doctor, schema, status, and stop-hook commands are planned package functionality. They should be added only as real commands with tests and dry-run behavior where applicable.

## Package Surfaces

- `@tjalve/aiu` - public package asset helpers
- `aiu` - package CLI foundation

## Development

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm test
pnpm run typecheck
pnpm run pack:dry-run
pnpm run release:check
pnpm exec aiu --help
```

## Planning Specs

- [Functional requirements](docs/spec.md)
- [M1 - Package, CLI, Config, And Host Foundation](docs/M1-package-cli-config-and-host-foundation.md)
- [M2 - Continuation State And Policy Engine](docs/M2-continuation-state-and-policy-engine.md)
- [M3 - Provider Status Integration And Stop Hooks](docs/M3-provider-status-integration-and-stop-hooks.md)
- [M4 - Whip Tasks, Quality Idle Work, And Planning Continuation](docs/M4-whip-tasks-quality-idle-work-and-planning-continuation.md)
- [M5 - Existing Repository Migration And Release Readiness](docs/M5-migration-release-readiness-and-provider-architecture.md)

## Publish Checklist

Before public publish:

- authenticate to npm as the account that owns the `@tjalve` scope
- confirm the package version
- keep the working tree clean so the tarball matches git
- make the GitHub repo public, then enable branch protection or rulesets for `main`
- configure the `npm-publish` environment with required reviewers
- configure npm trusted publishing for the `Publish` workflow

Release flow:

```bash
pnpm run release:check
git tag v0.1.0
git push origin main v0.1.0
```

The tagged release workflow publishes with npm provenance:

```bash
pnpm publish --access public --provenance
```
