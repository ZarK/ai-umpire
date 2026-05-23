# M4 - Whip Tasks, Quality Idle Work, And Planning Continuation

## Strategic Goal

M4 expands Umpire beyond normal work-item continuation. When execution is idle, Umpire should be able to continue Bootstrap planning, run concrete Quality Control stages, or select a safe whip task without pretending that vague "make it better" prompts are useful work.

This milestone makes idle time productive while keeping safety blocks hard. Umpire should drive only concrete, trusted, externally checkable actions.

M4 delivers five things:

1. **Whip task queue** - durable task state, selection, ownership, and status transitions.
2. **Quality idle loop** - `aiq`-backed continuation for failing quality stages.
3. **Planning continuation** - Bootstrap automatic mode continuation from trusted planning state.
4. **Prompt modes** - clear prompts for quality, planning, and whip tasks.
5. **CLI management** - commands to inspect, add, cancel, and complete whip tasks safely.

---

## Functional Requirements Addressed

M4 is the primary implementation foundation for:

- **FR-08 - Idle Work Modes**
- **FR-08 - Idle Work Modes**
- **FR-06** priority rules for planning, quality, and whip task decisions
- **FR-10-003** supply-chain stop behavior during idle work

M4 also extends:

- **FR-05** trusted Quality Control and Bootstrap inputs.
- **FR-10** status, logs, and reason codes for non-execution continuation modes.

---

## Dependencies

M4 depends on:

- **M1 - Package, CLI, Config, And Host Foundation**
- **M2 - Continuation State And Policy Engine**
- **M3 - Provider Status Integration And Stop Hooks**

Required from earlier milestones:

- trusted state adapters
- decision engine
- host prompt delivery
- durable continuation state
- command metadata and schema

M4 must not require:

- companion packages to be installed unless repository policy enables commands that use them
- live provider access in normal tests
- Umpire-created broad issue batches
- dependency/tooling work without supply-chain policy checks

---

## Part 1: Whip Task Model

### 1.1 - Task Schema

Whip tasks include:

- id
- title
- prompt
- priority
- status
- created/updated timestamps
- source
- selected session ownership
- completion evidence
- cancellation reason

Task state is stored under `.umpire/whip.json` by default and validated on read.

Repositories can disable idle whip prompts with committed config:

```json
{
  "version": 1,
  "whip": {
    "enabled": false
  }
}
```

When disabled, existing `.umpire/whip.json` state is preserved and no whip prompt is enqueued. Repositories can replace package defaults with `whip.usePackageDefaults: false` plus a repo-owned `whip.tasks` list. Prompt delivery alone never completes a task; completion requires explicit task state transition evidence.

### 1.2 - Task Commands

Implement:

- `aiu whip list`
- `aiu whip add`
- `aiu whip cancel`
- `aiu whip complete`
- `aiu whip status --json`

Mutating commands support `--dry-run` where practical and never edit host state directly.

### 1.3 - Selection Rules

Umpire selects a whip task only after higher-priority continuation modes are unavailable:

- no active work item
- no active review item
- no required repair
- no Bootstrap planning step ready
- no Quality Control stage ready
- no safety block

Delivery of a prompt does not complete a task.

---

## Part 2: Quality Idle Work

### 2.1 - Quality State Adapter

Read configured configured quality status JSON. Normalize:

- stages
- findings
- affected paths
- trust level
- failing checks
- unknown states
- supply-chain findings

### 2.2 - Quality Continuation

When quality mode is enabled and idle, Umpire prompts the agent to:

- run the next configured quality command
- inspect structured findings
- fix one failing stage or finding group
- rerun the relevant check
- stop on supply-chain or human approval blocks

Umpire must not treat agent narration as passing evidence.

### 2.3 - Configured Gate Commands

When quality mode is enabled, Umpire can prompt configured deterministic gate commands as trusted quality inputs. It must not invent gate commands from issue or review prose.

---

## Part 3: Bootstrap Planning Continuation

### 3.1 - Planning State Adapter

Read Bootstrap planning state from a configured trusted command. Normalize:

- current phase
- known decisions
- unresolved questions
- draft paths
- generated artifact status
- provider creation status
- next planning action
- stop condition

### 3.2 - Planning Decisions

Umpire continues planning when Bootstrap reports a concrete next action and no human-blocking question exists.

Umpire stops when Bootstrap reports:

- unresolved product decision
- provider schema question
- ambiguous work item mapping
- artifact inconsistency requiring human judgment
- supply-chain approval block

### 3.3 - Planning Prompts

Planning prompts tell the agent to continue planning, not implementation. They should point to Bootstrap commands and artifact checks rather than asking the agent to start coding.

---

## Part 4: Decision Priority Integration

### 4.1 - Priority Order

Extend the M2 decision priority with:

1. Active work/review repair and continuation.
2. Bootstrap planning continuation.
3. Ready work start prompt.
4. Quality idle work.
5. Whip task prompt.
6. Clean stop.

### 4.2 - Stop Conditions

Quality, planning, and whip modes all respect the same hard stop rules:

- supply-chain approval required
- malformed trusted state
- unknown provider capabilities
- active work/review must be resolved first
- host cannot safely prompt

---

## Part 5: Doctor, Schema, Docs, And Tests

### 5.1 - Doctor

Doctor reports:

- whip state validity
- configured quality command availability
- configured planning command availability
- planning mode readiness
- quality idle mode readiness
- stale or orphaned task ownership

### 5.2 - Schema

Schema includes whip commands, task state shape, planning mode fields, quality mode fields, and new reason codes.

### 5.3 - Tests

Tests cover:

- task add/list/cancel/complete
- no auto-complete on prompt delivery
- stale pending task recovery
- quality stage continuation
- Bootstrap planning continuation and human-question stops
- priority order against active work/review states

---

## Proposed GitHub Issues

### M4.1 - Implement Whip Task State And CLI Commands

Add durable task state, commands, validation, dry-run support, JSON output, and task fixtures.

Status: implemented by the shared `whip` module and `aiu whip` command. Whip state is read from the configured `whip.statePath`, defaults to `.umpire/whip.json`, validates schema version and task records on read, and exposes stable JSON reports for list/status/add/cancel/complete. Mutating commands support `--dry-run`, write only local whip state, preserve disabled state without deleting tasks, reject unknown ids and invalid transitions, require explicit completion evidence, and surface stale prompted ownership in status output. Prompt delivery remains non-completing.

### M4.2 - Implement Quality Idle Continuation

Read Quality Control trusted state, select failing stages, render concrete prompts, and stop on unsafe findings.

### M4.3 - Implement Bootstrap Planning Continuation

Read Bootstrap planning state, continue concrete planning actions, and stop on human-blocking questions.

### M4.4 - Integrate Planning, Quality, And Whip Priority Into Decisions

Extend decision rules and host prompt delivery with the new continuation modes.

### M4.5 - Extend Doctor, Schema, README, And Tests

Document and test idle continuation modes without requiring companion packages in normal fixtures.

---

## Exit Criteria

- Umpire can make idle time productive through concrete trusted tasks.
- Planning continuation never invents missing product decisions.
- Quality continuation is based on real structured evidence.
- Whip tasks are durable and never auto-complete from prompt delivery alone.
