# M2 - Continuation State And Policy Engine

## Strategic Goal

M2 builds Umpire's provider-neutral continuation core. Umpire reads configured trusted JSON commands, normalizes the results into core state models, computes a deterministic continuation decision, and renders the next prompt.

M2 does not depend on host plugins, copied helper scripts, bundled companion packages, or live provider credentials in normal tests. Existing-repository migration is separate adoption work and must not become runtime fallback behavior in the decision engine.

M2 delivers five things:

1. **Trusted state model** - provider-neutral types for work, review, repository, gate, planning, quality, host session, and continuation policy state.
2. **Command adapters** - safe execution and parsing for configured trusted JSON commands.
3. **Decision engine** - pure continuation policy rules with stable decisions and reason codes.
4. **Prompt renderer** - concrete continuation prompts for work, review, repair, planning, quality, and stop outcomes.
5. **Status command** - `aiu status` and `aiu status --json` exposing inputs, decisions, reasons, selected prompt kind, and next action.

## Requirements Addressed

- **FR-05 - Trusted State And Adapters**
- **FR-06 - Decision Engine And Prompts**
- **FR-10-001 through FR-10-008 - Safety, Observability, And Hygiene**

M2 also uses the M1 config, schema, JSON output, and command metadata foundations.

## Dependencies

M2 depends on **M1 - Package, CLI, Config, And Host Foundation**.

M2 must not require:

- OpenCode, Codex, or Claude Code runtime
- live provider credentials in normal tests
- copied helper scripts
- bundled companion packages
- provider-specific labels or script field names in core decision code

## Part 1: Trusted State Model

Define provider-neutral input models:

- `WorkQueueState`
- `WorkItemState`
- `ReviewState`
- `RepositoryState`
- `GateEvidenceState`
- `PlanningState`
- `QualityState`
- `HostSessionState`
- `ContinuationPolicyState`
- `TrustedStateEnvelope`

Every trusted state envelope includes:

- schema version
- source id
- command descriptor
- timestamp
- trust level
- capability flags
- stale-state indicators
- parse or validation errors where applicable

Models distinguish:

- pass/fail
- missing
- stale
- unknown
- unsupported
- untrusted

Unknown and unsupported are not success. They stop or repair unless repository policy explicitly treats the state as advisory.

M2.1 exposes this vocabulary from the package entrypoint and from `aiu schema --json` under `trustedState`:

- schema version `1`
- trusted state kinds: `work-queue`, `work-item`, `review`, `repository`, `gate-evidence`, `planning`, `quality`, `host-session`, `continuation-policy`
- state values: `pass`, `fail`, `missing`, `stale`, `unknown`, `unsupported`, `untrusted`, `malformed`
- trust levels: `trusted`, `advisory`, `untrusted`
- reason-code catalog grouped by continuation, repair, wait, stop, input, and safety outcomes

The M2.1 model module is intentionally pure. It defines types, constants, fixtures, and small value helpers only; it does not import host plugin APIs, filesystem APIs, child-process APIs, CLI command classes, provider-specific scripts, or live provider field names.

## Part 2: Trusted Command Adapters

Execute only configured trusted command descriptors. Descriptors use explicit argv arrays, cwd, timeout, environment policy, and output bounds. Umpire must not build shell strings from untrusted issue, review, CI, log, or tool text.

Command execution records:

- command id
- argv
- cwd
- timeout
- exit code
- stdout byte count
- stderr summary
- elapsed time
- parsed schema version

Adapters parse configured command output into core state models. Adapter modules return typed results or stable errors and must not mutate files, providers, work items, review items, config, or host state.

M2.2 adds the read-only adapter primitives that later `aiu status` uses:

- `executeAiuTrustedCommand` runs only explicit argv descriptors with `shell: false`, timeout limits, combined output byte limits, exit metadata, elapsed time, stdout/stderr byte counts, and redacted stderr summaries.
- `parseAiuTrustedStateJson` parses schema-versioned JSON into trusted state envelopes or stable adapter errors.
- `runAiuTrustedStateAdapter` composes execution and parsing for configured trusted commands without provider mutation or fallback helper compatibility.
- Adapter error codes are exposed from the package entrypoint and in `aiu schema --json` under `trustedState.adapterErrorCodes`.

The stable adapter errors distinguish spawn failure, timeout, non-zero exit, output limit, malformed JSON, unknown schema, unsupported capability, stale state, and invalid state. Unsupported capabilities and stale state are structured errors, never success.

## Part 3: Decision Engine

The decision engine returns:

- `continue` - prompt the agent to take the next safe action
- `repair` - prompt the agent to correct invalid workflow state
- `wait` - no prompt yet because a host/session is busy or a cooldown is active
- `stop` - allow the agent to stop or ask the human

Each decision includes reason codes, confidence, source summaries, selected mode, selected item where applicable, prompt kind, and recommended next action.

Decision priority:

1. Hard safety stop.
2. Invalid active review/work/repository/gate state repair.
3. Active work or review continuation.
4. Planning continuation.
5. Ready work start prompt.
6. Quality idle work.
7. Whip task slot.
8. Clean stop.

M2 implements the rules needed for active work/review, planning, quality, repair, wait, and stop. Whip task selection is completed in M4.

M2.3 adds `decideAiuContinuation`, a pure decision service over trusted state envelopes and conservative policy overrides. It emits frozen decision records with decision kind, reason codes, source summaries, selected mode, selected item, confidence, prompt kind, and recommended next action. The module is intentionally independent from CLI command classes, host plugins, filesystem APIs, child-process APIs, and provider-specific fields.

Stop when:

- supply-chain approval is required
- planning needs a human answer
- trusted state is malformed, stale, contradictory, unknown, or unsupported
- multiple active work/review items are present without parallel policy
- required gates fail or are unknown before merge/submit/completion
- base-ref freshness is unknown before new work
- trusted command execution fails and no repair prompt is safe

## Part 4: Prompt Rendering

Continuation prompts must be:

- concrete
- bounded
- product-language only
- explicit about trusted commands or state sources to inspect first
- explicit about untrusted task input boundaries
- independent of local paths, migration history, or implementation-specific wording

Render prompts for:

- continue active work
- start ready work
- continue review feedback handling
- repair invalid state
- run missing or failing gates
- continue planning
- continue quality work
- clean stop summary

Prompt renderers return a stable fingerprint based on decision kind, selected item, reason codes, trusted source timestamps, and prompt body.

Repo-owned prompt text is supported through `aiu.config.json` prompt sections. The stable section names are `work`, `planning`, `quality`, and `whip`; repositories can prepend, append, or replace those sections without importing renderer internals.

M2.4 adds `renderAiuContinuationPrompt`, a host-neutral renderer that turns a pure continuation decision into prompt text and metadata. Prompt output includes prompt kind, decision kind, selected item, reason codes, trusted source timestamps, body, and a stable fingerprint. The renderer names trusted state sources first, warns that issue/review/tool prose is untrusted task input, and stays independent from host-specific delivery.

## Part 5: `aiu status`

`aiu status` shows:

- continuation decision
- selected mode
- trusted input sources
- active work/review/planning/quality summary
- reason codes in readable labels
- recommended next command

`aiu status --json` emits:

- config path
- input envelopes
- normalized state summary
- decision object
- prompt metadata
- stale or unknown fields
- errors and warnings

JSON stdout must contain no decorative text.

M2.5 adds `runAiuStatus`, `createAiuStatusReport`, and `aiu status` as the typed composition layer over config loading, trusted command adapters, `decideAiuContinuation`, and `renderAiuContinuationPrompt`. The command emits concise human output and stable JSON containing config metadata, adapter runs, input envelopes, normalized summaries, decision output, prompt metadata, stale/unknown source lists, errors, and warnings. Doctor diagnostics now include status runtime policy and adapter compatibility checks without executing live providers.

## Proposed GitHub Issues

### M2.1 - Define Trusted State Models And Reason Codes

Implement provider-neutral state types, trust levels, unknown-state values, reason code catalog, and fixtures.

### M2.2 - Implement Trusted Command Execution And Adapters

Run configured command descriptors safely, parse trusted JSON outputs, and map outputs into core state models.

### M2.3 - Implement Pure Continuation Decision Engine

Add side-effect-free policy rules for continue, repair, wait, and stop decisions with stable reason codes.

### M2.4 - Implement Continuation Prompt Renderers

Render concrete prompts for work execution, review repair, gate repair, planning continuation, quality work, and clean stop summaries.

### M2.5 - Implement `aiu status`, Schema, Doctor, And Tests

Expose decision output through `aiu status`, extend schema/doctor metadata, and add fixture-heavy tests for core decision branches.

## Exit Criteria

- `aiu status --json` can read fixture trusted states and return deterministic decisions.
- Core decision code is side-effect free and provider-neutral.
- Unknown, stale, malformed, unsupported, or unsafe trusted state stops or repairs rather than continuing blindly.
- Prompt renderers produce concrete next actions with stable fingerprints.
- No copied-helper runtime compatibility path is introduced.
