# M3 - Provider Status Integration And Stop Hooks

## Strategic Goal

M3 connects the M2 decision engine to real host integrations. OpenCode should receive safe event-driven continuation prompts, and Codex/Claude Code stop hooks should block stopping only when trusted state says there is clear work to continue.

This milestone wires the M2 decision engine into supported hosts. Older repo-local hooks are handled by migration tooling, not by runtime compatibility paths in the host adapters.

Repositories can compose OpenCode behavior through the public `@tjalve/aiu/opencode` subpath. Managed host files should stay package-owned; custom wrappers import `createAiuOpenCodePlugin` and compose before/after handlers around the package command delegate.

M3 delivers five things:

1. **OpenCode continuation adapter** - event-driven plugin integration around the M2 application service.
2. **Stop-hook integration** - `aiu hook-stop` for Codex and Claude Code using the same decision engine.
3. **Session ownership** - durable prompt ownership, deduplication, cooldowns, and lock coordination.
4. **Host capability model** - one capability profile system for OpenCode, Codex, and Claude Code.
5. **Host support matrix** - explicit supported, experimental, recipe-only, and unsupported target decisions so installers do not imply unverified hook semantics.
---

## Functional Requirements Addressed

M3 is the primary implementation foundation for:

- **FR-07 - Host Integrations**
- **FR-07 - Host Integrations**
- **FR-05** trusted state and host session inputs
- **FR-06-007 through FR-06-008** - prompt rendering and fingerprints
- **FR-10-006 through FR-10-008** - status, logs, fingerprints, state paths, and log bounds

M3 also extends:

- **FR-04** host installation with fully wired runtime behavior.
- **FR-07** host adapters as thin wrappers around core decisions.

---

## Dependencies

M3 depends on:

- **M1 - Package, CLI, Config, And Host Foundation**
- **M2 - Continuation State And Policy Engine**

Required from earlier milestones:

- config, doctor, schema, and host install planner
- trusted state command adapters
- decision engine and prompt renderer
- prompt fingerprint metadata

M3 must not require:

- live GitHub access in normal unit tests
- more than OpenCode, Codex, and Claude Code host support
- runtime fallback support for copied repo-local helper behavior
- direct provider mutation by Umpire

---

## Part 1: Host Capability Model

### 1.1 - Capability Profiles

Define host capability descriptors for:

- idle event support
- stop-hook support
- todo read support
- prompt delivery support
- selected-session awareness
- model/agent targeting
- user typing/TUI activity signals
- project trust requirements

OpenCode is the supported v1 host profile. Codex and Claude Code are experimental stop-hook installer targets because their project hook formats are known; they safe-allow by default and block only after trusted state selects a concrete continuation or repair prompt and explicit per-host blocking policy is enabled. Other evaluated tools remain recipe-only or unsupported until they expose a confirmed project-level idle/stop hook contract.

### 1.2 - Host Policy

Config can enable or disable continuation modes per host. If a host lacks a required capability for the selected continuation mode, Umpire stops with an actionable diagnostic.

M3.1 implements this as a package-level `host_policy` runtime surface. `getAllAiuHostCapabilityProfiles()` exposes the OpenCode, Codex, and Claude Code profiles; `evaluateAiuHostRuntimePolicy()` validates per-host `hosts.modes` against effective capability support and returns stable `host-mode-supported`, `host-capability-disabled`, `host-capability-experimental`, and `host-capability-unsupported` diagnostics. `aiu init` writes safe defaults: OpenCode receives `continue`, `repair`, `wait`, and `stop`; Codex and Claude Code receive `stop`, with stop-hook blocking still requiring explicit `hosts.stopHookBlocking` opt-in.

---

## Part 2: OpenCode Plugin Adapter

### 2.1 - Event Handling

The OpenCode plugin observes:

- session idle/status events
- todo updates
- message updates
- TUI prompt activity
- session selection activity

It should avoid prompting helper sessions, busy sessions, or sessions where the user is actively typing unless takeover policy permits it.

### 2.2 - Decision Flow

For each relevant event:

1. Build host session state.
2. Read trusted configured state.
3. Run the decision engine.
4. Check cooldowns, locks, and ownership.
5. Deliver a prompt only for `continue` or safe `repair` decisions.
6. Record prompt ownership and fingerprint.

### 2.3 - Todo Awareness

Todos are advisory host state, not the source of workflow truth. Umpire can use todo activity to avoid interrupting active work and to detect likely idle sessions, but trusted Executor/Bootstrap/Quality status controls continuation decisions.

---

## Part 3: Stop Hooks

### 3.1 - CLI Contract

`aiu hook-stop --tool codex|claude-code` reads the host stop-hook payload from stdin and emits the host's expected JSON object to stdout.

Stop-hook stderr is reserved for diagnostics only. JSON stdout must stay valid.

The command safe-allows unless the full stop-hook decision flow is available and explicitly enabled. Installers write package-backed commands, but blocking remains controlled by `hosts.stopHookBlocking` so host trust and project policy stay explicit.

### 3.2 - Block And Allow Rules

The stop hook returns a blocking continuation response only when:

- trusted state loaded successfully
- decision is `continue` or safe `repair`
- selected prompt is concrete
- host policy allows stop-hook blocking

It allows the stop when the queue is empty, work is blocked, planning needs a human, safety policy blocks continuation, trusted state fails to load, or the decision is `wait`/`stop`.

---

## Part 4: Durable State, Locks, And Logs

### 4.1 - State Files

Umpire uses `.umpire/` by default for:

- continuation state
- lock files
- continuation logs
Paths are configurable and surfaced by `aiu paths`, `aiu status --json`, and `aiu doctor`.

M3.4 implements this through a package continuation store that keeps state in `continuation.json`, the active host-event lock in `continuation.lock`, and bounded decision logs in `continuation.jsonl` under the configured state, lock, and log directories.

### 4.2 - Prompt Ownership

Continuation state records:

- owner session id
- last prompt fingerprint
- pending prompt fingerprint
- selected work/review/planning/quality item
- prompt target
- timestamps
- active mode
- trusted source summaries

### 4.3 - Locking

Host events are serialized with a lock. Stale locks are recoverable after a configured timeout and must be logged.

OpenCode continuation acquires the configured lock before trusted-state loading, decision-making, and prompt delivery. A live lock suppresses delivery with `lock-held`; a stale lock is recovered only after the configured host timeout and is logged without completing or discarding work.

### 4.4 - Logging

Logs include decision ids, reason codes, host event types, selected sessions, command summaries, and elapsed timings. Logs are capped or rotated according to config.

Decision logs include decision ids, reason codes, host event type, selected session, prompt fingerprint, trusted source summaries, adapter errors, suppressions, and elapsed timings. Log entries redact token-like values and rotate before the active log grows beyond the package cap.

---

## Part 5: Doctor, Schema, And Tests

### 5.1 - Doctor

Doctor verifies:

- host files are installed correctly
- configured trusted commands are runnable
- state paths are writable
- stop-hook command paths resolve to the local package binary
### 5.2 - Schema

Schema includes hook commands, host capability profiles, state file shapes, decision reason codes, and stop-hook output kinds.

### 5.3 - Tests

Tests cover:

- OpenCode idle prompt delivery
- no prompt while busy or user active
- prompt deduplication
- lock contention and stale lock recovery
- stop-hook block/allow/error paths
- JSON stdout cleanliness

## Part 6: Host Support Matrix

| Host | Support | Lifecycle Events | Prompt Path | Repo Config | Permission Model | Install Path | Safety Risks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode | supported | Project plugin idle/status, todo, message, TUI activity, and selected-session events. | Host plugin delivery through `@tjalve/aiu/opencode`; no stdout stop-hook path. | `hosts.enabled` includes `opencode`; managed wrapper at `.opencode/plugins/ai-umpire-continuation.ts`; modes default to `continue`, `repair`, `wait`, `stop`. | Requires explicit project plugin trust before OpenCode executes the wrapper. | `aiu init --tool opencode` writes the package-backed plugin wrapper. | Prompting the wrong session, duplicate prompts, and stale state are controlled by selected-session checks, durable ownership, cooldowns, locks, and trusted state validation. |
| Codex | experimental | Stop hook only; no verified project idle event contract. | Stdout block response from `pnpm exec aiu hook-stop --tool codex`. | `hosts.enabled` includes `codex`; `hosts.stopHookBlocking.codex` must be explicitly true before blocking; modes default to `stop`. | Requires repo-local plugin review and hook approval. | `aiu init --tool codex` writes `.agents/plugins/marketplace.json` and `plugins/ai-umpire/**` package-backed hook files. | Hook payload and host text are untrusted; malformed input, missing trusted state, adapter failures, or disabled blocking safe-allow stopping. |
| Claude Code | experimental | Stop hook only; no verified project idle event contract. | Stdout block response from `pnpm exec aiu hook-stop --tool claude-code`. | `hosts.enabled` includes `claude-code`; `hosts.stopHookBlocking.claude-code` must be explicitly true before blocking; modes default to `stop`. | Requires project settings hook review and approval. | `aiu init --tool claude-code` writes `.claude/settings.json` with the package-backed Stop hook command. | Hook payload and transcript-adjacent data are untrusted; malformed input, missing trusted state, adapter failures, or disabled blocking safe-allow stopping. |
| Other host tools | recipe-only or unsupported | No confirmed M3 project-level idle or stop hook contract. | None in package runtime. | Not accepted in `hosts.enabled`. | Requires a future verified integration design. | No installer output. | Umpire must not infer prompts or blocking from unverified host behavior or copied legacy helper scripts. |

M3.5 closes the milestone by making this matrix visible in documentation, exposing the same host capability and state shapes through `aiu schema --json`, and adding doctor diagnostics for package-backed host entrypoints.

---

## Proposed GitHub Issues

### M3.1 - Implement Host Capability Profiles And Runtime Policy

Add typed host capabilities, config validation, schema output, and doctor checks for OpenCode, Codex, and Claude Code.

Status: implemented by the shared `host_policy` module, schema host profile output, config/doctor host policy diagnostics, and fixture tests for supported, experimental, disabled, and unsafe stop-hook blocking states.

### M3.2 - Rework OpenCode Plugin Around The Decision Engine

Wire OpenCode events through trusted state collection, decision-making, prompt rendering, ownership, cooldowns, and prompt delivery.

Status: implemented by the `@tjalve/aiu/opencode` runtime delegate. It normalizes OpenCode host-session state, loads trusted state through configured adapters or an injected loader, runs the shared decision engine, renders prompt metadata and fingerprints, suppresses unsafe host sessions, and delivers prompts only through the package subpath's typed deliverer API.

### M3.3 - Implement Provider-Neutral Stop Hooks For Codex And Claude Code

Make `aiu hook stop` use M2 decisions.

Status: implemented by `aiu hook-stop --tool codex|claude-code`. The command parses host Stop hook JSON from stdin, loads configured trusted state commands, normalizes host-session state, runs the shared continuation decision engine, renders prompts, and emits clean host JSON. It blocks only for concrete `continue` or safe `repair` prompts when `hosts.stopHookBlocking.<tool>` is enabled; malformed hook input, config errors, trusted-state failures, unavailable state, active stop hooks, `wait`, and `stop` decisions all allow the host to stop with bounded redacted diagnostics on stderr.

### M3.4 - Implement Durable State, Locking, Logging, And Rotation

Add robust `.umpire/` state handling, stale lock recovery, log redaction, and log caps.

Status: implemented by the shared `continuation_store` module and OpenCode runtime integration. The runtime persists prompt ownership and fingerprints after successful delivery, suppresses duplicate or competing prompts, serializes host events with stale lock recovery, logs redacted bounded decision records, and exposes continuation state, lock, and log paths through `aiu status`.

### M3.5 - Extend Doctor, Schema, And Host Integration Tests

Add diagnostics and fixture-heavy host tests without requiring real host runtimes.

---

## Exit Criteria

- OpenCode continuation uses trusted state decisions, not GitHub-specific script parsing in core logic.
- Codex and Claude Code stop hooks block only for safe concrete continuation.
- Prompt ownership and locks prevent repeated or competing prompts.
- Host integrations remain thin adapters over the core decision engine.
