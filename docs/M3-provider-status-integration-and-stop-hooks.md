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

OpenCode is the supported v1 host profile. Codex and Claude Code are experimental stop-hook installer targets because their project hook formats are known, but they must safe-allow stopping until the M2 decision engine is wired into M3 stop hooks. Other evaluated tools remain recipe-only or unsupported until they expose a confirmed project-level idle/stop hook contract.

### 1.2 - Host Policy

Config can enable or disable continuation modes per host. If a host lacks a required capability for the selected continuation mode, Umpire stops with an actionable diagnostic.

M3.1 implements this as a package-level `host_policy` runtime surface. `getAllAiuHostCapabilityProfiles()` exposes the OpenCode, Codex, and Claude Code profiles; `evaluateAiuHostRuntimePolicy()` validates per-host `hosts.modes` against effective capability support and returns stable `host-mode-supported`, `host-capability-disabled`, `host-capability-experimental`, and `host-capability-unsupported` diagnostics. `aiu init` writes safe defaults: OpenCode receives `continue`, `repair`, `wait`, and `stop`; Codex and Claude Code receive `stop` only until later M3 stop-hook blocking work is implemented.

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

The prototype command emits a valid allow response until the full M3 stop-hook decision flow exists; installers must not write host config that pretends continuation blocking is implemented earlier than it is.

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

### 4.2 - Prompt Ownership

Continuation state records:

- owner session id
- last prompt fingerprint
- pending prompt fingerprint
- selected work/review/planning/quality item
- prompt target
- timestamps
- active mode

### 4.3 - Locking

Host events are serialized with a lock. Stale locks are recoverable after a configured timeout and must be logged.

### 4.4 - Logging

Logs include decision ids, reason codes, host event types, selected sessions, command summaries, and elapsed timings. Logs are capped or rotated according to config.

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
---

## Proposed GitHub Issues

### M3.1 - Implement Host Capability Profiles And Runtime Policy

Add typed host capabilities, config validation, schema output, and doctor checks for OpenCode, Codex, and Claude Code.

Status: implemented by the shared `host_policy` module, schema host profile output, config/doctor host policy diagnostics, and fixture tests for supported, experimental, disabled, and unsafe stop-hook blocking states.

### M3.2 - Rework OpenCode Plugin Around The Decision Engine

Wire OpenCode events through trusted state collection, decision-making, prompt rendering, ownership, cooldowns, and prompt delivery.

### M3.3 - Implement Provider-Neutral Stop Hooks For Codex And Claude Code

Make `aiu hook stop` use M2 decisions.

### M3.4 - Implement Durable State, Locking, Logging, And Rotation

Add robust `.umpire/` state handling, stale lock recovery, log redaction, and log caps.

### M3.5 - Extend Doctor, Schema, And Host Integration Tests

Add diagnostics and fixture-heavy host tests without requiring real host runtimes.

---

## Exit Criteria

- OpenCode continuation uses trusted state decisions, not GitHub-specific script parsing in core logic.
- Codex and Claude Code stop hooks block only for safe concrete continuation.
- Prompt ownership and locks prevent repeated or competing prompts.
- Host integrations remain thin adapters over the core decision engine.
