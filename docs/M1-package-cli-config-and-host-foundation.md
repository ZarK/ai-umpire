# M1 - Package, CLI, Config, And Host Foundation

## Strategic Goal

M1 turns the current repository into a safe `@tjalve/aiu` npm package with a real `aiu` CLI, versioned repository config, dry-runnable host installation, diagnostics, schema output, and release checks.

M1 is the foundation only. It does not implement continuation decisions, runtime migration of older helper semantics, or bundled companion tools.

M1 delivers five things:

1. **Package foundation** - package metadata, pnpm, Node 24 baseline, build/type/test/release scripts, publish surface, and no install-time side effects.
2. **CLI foundation** - metadata-backed help, schema, JSON output, exit codes, no-color behavior, and dry-run conventions.
3. **Config foundation** - `aiu.config.json` discovery, conservative defaults, validation, and typed diagnostics.
4. **Host install planner** - dry-runnable install plans for OpenCode, Codex, and Claude Code without silent overwrites.
5. **Diagnostics foundation** - `aiu doctor`, `aiu paths`, and `aiu schema --json` for humans, agents, and tests.

## Requirements Addressed

- **FR-02 - Package And CLI**
- **FR-03 - CLI Behavior**
- **FR-04 - Repository Configuration And Init**
- **FR-10-004 through FR-10-009 - Safety, Observability, And Hygiene**

M1 supports later host/runtime work by introducing config, command metadata, host capability descriptors, and package-safe install behavior.

## Dependencies

M1 has no project milestone dependencies.

M1 must not require:

- `jq`
- live provider credentials in normal tests
- bundled companion packages
- copied helper scripts for package behavior
- install lifecycle scripts
- background daemons, cron jobs, or user-level host configuration

## Part 1: Package Foundation

Implement package metadata for:

- package name `@tjalve/aiu`
- executable command `aiu`
- TypeScript source and compiled JavaScript output
- type declarations
- explicit npm `files`
- Node.js 24 or newer
- pnpm package manager metadata and checked-in lockfile

Installing the package must not execute Umpire, write repository files, configure hooks, mutate providers, install companion packages, or start background work.

Package scripts must run real checks or fail:

- `build`
- `typecheck`
- `test`
- package dry-run
- release check

## Part 2: CLI Foundation

Umpire uses `@tjalve/qube-cli` for shared command metadata, help rendering, runtime dispatch, schema output, JSON output conventions, and CLI contract testing. Umpire-owned modules keep command behavior, config policy, host planning, diagnostics, and all side effects.

M1 implements only real commands owned by M1:

- `aiu`
- `aiu help`
- `aiu schema`
- `aiu init`
- `aiu doctor`
- `aiu paths`

The CLI must support:

- `aiu --help`
- `aiu help <topic...>`
- `aiu <topic...> help`
- `aiu <command> --help`
- safe typo suggestions without automatic execution
- no arbitrary command-prefix abbreviation
- clean JSON stdout for `--json`

No future command may exist as an executable placeholder.

## Part 3: Config Foundation

Discover config from `aiu.config.json` at the repository root unless a command receives an explicit config path.

The initial schema covers:

- version
- enabled hosts
- host capability overrides
- trusted state command descriptors
- continuation modes
- stop rules
- timeout and cooldown values
- state, lock, and log paths
- supply-chain stop policy

Defaults are conservative:

- continue only from trusted structured state
- stop on unknown or unsafe state
- no shell command synthesis from untrusted text
- no background scheduling
- `.umpire/` for package state

Trusted state commands are represented as validated `argv` arrays. Runtime shell-string fallback, legacy helper modes, and generated shell command synthesis are not part of the config schema.

## Part 4: Host Install Planner

`aiu init` creates a plan before writing files. The plan includes:

- repository root
- selected hosts
- files to create or update
- existing files skipped
- conflicts
- required trust steps
- config changes
- recommended next command

`--dry-run --json` emits the same plan shape and writes nothing.

OpenCode installation writes a package-backed plugin wrapper. Codex and Claude Code installation write stop-hook configuration that calls the package-backed `aiu` command. Host files must be updated safely and preserve unrelated user-authored config.

Existing managed files that differ from planned content are conflicts by default. `--force` is required before init replaces them.

Prompts are TTY-only. Every prompt has a flag or config equivalent so non-interactive init is possible.

## Part 5: Doctor, Schema, Docs, And Tests

`aiu doctor` checks:

- Node version
- package metadata and asset paths
- repository root
- config validity
- host install files
- state path writability
- trusted command availability where configured

Doctor does not mutate by default.

`aiu schema --json` emits implemented command metadata, flags, arguments, examples, mutation behavior, dry-run support, JSON support, stable error kinds, exit codes, config schema version, and host capability names.

Tests cover package scripts, package files, help forms, JSON cleanliness, init dry-run plans, config validation, doctor diagnostics, and no install lifecycle scripts.

## Proposed GitHub Issues

### M1.1 - Establish Package Metadata, Build, Publish Surface, And Safety Checks

Implement package identity, pnpm, Node baseline, build/type/test/release scripts, publish file whitelist, and package safety tests.

### M1.2 - Implement Metadata-Backed CLI Help, Output, And Schema

Implement shared command metadata for root help, explicit help, suffix help, unknown-command suggestions, JSON output rules, and `aiu schema --json`.

### M1.3 - Implement `aiu.config.json` Discovery, Defaults, And Validation

Add typed config loading, conservative defaults, validation diagnostics, and fixtures for invalid config cases.

### M1.4 - Implement Dry-Runnable Host Init Planner

Implement safe host install planning and apply behavior for OpenCode, Codex, and Claude Code.

### M1.5 - Implement `aiu doctor`, Path Diagnostics, And Documentation

Add diagnostics for package assets, config, hosts, state paths, and trusted commands. Update README with safe install and init flows.

## Exit Criteria

- A fresh repository can install the package and run `aiu`, `aiu init --dry-run`, `aiu doctor`, `aiu paths`, and `aiu schema --json`.
- Host installation is explicit, dry-runnable, and non-destructive.
- Agents have a stable machine-readable CLI schema.
- The package has no install-time side effects and no executable placeholders.
