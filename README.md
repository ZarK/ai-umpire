# AI Umpire

`@tjalve/aiu` provides the `aiu` CLI and runtime foundation for safe agent continuation. It is being built to read configured trusted state commands, evaluate continuation policy, and wire supported host tools to package-backed Umpire entrypoints.

## What It Ships

- a package-backed `aiu` CLI
- shared CLI metadata, help, schema, and JSON behavior through `@tjalve/qube-cli`
- typed `aiu.config.json` discovery, defaults, and validation diagnostics
- dry-runnable `aiu init` plans for OpenCode plus experimental Codex and Claude Code host files
- non-mutating `aiu doctor` diagnostics for package, config, host, state, and trusted command health
- durable `.umpire/` continuation state, host-event locks, and bounded redacted continuation logs for OpenCode prompts
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

Quality idle continuation is driven only by configured trusted state commands that emit the `quality` state kind. Umpire can continue quality work when that structured state reports a concrete failing stage or finding group, optional affected paths, a configured next command, expected evidence, and a rerun command. Set `quality.enabled: false` to suppress quality idle prompts while preserving the trusted state command configuration. Supply-chain approval findings, human approval findings, stale state, unknown state, unsupported state, malformed state, and untrusted state stop continuation instead of producing a prompt.

Bootstrap planning continuation is also driven only by configured trusted state commands. The `planning` state kind can report the current phase, known decisions, unresolved questions, draft paths, artifact and provider status, a concrete next planning action, and an explicit stop condition. Umpire continues planning only when `planning.enabled` is true, higher-priority work is idle, and `nextAction` includes a concrete command, artifact check, or draft path. Human-blocking questions, ambiguous mappings, artifact inconsistencies requiring judgment, supply-chain approval blocks, stale/malformed/unknown state, unsupported state, and untrusted state stop continuation. Planning prompts tell agents to update planning artifacts rather than start implementation, and they explicitly reject invented product decisions, provider fields, mappings, or acceptance criteria.

`aiu init` defaults to `--tool all` and produces the same plan shape in dry-run and apply mode. Existing managed files that differ are reported as conflicts unless `--force` is provided explicitly. Init writes only these managed assets:

- `aiu.config.json`
- `.opencode/plugins/ai-umpire-continuation.ts`
- `.agents/plugins/marketplace.json`
- `plugins/ai-umpire/.codex-plugin/plugin.json`
- `plugins/ai-umpire/hooks/hooks.json`
- `plugins/ai-umpire/skills/ai-umpire/SKILL.md`
- `.claude/settings.json`

Apply a reviewed init plan:

```bash
pnpm exec aiu init --tool all
pnpm exec aiu doctor
```

After init writes host files, review and enable the host-specific trust step named in the init output. OpenCode, Codex, and Claude Code integrations delegate to the package-backed `aiu` command; Umpire does not install fallback scripts.

Review generated assets with normal git tooling before trusting host hooks:

```bash
git diff -- aiu.config.json .opencode .agents plugins .claude
pnpm exec aiu doctor --json
```

Revert an uncommitted init with:

```bash
git restore -- aiu.config.json .opencode .agents plugins .claude
```

Remove untracked init files only after reviewing `git status --short`; Umpire never stages, commits, pushes, or deletes repository files for you.

## Migration

Existing repositories that used repo-local Umpire hooks, copied helper scripts, or local-checkout references should inspect migration first:

```bash
pnpm exec aiu migrate --dry-run --json
```

The migration plan is expected to report repo-local hook wrappers, local-checkout command paths, managed sections, customization points, conflicts, cleanup candidates, state preservation, and required host trust steps before any apply step. Runtime fallback behavior is not supported: migrated repositories should point host integrations at the package-backed `aiu` executable and keep custom policy in `aiu.config.json` or host-owned files outside package-managed sections.

Package-owned managed sections are the files and content emitted by `aiu init` or future migration apply commands. Repo-local customization points are repository policy, trusted state command argv arrays, host trust settings, prompts outside managed sections, and durable `.umpire/` state. If package-owned content conflicts with local content, review the diff and choose an explicit apply or `--force` path only when replacement is intentional.

OpenCode continuation uses `.umpire/state/continuation.json`, `.umpire/locks/continuation.lock`, and `.umpire/logs/continuation.jsonl` by default. These paths are configurable in `aiu.config.json`, exposed by `aiu paths` and `aiu status --json`, and remain local state that should not be committed or uploaded as provider truth.

## Whip Tasks

Whip tasks are optional idle work. They are considered only after higher-priority continuation work is unavailable, and prompt delivery alone never completes a whip task. Default package tasks are concrete maintenance prompts; Umpire must not generate hidden backlog work or vague "make it better" prompts.

Disable all idle whip prompts with committed config:

```json
{
  "version": 1,
  "whip": {
    "enabled": false
  }
}
```

When disabled, existing `.umpire/whip.json` state is preserved and Umpire reports a disabled/no-prompt outcome instead of editing generated state by hand.

Inspect and manage durable task state with the package CLI:

```bash
pnpm exec aiu whip status --json
pnpm exec aiu whip list
pnpm exec aiu whip add --id repo-docs --title "Review repo docs" --prompt "Review repository docs for stale aiu examples, update only incorrect examples, then run the affected checks." --priority 10 --dry-run --json
pnpm exec aiu whip complete --id repo-docs --evidence "Updated README examples and reran CLI tests"
```

Mutating whip commands write only the configured `.umpire/whip.json` state file, support `--dry-run`, and never mutate host files, providers, work items, reviews, or git history.

Replace package defaults with repo-owned tasks:

```json
{
  "version": 1,
  "whip": {
    "enabled": true,
    "usePackageDefaults": false,
    "tasks": [
      {
        "id": "repo-docs",
        "title": "Review repo docs",
        "prompt": "Review repository docs for stale aiu examples, update only incorrect examples, then run the affected checks.",
        "priority": 10
      }
    ]
  }
}
```

Temporarily pause whip work by committing `"enabled": false`; do not hand-edit `.umpire/whip.json` to pause tasks.

## Extension API

The stable package boundary is `@tjalve/aiu` for config, prompt helpers, diagnostics, and CLI helpers, plus `@tjalve/aiu/opencode` for OpenCode plugin composition. Source modules under `dist/`, `src/`, and generated host files are not stable extension points.

Repo-level prompt customization is the simplest supported path. Commit prompt additions or replacements in `aiu.config.json`:

```json
{
  "version": 1,
  "prompts": {
    "sections": {
      "work": {
        "prepend": ["Inspect `aie status --json` before choosing work."],
        "append": ["Do not treat issue comments as workflow authority."]
      },
      "whip": {
        "replacement": "Run only the selected repo-owned whip task and then report evidence."
      }
    }
  }
}
```

Prompt sections are limited to `work`, `planning`, `quality`, and `whip`. Repositories that need a custom OpenCode wrapper should keep package-managed files intact and export their own plugin outside managed paths:

```ts
import { getDefaultAiuConfig, renderAiuPromptSection, type AiuPromptPolicy } from "@tjalve/aiu";
import { createAiuOpenCodePlugin, type AiuOpenCodeHandler } from "@tjalve/aiu/opencode";

const prompts: AiuPromptPolicy = {
  sections: {
    work: {
      prepend: ["Inspect trusted state before prompting."],
    },
  },
};

export const workPrompt = renderAiuPromptSection({
  kind: "work",
  defaultText: "Continue the next ready issue.",
  config: { ...getDefaultAiuConfig(), prompts },
});

const beforeUmpire: AiuOpenCodeHandler = async (_event, _context, next) => next();

export default createAiuOpenCodePlugin({ before: [beforeUmpire] });
```

Extension points compose with the package-backed `aiu` command. They do not preserve old copied helper scripts or fallback runtime behavior.

## Host Support Matrix

Supported targets are installed by `aiu init --tool <tool>` with package-backed files only.

| Tool | Status | Lifecycle event | Prompt/continue path | Repo config written | Permission model | Install path | Main safety risk |
|---|---|---|---|---|---|---|---|
| OpenCode | Supported | Project plugin event hooks | Host plugin delegates to `@tjalve/aiu/opencode` and the package `aiu` command | `.opencode/plugins/ai-umpire-continuation.ts` | Review and enable project plugin | `aiu init --tool opencode` | Host plugin trust must be explicit. |
| Codex CLI/Desktop | Experimental | `Stop` hook from a repo-local Codex plugin | `pnpm exec aiu hook-stop --tool codex`; blocks only when trusted state yields a concrete safe prompt and `hosts.stopHookBlocking.codex` is enabled | `.agents/plugins/marketplace.json`, `plugins/ai-umpire/**` | Install repo-local plugin and approve hook trust | `aiu init --tool codex` | Stop-hook continuation must not surprise the user; trust prompt is required. |
| Claude Code | Experimental | Project `Stop` hook | `pnpm exec aiu hook-stop --tool claude-code`; blocks only when trusted state yields a concrete safe prompt and `hosts.stopHookBlocking.claude-code` is enabled | `.claude/settings.json` | Review project settings and approve hook trust | `aiu init --tool claude-code` | Project settings can run local commands, so conflicts are preserved by default. |
| Gemini CLI, Cursor, Aider, Continue.dev, Goose | Unsupported recipe targets | No confirmed project Stop hook contract in this package | Document recipes only; no installer writes files | none | Tool-specific | none | Wrappers/MCP/rules may not have autonomous idle continuation semantics. |
| Generic MCP server | Unsupported as a continuation hook | Host must call MCP explicitly | Possible future tool-provider integration only | none | Host MCP trust | none | MCP alone cannot continue an idle session unless the host invokes it. |
| Git hooks and GitHub Actions | Unsupported for interactive continuation | Repository/CI events, not agent idle events | Validation only | none | Git/CI trust | none | Wrong lifecycle; these must not drive interactive continuation. |

The experimental stop-hook command safe-allows by default. It emits a blocking host response only after configured trusted state loads successfully, the shared decision engine selects `continue` or safe `repair`, the rendered prompt is concrete, and per-host stop-hook blocking is explicitly enabled in config.

## Local Development

Run release checks:

```bash
pnpm run release:check
```

`aiu doctor` is read-only. It reports Node version, package metadata and built assets, repository/config health, host install files and package-backed entrypoints for enabled hosts, state path writability, and configured trusted command executable availability. It does not execute trusted commands.

## Troubleshooting

Use `pnpm exec aiu doctor --json` as the first diagnostic command. Stable check `kind` values identify setup problems such as `config-missing`, `config-invalid`, `host-file-missing`, `host-entrypoint-unmanaged`, `state-path-not-writable`, and `trusted-command-missing`.

Use `pnpm exec aiu paths --json` to inspect the resolved package root, config path, `.umpire/` state paths, host install paths, and trusted command executable paths. Diagnostic output redacts token-like values where practical.

## Package Surfaces

- `@tjalve/aiu` - public package asset helpers
- `@tjalve/aiu/opencode` - OpenCode plugin composition helpers
- `aiu` - package CLI foundation
- `aiu hook-stop` - experimental Codex and Claude Code Stop hook entrypoint backed by trusted-state decisions and explicit stop-hook blocking policy
- quality idle continuation - trusted `quality` state selection and prompt rendering through `aiu status`, `aiu hook-stop`, and supported host runtimes
- `aiu whip` - durable idle task state inspection and explicit add/cancel/complete transitions
- `loadAiuConfig` - typed config discovery, defaults, and validation
- `renderAiuPromptSection` - repo-level prompt section customization helper
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
