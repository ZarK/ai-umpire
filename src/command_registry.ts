import { defineCommand, defineExample, defineFlag } from "@tjalve/qube-cli/metadata";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";

import { AIU_CONFIG_FILENAME } from "./config.js";
import { AIU_INIT_TOOLS } from "./init.js";

const jsonFlag = defineFlag({
  name: "json",
  description: "Render machine-readable JSON output.",
  type: "boolean",
  short: "j",
});

export const pathsCommand = defineCommand({
  kind: "command",
  name: "paths",
  description: "Show package, config, state, host, and trusted command paths.",
  flags: [
    jsonFlag,
    defineFlag({
      name: "config",
      description: `Use an explicit ${AIU_CONFIG_FILENAME} path instead of repository-root discovery.`,
      type: "string",
      short: "c",
    }),
  ],
  examples: [
    defineExample({
      description: "Show package and repository paths.",
      command: "aiu paths",
    }),
    defineExample({
      description: "Show package and repository paths as JSON.",
      command: "aiu paths --json",
    }),
    defineExample({
      description: "Inspect paths for an explicit config file.",
      command: "aiu paths --config ./aiu.config.json --json",
    }),
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human",
  },
  interactions: {
    json: true,
    dryRun: {
      supported: false,
      reason: "Command does not support dry-run mode.",
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false,
  },
  errors: [
    {
      kind: "asset-paths-unavailable",
      description: "Package asset paths could not be resolved.",
    },
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "Command completed successfully.",
    },
    {
      code: 2,
      category: "usage",
      description: "Command usage was invalid.",
    },
    {
      code: 1,
      category: "unexpected",
      description: "Command failed unexpectedly.",
    },
  ],
});

export const doctorCommand = defineCommand({
  kind: "command",
  name: "doctor",
  description: "Inspect installation health, config, host files, state paths, and trusted commands.",
  flags: [
    jsonFlag,
    defineFlag({
      name: "config",
      description: `Use an explicit ${AIU_CONFIG_FILENAME} path instead of repository-root discovery.`,
      type: "string",
      short: "c",
    }),
  ],
  examples: [
    defineExample({
      description: "Inspect Umpire health.",
      command: "aiu doctor",
    }),
    defineExample({
      description: "Inspect Umpire health as clean JSON.",
      command: "aiu doctor --json",
    }),
    defineExample({
      description: "Inspect Umpire health for an explicit config file.",
      command: "aiu doctor --config ./aiu.config.json --json",
    }),
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human",
  },
  interactions: {
    json: true,
    dryRun: {
      supported: false,
      reason: "Doctor is non-mutating and only reports diagnostics.",
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false,
  },
  errors: [
    {
      kind: "node-version-unsupported",
      description: "The active Node.js runtime does not satisfy the package engine requirement.",
    },
    {
      kind: "config-invalid",
      description: "The selected config has validation diagnostics.",
    },
    {
      kind: "config-missing",
      description: "No repository config file was found, so conservative defaults are in use.",
    },
    {
      kind: "host-file-missing",
      description: "A configured host integration file is not installed.",
    },
    {
      kind: "host-runtime-disabled",
      description: "No host integration is enabled for runtime policy checks.",
    },
    {
      kind: "host-mode-supported",
      description: "A configured host supports a selected continuation mode.",
    },
    {
      kind: "host-capability-disabled",
      description: "A selected continuation mode requires a disabled host capability.",
    },
    {
      kind: "host-capability-unsupported",
      description: "A selected continuation mode requires an unsupported or unknown host capability.",
    },
    {
      kind: "host-capability-experimental",
      description: "A selected continuation mode uses an experimental host capability.",
    },
    {
      kind: "host-stop-hook-blocking-unsafe",
      description: "A config enables stop-hook blocking for a host that must safe-allow stopping.",
    },
    {
      kind: "host-entrypoint-package-backed",
      description: "A configured host entrypoint delegates to the package-backed runtime.",
    },
    {
      kind: "host-entrypoint-unmanaged",
      description: "A configured host entrypoint appears to contain copied or custom helper logic.",
    },
    {
      kind: "host-entrypoint-unreadable",
      description: "A configured host entrypoint could not be read.",
    },
    {
      kind: "state-path-not-writable",
      description: "A configured state, lock, or log path cannot be written or created.",
    },
    {
      kind: "trusted-command-missing",
      description: "A configured trusted command executable is not available.",
    },
    {
      kind: "stale-state-policy-relaxed",
      description: "Continuation policy allows unknown or unsafe trusted state.",
    },
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "Doctor completed and reported health diagnostics.",
    },
    {
      code: 2,
      category: "usage",
      description: "Command usage was invalid.",
    },
    {
      code: 1,
      category: "unexpected",
      description: "Command failed unexpectedly.",
    },
  ],
});

export const statusCommand = defineCommand({
  kind: "command",
  name: "status",
  description: "Render trusted state, continuation decision, prompt metadata, and next action.",
  flags: [
    jsonFlag,
    defineFlag({
      name: "config",
      description: `Use an explicit ${AIU_CONFIG_FILENAME} path instead of repository-root discovery.`,
      type: "string",
      short: "c",
    }),
  ],
  examples: [
    defineExample({
      description: "Show the current Umpire continuation status.",
      command: "aiu status",
    }),
    defineExample({
      description: "Show continuation status as clean JSON.",
      command: "aiu status --json",
    }),
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human",
  },
  interactions: {
    json: true,
    dryRun: {
      supported: false,
      reason: "Status reads trusted state and reports a decision without mutating state.",
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false,
  },
  errors: [
    {
      kind: "status-config-invalid",
      description: "The selected config has validation errors.",
    },
    {
      kind: "status-trusted-command-failed",
      description: "A configured trusted state command could not produce usable state.",
    },
    {
      kind: "trusted-command-malformed-json",
      description: "A configured trusted command emitted malformed JSON.",
    },
    {
      kind: "trusted-command-spawn-failed",
      description: "A configured trusted command could not be spawned.",
    },
    {
      kind: "trusted-command-timeout",
      description: "A configured trusted command timed out.",
    },
    {
      kind: "trusted-command-non-zero-exit",
      description: "A configured trusted command exited with a non-zero code.",
    },
    {
      kind: "trusted-command-output-limit",
      description: "A configured trusted command exceeded its output limit.",
    },
    {
      kind: "trusted-command-unknown-schema",
      description: "A configured trusted command emitted an unsupported schema version.",
    },
    {
      kind: "trusted-command-unsupported-capability",
      description: "A configured trusted command reported an unsupported capability.",
    },
    {
      kind: "trusted-command-stale-state",
      description: "A configured trusted command emitted stale state.",
    },
    {
      kind: "trusted-command-invalid-state",
      description: "A configured trusted command emitted an invalid state payload.",
    },
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "Status was rendered successfully.",
    },
    {
      code: 2,
      category: "usage",
      description: "Command usage was invalid.",
    },
    {
      code: 1,
      category: "unexpected",
      description: "Command failed unexpectedly.",
    },
  ],
});

export const configCommand = defineCommand({
  kind: "command",
  name: "config",
  description: "Inspect repository config discovery, defaults, and validation diagnostics.",
  flags: [
    jsonFlag,
    defineFlag({
      name: "config",
      description: `Use an explicit ${AIU_CONFIG_FILENAME} path instead of repository-root discovery.`,
      type: "string",
      short: "c",
    }),
  ],
  examples: [
    defineExample({
      description: "Inspect discovered config.",
      command: "aiu config",
    }),
    defineExample({
      description: "Inspect discovered config as JSON.",
      command: "aiu config --json",
    }),
    defineExample({
      description: "Inspect an explicit config path.",
      command: "aiu config --config ./aiu.config.json --json",
    }),
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human",
  },
  interactions: {
    json: true,
    dryRun: {
      supported: false,
      reason: "Command only inspects config and does not mutate state.",
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false,
  },
  errors: [
    {
      kind: "invalid-json",
      description: "The selected config file is not valid JSON.",
    },
    {
      kind: "invalid-host",
      description: "The selected config references an unsupported host.",
    },
    {
      kind: "invalid-host-capability",
      description: "The selected config references an unsupported or invalid host capability override.",
    },
    {
      kind: "invalid-host-modes",
      description: "The selected config has invalid per-host continuation mode policy.",
    },
    {
      kind: "invalid-stop-hook-blocking",
      description: "The selected config has invalid per-host stop-hook blocking policy.",
    },
    {
      kind: "host-capability-disabled",
      description: "A selected continuation mode requires a disabled host capability.",
    },
    {
      kind: "host-capability-unsupported",
      description: "A selected continuation mode requires an unsupported or unknown host capability.",
    },
    {
      kind: "host-capability-experimental",
      description: "A selected continuation mode uses an experimental host capability.",
    },
    {
      kind: "host-mode-supported",
      description: "A configured host supports a selected continuation mode.",
    },
    {
      kind: "host-stop-hook-blocking-unsafe",
      description: "A config enables stop-hook blocking for a host that must safe-allow stopping.",
    },
    {
      kind: "unsafe-command-descriptor",
      description: "A trusted command is not represented as a safe argv descriptor.",
    },
    {
      kind: "invalid-duration",
      description: "A duration value is not a positive integer millisecond count.",
    },
    {
      kind: "contradictory-policy",
      description: "Config policy contains contradictory settings.",
    },
    {
      kind: "path-not-writable",
      description: "A configured state, lock, or log path is not writable.",
    },
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "Config was inspected successfully; validation diagnostics are included in the output.",
    },
    {
      code: 2,
      category: "usage",
      description: "Command usage was invalid.",
    },
    {
      code: 1,
      category: "unexpected",
      description: "Command failed unexpectedly.",
    },
  ],
});

export const initCommand = defineCommand({
  kind: "command",
  name: "init",
  description: "Plan and apply package-backed host installation files and repository config.",
  flags: [
    jsonFlag,
    defineFlag({
      name: "tool",
      description: "Select host tooling to initialize.",
      type: "option",
      options: AIU_INIT_TOOLS,
      defaultValue: "all",
    }),
    defineFlag({
      name: "dry-run",
      description: "Render the init plan without writing files.",
      type: "boolean",
    }),
    defineFlag({
      name: "force",
      description: "Replace conflicting managed files explicitly.",
      type: "boolean",
    }),
  ],
  examples: [
    defineExample({
      description: "Inspect the full init plan without writing files.",
      command: "aiu init --dry-run --json",
    }),
    defineExample({
      description: "Initialize only Codex host files.",
      command: "aiu init --tool codex",
    }),
    defineExample({
      description: "Replace conflicting managed files intentionally.",
      command: "aiu init --tool all --force",
    }),
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human",
  },
  interactions: {
    json: true,
    dryRun: {
      supported: true,
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false,
  },
  mutation: {
    categories: ["local-files", "local-config"],
  },
  errors: [
    {
      kind: "init-conflict",
      description: "Init found existing files that differ from planned managed content.",
    },
    {
      kind: "invalid-command-usage",
      description: "Init command usage was invalid.",
    },
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "Init plan was produced, and apply mode wrote files when no conflicts were present.",
    },
    {
      code: 2,
      category: "usage",
      description: "Command usage was invalid.",
    },
    {
      code: 1,
      category: "unexpected",
      description: "Command failed unexpectedly.",
    },
  ],
});

export const hookStopCommand = defineCommand({
  kind: "command",
  name: "hook-stop",
  description: "Handle host Stop hook input and emit the host JSON response.",
  flags: [
    jsonFlag,
    defineFlag({
      name: "tool",
      description: "Host tool that invoked the Stop hook.",
      type: "option",
      options: ["codex", "claude-code"],
      required: true,
    }),
  ],
  examples: [
    defineExample({
      description: "Handle a Codex Stop hook using trusted-state decisions and host policy.",
      command: "aiu hook-stop --tool codex",
    }),
    defineExample({
      description: "Inspect the Claude Code Stop hook decision result as JSON.",
      command: "aiu hook-stop --tool claude-code --json",
    }),
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human",
  },
  interactions: {
    json: true,
    dryRun: {
      supported: false,
      reason: "Hook commands are invoked by host runtimes and only emit a host response.",
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false,
  },
  errors: [
    {
      kind: "invalid-command-usage",
      description: "Hook command usage was invalid.",
    },
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "Hook input was handled and a host response was emitted.",
    },
    {
      code: 2,
      category: "usage",
      description: "Command usage was invalid.",
    },
    {
      code: 1,
      category: "unexpected",
      description: "Command failed unexpectedly.",
    },
  ],
});

export const migrateCommand = defineCommand({
  kind: "command",
  name: "migrate",
  description: "Audit and explicitly apply package-backed host migration while preserving repository state and policy.",
  flags: [
    jsonFlag,
    defineFlag({
      name: "dry-run",
      description: "Render the migration audit plan without writing files.",
      type: "boolean",
    }),
    defineFlag({
      name: "apply",
      description: "Write package-backed config and managed host files for migration-safe paths.",
      type: "boolean",
    }),
    defineFlag({
      name: "force",
      description: "Replace differing managed host files explicitly; never deletes preserved state or cleanup candidates.",
      type: "boolean",
    }),
    defineFlag({
      name: "cleanup",
      description: "Inspect or remove confirmed old migration assets without changing host/config apply behavior.",
      type: "boolean",
    }),
    defineFlag({
      name: "confirm",
      description: "Comma-separated cleanup candidate relative paths or fingerprints to remove.",
      type: "string",
    }),
  ],
  examples: [
    defineExample({
      description: "Inspect migration work without writing files.",
      command: "aiu migrate --dry-run --json",
    }),
    defineExample({
      description: "Apply package-backed migration changes for safe paths.",
      command: "aiu migrate --apply --json",
    }),
    defineExample({
      description: "Replace differing managed host files after review.",
      command: "aiu migrate --apply --force --json",
    }),
    defineExample({
      description: "Inspect cleanup candidates without deleting files.",
      command: "aiu migrate --cleanup --dry-run --json",
    }),
    defineExample({
      description: "Remove a confirmed cleanup candidate by path or fingerprint.",
      command: "aiu migrate --cleanup --confirm scripts/aiu-stop.js --json",
    }),
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human",
  },
  interactions: {
    json: true,
    dryRun: {
      supported: true,
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false,
  },
  mutation: {
    categories: ["local-files", "local-config"],
  },
  errors: [
    {
      kind: "migration-conflict",
      description: "Migration apply found paths requiring review or explicit force before replacement.",
    },
    {
      kind: "migration-cleanup-conflict",
      description: "Migration cleanup refused an unsafe or unconfirmed removal.",
    },
    {
      kind: "invalid-command-usage",
      description: "Migration command usage was invalid.",
    },
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "Migration audit or explicit apply completed without provider, git, or cleanup mutations.",
    },
    {
      code: 2,
      category: "usage",
      description: "Command usage was invalid.",
    },
    {
      code: 1,
      category: "unexpected",
      description: "Command failed unexpectedly.",
    },
  ],
});

export const whipCommand = defineCommand({
  kind: "command",
  name: "whip",
  description: "Inspect and manage durable idle whip tasks.",
  arguments: [
    {
      name: "action",
      description: "Whip task action: list, status, add, cancel, or complete.",
      required: true,
    },
  ],
  flags: [
    jsonFlag,
    defineFlag({
      name: "config",
      description: `Use an explicit ${AIU_CONFIG_FILENAME} path instead of repository-root discovery.`,
      type: "string",
      short: "c",
    }),
    defineFlag({
      name: "dry-run",
      description: "Render the mutation plan without writing whip state.",
      type: "boolean",
    }),
    defineFlag({
      name: "id",
      description: "Whip task id for add, cancel, or complete.",
      type: "string",
    }),
    defineFlag({
      name: "title",
      description: "Whip task title for add.",
      type: "string",
    }),
    defineFlag({
      name: "prompt",
      description: "Concrete whip task prompt for add.",
      type: "string",
    }),
    defineFlag({
      name: "priority",
      description: "Non-negative integer priority for add.",
      type: "integer",
    }),
    defineFlag({
      name: "reason",
      description: "Cancellation reason for cancel.",
      type: "string",
    }),
    defineFlag({
      name: "evidence",
      description: "Completion evidence for complete.",
      type: "string",
    }),
  ],
  examples: [
    defineExample({
      description: "List effective whip tasks.",
      command: "aiu whip list --json",
    }),
    defineExample({
      description: "Inspect whip state and ownership.",
      command: "aiu whip status --json",
    }),
    defineExample({
      description: "Add a concrete repo-owned whip task without writing state.",
      command: "aiu whip add --id repo-docs --title \"Review docs\" --prompt \"Review README command examples.\" --priority 10 --dry-run --json",
    }),
    defineExample({
      description: "Cancel a whip task.",
      command: "aiu whip cancel --id repo-docs --reason \"Superseded by issue work\"",
    }),
    defineExample({
      description: "Complete a whip task with evidence.",
      command: "aiu whip complete --id repo-docs --evidence \"Updated README and reran cli tests\"",
    }),
  ],
  output: {
    formats: ["human", "json"],
    defaultFormat: "human",
  },
  interactions: {
    json: true,
    dryRun: {
      supported: true,
    },
    noColor: true,
    nonInteractive: true,
    ttyPrompt: false,
  },
  mutation: {
    categories: ["local-files"],
  },
  errors: [
    {
      kind: "whip-disabled",
      description: "Whip is disabled and the requested action would mutate local whip state.",
    },
    {
      kind: "whip-invalid-command",
      description: "The whip action or flags are invalid.",
    },
    {
      kind: "whip-invalid-task",
      description: "The requested whip task input is incomplete or invalid.",
    },
    {
      kind: "whip-state-malformed",
      description: "The configured whip state file is malformed.",
    },
    {
      kind: "whip-task-exists",
      description: "A whip task with the requested id already exists.",
    },
    {
      kind: "whip-task-not-found",
      description: "The requested whip task id does not exist.",
    },
    {
      kind: "whip-invalid-transition",
      description: "The requested status transition is not valid.",
    },
    {
      kind: "whip-evidence-required",
      description: "Completing a whip task requires explicit evidence.",
    },
    {
      kind: "whip-state-write-failed",
      description: "Whip state could not be written.",
    },
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "Whip command completed successfully.",
    },
    {
      code: 2,
      category: "usage",
      description: "Command usage was invalid.",
    },
    {
      code: 1,
      category: "validation",
      description: "Whip state or requested transition was invalid.",
    },
  ],
});

export const AIU_COMMAND_REGISTRY = createCommandRegistry({
  commands: [configCommand, doctorCommand, hookStopCommand, initCommand, migrateCommand, pathsCommand, statusCommand, whipCommand],
});
