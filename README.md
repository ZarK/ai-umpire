# AI Umpire

`@tjalve/aiu` provides the `aiu` CLI and runtime foundation for safe agent continuation. It is being built to read configured trusted state commands, evaluate continuation policy, and wire supported host tools to package-backed Umpire entrypoints.

## What It Ships

- a package-backed `aiu` CLI
- shared CLI metadata, help, schema, and JSON behavior through `@tjalve/qube-cli`
- typed `aiu.config.json` discovery, defaults, and validation diagnostics
- dry-runnable `aiu init` plans for OpenCode, Codex, and Claude Code host files
- non-mutating `aiu doctor` diagnostics for package, config, host, state, and trusted command health
- package metadata for the `@tjalve/aiu` npm package
- a package-backed `aiu` executable
- TypeScript source, build, typecheck, test, and package dry-run checks
- `aiu paths` output for package, config, state, host, and trusted command paths

It does not bundle companion CLIs or keep copied helper scripts as a runtime fallback path. Repositories configure trusted commands explicitly.

## Human Install

```bash
pnpm add -D --save-exact --ignore-scripts @tjalve/aiu@0.0.0
```

System requirements:

- Node.js 24+
- pnpm for documented install and local development workflows
- host tool trust/enablement for project hooks where required by OpenCode, Codex, or Claude Code
- repository policy that allows explicit trusted state commands

Keep installs exact and lifecycle scripts disabled. Umpire does not require copied helper scripts, postinstall setup, or companion fallback packages. Install companion tools separately only when repository policy uses their commands as trusted state inputs.

Prefer the project-local executable after install:

```bash
pnpm exec aiu --help
pnpm exec aiu doctor --json
```

## Agent Install

Agents should use deterministic commands and inspect JSON before mutating repository files:

```bash
pnpm add -D --save-exact --ignore-scripts @tjalve/aiu@0.0.0
pnpm exec aiu doctor --json
pnpm exec aiu init --dry-run --json
```

Expected first-run signals:

- `aiu doctor --json` returns `ok: true` and may report `config-missing` until init is applied.
- `aiu init --dry-run --json` returns `command: "init"`, `init.dryRun: true`, `init.config.operation: "create"`, and planned host files without writing them.
- Existing host files that differ from package-managed content are reported as `conflict`; agents must not replace them unless `--force` is explicitly chosen after review.

## Quick Start

Inspect package paths:

```bash
pnpm exec aiu paths
pnpm exec aiu paths --json
pnpm exec aiu config --json
pnpm exec aiu doctor --json
pnpm exec aiu init --dry-run --json
pnpm exec aiu schema --json
```

If `aiu.config.json` is missing, Umpire reports typed conservative defaults. Configured trusted state commands use argv arrays instead of shell strings, and state, lock, and log paths default under `.umpire/`.

`aiu init` defaults to `--tool all` and produces the same plan shape in dry-run and apply mode. Existing managed files that differ are reported as conflicts unless `--force` is provided explicitly. Init writes only these managed assets:

- `aiu.config.json`
- `.opencode/plugins/ai-umpire-continuation.ts`
- `.codex/hooks/ai-umpire-stop.json`
- `.claude/hooks/ai-umpire-stop.json`

Apply a reviewed init plan:

```bash
pnpm exec aiu init --tool all
pnpm exec aiu doctor
```

After init writes host files, review and enable the host-specific trust step named in the init output. OpenCode, Codex, and Claude Code integrations delegate to the package-backed `aiu` command; Umpire does not install fallback scripts.

Review generated assets with normal git tooling before trusting host hooks:

```bash
git diff -- aiu.config.json .opencode .codex .claude
pnpm exec aiu doctor --json
```

Revert an uncommitted init with:

```bash
git restore -- aiu.config.json .opencode .codex .claude
```

Remove untracked init files only after reviewing `git status --short`; Umpire never stages, commits, pushes, or deletes repository files for you.

## Migration

Existing repositories that used repo-local Umpire hooks, copied helper scripts, or local-checkout references should inspect migration first:

```bash
pnpm exec aiu migrate --dry-run --json
```

The migration plan is expected to report repo-local hook wrappers, local-checkout command paths, managed sections, customization points, conflicts, cleanup candidates, state preservation, and required host trust steps before any apply step. Runtime fallback behavior is not supported: migrated repositories should point host integrations at the package-backed `aiu` executable and keep custom policy in `aiu.config.json` or host-owned files outside package-managed sections.

Package-owned managed sections are the files and content emitted by `aiu init` or future migration apply commands. Repo-local customization points are repository policy, trusted state command argv arrays, host trust settings, prompts outside managed sections, and durable `.umpire/` state. If package-owned content conflicts with local content, review the diff and choose an explicit apply or `--force` path only when replacement is intentional.

## Local Development

Run release checks:

```bash
pnpm run release:check
```

`aiu doctor` is read-only. It reports Node version, package metadata and built assets, repository/config health, host install files for enabled hosts, state path writability, and configured trusted command executable availability. It does not execute trusted commands.

## Troubleshooting

Use `pnpm exec aiu doctor --json` as the first diagnostic command. Stable check `kind` values identify setup problems such as `config-missing`, `config-invalid`, `host-file-missing`, `state-path-not-writable`, and `trusted-command-missing`.

Use `pnpm exec aiu paths --json` to inspect the resolved package root, config path, `.umpire/` state paths, host install paths, and trusted command executable paths. Diagnostic output redacts token-like values where practical.

## Package Surfaces

- `@tjalve/aiu` - public package asset helpers
- `aiu` - package CLI foundation
- `loadAiuConfig` - typed config discovery, defaults, and validation
- `runAiuDoctor` and `getAiuResolvedPaths` - read-only diagnostics and path inspection helpers

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
- [Release controls](docs/release-controls.md)

## Publish Checklist

Repository controls before public publish:

- the repository is public only after release controls are enabled
- `main` is protected by GitHub branch protection or a ruleset
- `main` requires signed commits, PR review, CODEOWNERS review, and the `release-check` CI status
- force pushes and branch deletion are disabled for `main`
- GitHub secret scanning and push protection are enabled
- `.github/CODEOWNERS` owns release-sensitive files
- workflow permissions default to read-only
- the `npm-publish` environment requires explicit reviewer approval
- npm trusted publishing is configured for `ZarK/ai-umpire`, workflow `Publish`, environment `npm-publish`
- no long-lived `NPM_TOKEN` is required for the primary publish path

Before tagging:

- register the maintainer signing key with GitHub
- confirm a fresh signed test commit is shown as verified by GitHub
- confirm the package version
- keep the working tree clean so the tarball matches git
- authenticate to npm only for account/scope administration; publishing uses trusted publishing

Release flow:

```bash
pnpm run release:check
git tag v0.1.0
git push origin main v0.1.0
```

The tagged release workflow publishes with npm provenance from the protected `npm-publish` environment:

```bash
pnpm publish --access public --provenance --no-git-checks
```
