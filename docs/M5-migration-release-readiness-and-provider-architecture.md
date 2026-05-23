# M5 - Existing Repository Migration And Release Readiness

## Strategic Goal

M5 makes Umpire ready for package adoption in real repositories. It provides a safe migration path for repositories that previously used repo-local Umpire hooks, copied helper scripts, or local-checkout package references, while keeping the Umpire runtime package clean and package-backed.

Migration is an adoption tool, not a runtime fallback system. After migration, repositories should call the published package entrypoints and configured trusted commands. Umpire must not keep old copied helper semantics alive inside the core runtime.

M5 delivers five things:

1. **Migration inventory** - detect repo-local hooks, plugin wrappers, copied helper scripts, local-checkout references, old stop-hook entries, prompt customizations, and `.umpire/` state.
2. **Migration planner** - dry-runnable plan for package-backed config, host updates, state preservation, cleanup candidates, and required confirmations.
3. **Migration apply** - explicit apply mode that updates managed sections and package-backed entrypoints without staging, committing, pushing, or deleting unknown files.
4. **Architecture finalization** - provider-neutral core, command adapters, host adapters, renderers, config, and support modules separated clearly.
5. **Release readiness** - package docs, publish workflows, pack safety tests, version policy, and no generated build output in source.

## Requirements Addressed

- **FR-09 - Existing Repository Migration**
- **FR-10 - Safety, Observability, And Hygiene**
- **FR-02 - Package And CLI**
- **FR-03 - CLI Behavior**
- **FR-04 - Repository Configuration And Init**

## Dependencies

M5 depends on:

- **M1 - Package, CLI, Config, And Host Foundation**
- **M2 - Continuation State And Policy Engine**
- **M3 - Provider Status Integration And Stop Hooks**
- **M4 - Whip Tasks, Quality Idle Work, And Planning Continuation**

M5 must not require:

- live provider credentials in normal tests
- keeping copied helper implementations after migration
- runtime compatibility adapters for old helper semantics
- automatic git commits, staging, branches, pushes, PRs, merges, or work-item closure
- deleting project-specific files without explicit confirmation

## Part 1: Migration Inventory

`aiu migrate` inspects the repository for:

- repo-local OpenCode plugin wrappers
- old Codex or Claude Code hook entries
- local-checkout imports or command paths pointing at an Umpire source tree
- copied helper scripts or command wrappers
- prompt customization files
- existing `aiu.config.json`
- `.umpire/` state
- host instructions that reference old local paths
- configured trusted state commands

Inventory output reports categories, paths, confidence, fingerprints, and required review. It does not describe source provenance or local reference repositories.

Cleanup candidates are conservative:

- known filenames
- known command signatures
- package wrapper imports
- recognized state schema versions
- exact fingerprints where available

Unknown files are marked `review-required` and preserved unless the user explicitly confirms them.

## Part 2: Migration Plan

The migration plan includes:

- repository root
- config path
- detected categories
- package-backed command paths
- files to create
- files to update
- files to preserve
- cleanup candidates
- state migrations
- conflicts
- warnings
- required confirmations
- required host trust steps
- recommended next command

`aiu migrate` defaults to audit/plan mode and writes nothing. `--dry-run --json` emits the full plan shape for agents.

## Part 3: Migration Apply

Mutating modes are explicit:

- `--apply` writes package-backed config and host updates
- `--cleanup` removes confirmed cleanup candidates
- `--force` resolves explicit overwrite choices

Apply mode preserves:

- user-authored prompt text
- host configuration outside managed sections
- recognized `.umpire/` state
- trusted command descriptors
- repository policy choices
- host trust requirements

Migration never stages, commits, branches, pushes, opens PRs, merges, closes work items, or edits provider state.

## Part 4: No Runtime Fallback

Migration must not add or preserve runtime fallback support for copied implementation scripts or old helper semantics.

The target state is:

- host config calls package-backed `aiu`
- OpenCode wrappers delegate to the package runtime
- trusted state is read from configured command descriptors
- copied helper implementations are either removed by explicit cleanup or left inert for manual review
- core decision/runtime code has no branches for old helper JSON shapes or old script behavior

## Part 5: Release Readiness

Release checks include:

- build
- typecheck
- tests
- package dry-run
- publish file assertions
- no generated source artifacts committed
- no install lifecycle scripts
- README examples tested where practical

README documents:

- exact-version install with lockfiles and lifecycle scripts disabled
- init and host trust steps
- status/doctor/schema flows
- stop-hook behavior
- migration from repo-local hooks and local-checkout references
- troubleshooting and logs

Publish workflow uses npm provenance or another documented secure publishing path. Docs must not tell users to rely on floating `latest` as the preferred install path.

Repository release controls include:

- pinned GitHub Actions in CI and publish workflows
- read-only default workflow permissions
- branch protection or rulesets on `main`
- required signed commits, pull request review, CODEOWNERS review, and CI before merge
- disabled force pushes and branch deletion on `main`
- secret scanning and push protection when repository visibility supports them
- protected `npm-publish` environment with reviewer approval
- npm trusted publishing for `ZarK/ai-umpire`, workflow `Publish`, environment `npm-publish`
- no long-lived `NPM_TOKEN` for the primary publish path

## Proposed GitHub Issues

### M5.1 - Implement Migration Inventory And Dry-Run Plan

Detect repo-local hooks, local-checkout references, copied helpers, config, host files, and state; produce a dry-runnable plan with conflicts and confirmations.

### M5.2 - Implement Migration Apply And State Preservation

Apply package-backed config and host updates, preserve recognized state and user customizations, and write clear diagnostics.

### M5.3 - Implement Explicit Cleanup For Confirmed Old Assets

Remove only confirmed cleanup candidates and leave unknown files for manual review.

### M5.4 - Finalize Runtime Boundaries And No-Fallback Checks

Verify core runtime has no old-helper compatibility adapters, copied script semantics, placeholder providers, or runtime fallback branches.

### M5.5 - Complete Release Documentation And Package Safety Checks

Update README, CI, publish workflow, pack tests, install safety docs, migration docs, and release checklist.

## Exit Criteria

- A repository using old repo-local Umpire hooks can dry-run and apply migration to package-backed entrypoints.
- Migration preserves user-authored customization and recognized state.
- Core runtime remains provider-neutral and has no old-helper fallback path.
- Release checks validate the actual package surface and safety posture.
