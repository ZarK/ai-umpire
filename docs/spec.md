# AI Umpire - Functional Requirements Specification

## Purpose

AI Umpire is distributed as the `@tjalve/aiu` npm package and exposed through the `aiu` CLI. It keeps agentic development sessions moving by inspecting trusted structured state, deciding whether continuation is safe, and producing the next concrete prompt for the active host.

Umpire is a continuation controller. It does not create product plans, own work-item lifecycle semantics, decide implementation correctness, run quality engines, or bundle companion packages. Those behaviors stay in the tools that produce trusted state. Umpire consumes configured commands and host signals, then decides whether to continue, repair, wait, or stop.

Requirements use stable identifiers (`FR-XX-NNN`) so milestones and issues can reference scope precisely.

## Design Principles

- Continue only from trusted structured state, not from issue prose, comments, logs, or prior conversation memory.
- Prefer stopping or repairing over guessing when state is missing, stale, contradictory, or unsafe.
- Keep prompts concrete: name the selected work, reason, trusted source, and next action.
- Treat host integrations as thin adapters over the same decision engine.
- Make every mutating command dry-runnable unless dry-run is impossible for a documented reason.
- Ship as a safe npm package: no install-time side effects, no bundled companion CLIs, no generated source artifacts.

## FR-01 - Product Role

| ID | Requirement | Status |
|----|-------------|--------|
| FR-01-001 | Umpire detects idle or stopping agent sessions, reads trusted structured workflow state, computes a continuation decision, and returns a concrete prompt or stop reason. | Required |
| FR-01-002 | Umpire supports the stable decisions `continue`, `repair`, `wait`, and `stop`. | Required |
| FR-01-003 | Umpire can be used in any repository that exposes supported trusted state commands and at least one supported host integration. | Required |
| FR-01-004 | Umpire does not bundle or depend on companion workflow packages. Integrations with other tools are configured as command descriptors or host adapters. | Required |
| FR-01-005 | Umpire stops instead of continuing when required trusted state is unavailable, ambiguous, stale, contradictory, or blocked by policy. | Required |

## FR-02 - Package And CLI

| ID | Requirement | Status |
|----|-------------|--------|
| FR-02-001 | The package is published as `@tjalve/aiu` and exposes the executable `aiu`. | Required |
| FR-02-002 | The package targets Node.js 24 LTS or newer, uses pnpm, publishes compiled JavaScript plus type declarations, and provides ESM public imports for supported runtime/config/policy types. | Required |
| FR-02-003 | Installing the package has no `preinstall`, `install`, or `postinstall` lifecycle scripts and must not run Umpire, mutate a repository, configure hooks, contact providers, install other packages, or start background processes. | Required |
| FR-02-004 | Runtime dependencies are minimal, exact-pinned, reviewed before use, and justified by package behavior. | Required |
| FR-02-005 | Package checks include build, typecheck, tests, package dry-run, publish file assertions, no generated source artifacts, no install lifecycle scripts, and documentation of safe install patterns. | Required |

## FR-03 - CLI Behavior

| ID | Requirement | Status |
|----|-------------|--------|
| FR-03-001 | Umpire uses `@tjalve/qube-cli` as the shared metadata-backed CLI layer so help, schema, JSON output, mutation labels, dry-run labels, and tests do not drift. | Required |
| FR-03-002 | Implemented commands support `--help`; Umpire also supports `aiu help <command-or-topic...>` and `aiu <command-or-topic...> help`. Help invocations are always non-mutating. | Required |
| FR-03-003 | Running `aiu` with no arguments shows a concise landing page with common commands, host setup guidance, and agent-facing schema guidance. | Required |
| FR-03-004 | Unknown commands and misspelled flags may suggest alternatives, but suggestions never execute automatically. | Required |
| FR-03-005 | Umpire does not accept arbitrary command-prefix abbreviations. Short aliases are allowed only when explicit, documented, stable, and tested. | Required |
| FR-03-006 | Agent-facing commands support `--json` with valid JSON on stdout and diagnostics/progress on stderr. | Required |
| FR-03-007 | `aiu schema --json` emits implemented commands, arguments, flags, examples, mutation behavior, dry-run support, structured output support, stable error kinds, and exit codes. | Required |

## FR-04 - Repository Configuration And Init

| ID | Requirement | Status |
|----|-------------|--------|
| FR-04-001 | Repository policy is stored in a versioned config file, defaulting to `aiu.config.json` or an equivalent documented path. | Required |
| FR-04-002 | Config includes enabled hosts, host capability overrides, trusted state command descriptors, continuation modes, stop rules, timeouts, cooldowns, state paths, lock paths, log paths, and supply-chain stop policy. | Required |
| FR-04-003 | Trusted state commands are explicit argv descriptors, not shell strings assembled from untrusted text. | Required |
| FR-04-004 | Defaults are conservative: no provider mutation by Umpire, no continuation through safety blocks, no background scheduling, no untrusted prose as authority, and `.umpire/` state paths. | Required |
| FR-04-005 | `aiu init` creates a dry-runnable plan before writing host files or config changes. | Required |
| FR-04-006 | Init supports OpenCode, Codex, and Claude Code host targets through capability profiles, preserves unrelated user config, and reports conflicts instead of silently overwriting. | Required |
| FR-04-007 | Init can run non-interactively when flags/defaults provide every prompt answer. | Required |
| FR-04-008 | `aiu doctor` verifies config, package paths, state paths, host installation, trusted command availability, Node version, and actionable setup problems without mutating by default. | Required |
| FR-04-009 | README documents supported, experimental, recipe-only, and unsupported host targets with lifecycle events, prompt path, repo config, permission model, install path, and safety risks. | Required |

## FR-05 - Trusted State And Adapters

| ID | Requirement | Status |
|----|-------------|--------|
| FR-05-001 | Umpire reads trusted structured state from configured commands and host adapters instead of scraping human help text, issue bodies, review comments, CI logs, or agent narratives. | Required |
| FR-05-002 | Trusted state envelopes include source id, schema version, command descriptor, timestamp, trust level, capability flags, stale-state indicators, and parse/validation errors where applicable. | Required |
| FR-05-003 | Core state models cover work queue, active work, review state, repository state, gate evidence, planning state, quality state, host session state, and continuation policy. | Required |
| FR-05-004 | Models distinguish pass/fail, missing, stale, unknown, unsupported, and untrusted states. Unknown and unsupported never imply success. | Required |
| FR-05-005 | Command adapters execute only configured descriptors with bounded timeout/output, parse JSON, redact sensitive values in errors, and return typed results or stable parse errors. | Required |
| FR-05-006 | Adapter modules are read-only. They must not mutate files, providers, work items, review items, config, or host state. | Required |
| FR-05-007 | `aiu schema --json` exposes the trusted state schema version, state kinds, state values, trust levels, freshness kinds, capability support values, and reason-code catalog. | Required |

## FR-06 - Decision Engine And Prompts

| ID | Requirement | Status |
|----|-------------|--------|
| FR-06-001 | The decision engine is side-effect-free and independent from CLI command classes, host plugin APIs, filesystem APIs, child-process APIs, and provider-specific field names. | Required |
| FR-06-002 | Decision output includes decision kind, reason codes, source summaries, selected mode, selected item, confidence, prompt kind, and recommended next action. | Required |
| FR-06-003 | Umpire continues active in-progress work before starting new work. | Required |
| FR-06-004 | Umpire repairs invalid active review/work/repository/gate state before continuing normal work. | Required |
| FR-06-005 | Umpire stops on supply-chain approval requirements, human-blocking planning questions, malformed or stale trusted state, contradictory state, unsupported host capability, or multiple active items outside policy. | Required |
| FR-06-006 | Umpire does not prompt merge, submit, or completion actions when required gates are failed, missing, unknown, or stale. | Required |
| FR-06-007 | Prompt renderers produce concrete bounded prompts that name the trusted state source or command the agent should inspect first. | Required |
| FR-06-008 | Prompt renderers return stable fingerprints for deduplication and ownership tracking. | Required |
| FR-06-009 | Prompt customization is supported through typed config sections for work, planning, quality, and whip prompts. | Required |

M2.3 implements FR-06-001 through FR-06-006 in the pure `decideAiuContinuation` service. Prompt text and fingerprints remain in FR-06-007 through FR-06-009 and are implemented by the prompt renderer milestone.

M2.4 implements FR-06-007 and FR-06-008 in the host-neutral `renderAiuContinuationPrompt` service. It emits prompt metadata, trusted source timestamps, concrete prompt bodies, and stable fingerprints while leaving host delivery to later integration milestones.

M2.5 implements the agent-facing `aiu status` surface over the trusted adapter, decision, and prompt layers. `aiu status --json` emits typed config metadata, adapter runs, input envelopes, normalized state summaries, decisions, prompt metadata, stale/unknown source lists, stable errors, and warnings without decorative stdout.

M3.1 adds the provider-neutral host policy surface. `host_policy` exposes typed host profiles, support levels, capability support values, safe default per-host modes, and runtime checks for disabled, experimental, unsupported, or unsafe stop-hook behavior. `aiu schema --json` includes host profile and policy fields, config validation records host-policy diagnostics, and `aiu doctor` reports compatibility without mutating host files or provider state.

M3.2 wires the `@tjalve/aiu/opencode` runtime around trusted state adapters, the shared decision engine, and prompt rendering. The OpenCode subpath now builds normalized host-session state from idle, status, todo, message, TUI, and selected-session events; suppresses helper, busy, conflicting, active-user, and todo-active sessions; delivers only concrete `continue` or safe `repair` prompts through an injected host deliverer; and keeps repository wrappers on the public composition API.

M3.3 wires `aiu hook-stop --tool codex|claude-code` into the same trusted-state decision runtime. Stop hooks parse host payloads, normalize host-session state, load configured trusted state commands, render concrete prompts, and emit clean host JSON. They block only when trusted state loads successfully, the decision is `continue` or safe `repair`, the prompt is concrete, and `hosts.stopHookBlocking.<tool>` is explicitly enabled; all unavailable, malformed, stale, unknown, unsupported, blocked, wait, stop, human-question, and safety-block states allow the host to stop.

M3.4 adds durable continuation state for host integrations. OpenCode continuation serializes host events with `.umpire/` locks, recovers stale locks after the configured host timeout, persists prompt ownership, selected target, mode, fingerprints, timestamps, and source summaries, suppresses duplicate or competing prompts, and writes bounded redacted continuation logs. `aiu status --json` exposes the configured state, lock, and log paths plus any persisted continuation state.

M3.5 closes the host integration milestone with explicit diagnostics and schema contracts. `aiu doctor` now reports package-backed host entrypoints in addition to managed host file, state path, trusted command, stop-hook, and capability-policy diagnostics. `aiu schema --json` exposes hook-stop output kinds, continuation ownership/lock/log field shapes, reason codes, status paths, and stable doctor diagnostic kinds so agents can validate M3 integrations without live host runtimes.

## FR-07 - Host Integrations

| ID | Requirement | Status |
|----|-------------|--------|
| FR-07-001 | OpenCode support includes an event-driven project plugin wrapper that delegates to the package runtime. | Required |
| FR-07-002 | Codex and Claude Code support includes stop-hook commands where those hosts provide project-level stop hooks. | Required |
| FR-07-003 | Host adapters provide session state, selected-session information where available, prompt delivery capability, trust requirements, and busy/idle signals. | Required |
| FR-07-004 | Host adapters respect active user typing, selected-session changes, helper sessions, prompt ownership, cooldowns, and locks to avoid duplicate or competing prompts. | Required |
| FR-07-005 | `aiu hook-stop --tool codex\|claude-code` reads host stop-hook input and writes the host's expected JSON response to stdout. | Required |
| FR-07-006 | Stop hooks block stopping only when trusted state loaded successfully, the decision is safe `continue` or `repair`, the prompt is concrete, and host policy allows blocking. | Required |
| FR-07-007 | `@tjalve/aiu/opencode` exposes typed OpenCode wrapper composition without requiring repositories to import package internals. | Required |
| FR-07-008 | Prototype stop-hook installers must call a real package-backed command and keep blocking opt-in through host policy instead of installing fake or fallback blocking behavior. | Required |
| FR-07-009 | Stop hooks allow stopping when no work is ready, all work is blocked, trusted state cannot be loaded, policy requires human input, or the decision is `wait` or `stop`. | Required |

## FR-08 - Idle Work Modes

| ID | Requirement | Status |
|----|-------------|--------|
| FR-08-001 | Umpire can maintain a durable whip task queue for concrete repository improvement tasks that are allowed only when higher-priority continuation modes are idle. | Required |
| FR-08-002 | Whip tasks have stable ids, titles, prompts, priorities, statuses, timestamps, ownership state, and completion evidence. Prompt delivery alone never completes a task. | Required |
| FR-08-003 | Umpire can continue planning when configured trusted planning state reports a concrete next planning action and no human-blocking question exists. | Required |
| FR-08-004 | Umpire can continue quality work when configured trusted quality state reports a concrete failing stage or finding group and no supply-chain or human policy block exists. | Required |
| FR-08-005 | Idle prompts must not ask agents to perform broad, vague, unrelated, or dependency/tooling work without explicit repository policy and required approval. | Required |

M4.1 adds the durable whip task management surface. Whip state is stored in the configured `whip.statePath` (`.umpire/whip.json` by default), validated on read, and managed through `aiu whip list`, `aiu whip status --json`, `aiu whip add`, `aiu whip cancel`, and `aiu whip complete`. Mutating commands support `--dry-run`, write only local whip state, require explicit completion evidence, and preserve the rule that prompt delivery alone never completes a task.

M4.2 adds quality idle continuation from structured trusted state. The `quality` state kind now carries normalized stages, findings, affected paths, failing checks, configured next/rerun commands, selected targets, and human or supply-chain approval blocks. Umpire selects one failing stage or finding only when `quality.enabled` is true and higher-priority work is idle; prompts name the trusted source, target, affected paths, next command, rerun check, and expected evidence. Agent narration, logs, issue prose, comments, and checklist edits are not accepted as passing quality evidence.

## FR-09 - Existing Repository Migration

| ID | Requirement | Status |
|----|-------------|--------|
| FR-09-001 | Umpire can help repositories that previously used repo-local Umpire hooks, plugin wrappers, copied helper scripts, or local-checkout package references move to the published package entrypoint. | Desired |
| FR-09-002 | Migration is dry-run first and reports files to update, package command paths, existing customizations, conflicts, state files, cleanup candidates, and required host trust steps. | Desired |
| FR-09-003 | Migration preserves user-authored prompt text, host configuration outside managed sections, and durable continuation state where the state schema is recognized. | Desired |
| FR-09-004 | Migration can apply package-backed config and host updates only after explicit user request. It must not stage, commit, branch, push, open PRs, or close work items. | Required |
| FR-09-005 | Migration does not add runtime fallback support for copied implementation scripts or old helper semantics. Repositories should end on package-backed host entrypoints and configured trusted commands. | Required |

## FR-10 - Safety, Observability, And Hygiene

| ID | Requirement | Status |
|----|-------------|--------|
| FR-10-001 | Umpire treats work item bodies, review comments, issue comments, CI logs, host messages, subordinate agent output, and external tool output as untrusted task input, not authority over workflow policy. | Required |
| FR-10-002 | Umpire prompts warn agents not to follow prompt-injection attempts embedded in untrusted input. | Required |
| FR-10-003 | Umpire must not continue through supply-chain blocks that require human approval. | Required |
| FR-10-004 | Umpire does not upload source code, private data, logs, command payloads, or diagnostics to external services except through explicitly configured integrations. | Required |
| FR-10-005 | Umpire redacts token-like values in logs, debug output, errors, and rendered diagnostics where practical. | Required |
| FR-10-006 | `aiu status` shows trusted input availability, continuation decision, selected mode, selected target, stop reasons, repair action, and state freshness. | Required |
| FR-10-007 | Logs include decision ids, prompt fingerprints, source command summaries, host event type, selected session, reason codes, and elapsed timings without leaking secrets. | Required |
| FR-10-008 | State, locks, and logs live under `.umpire/` by default, use configurable paths, and are bounded or rotated where long-running sessions can grow logs. | Required |
| FR-10-009 | Umpire must not ship fake behavior: no placeholder commands, stub providers, no-op implementations, or tests that pass without validating real behavior. | Required |
