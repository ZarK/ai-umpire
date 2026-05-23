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
      description: "Allow a Codex Stop hook using safe package defaults.",
      command: "aiu hook-stop --tool codex",
    }),
    defineExample({
      description: "Inspect the safe Stop hook result as JSON.",
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
  description: "Audit existing repo-local Umpire hooks and local-checkout references before package-backed migration.",
  flags: [
    jsonFlag,
    defineFlag({
      name: "dry-run",
      description: "Render the migration audit plan without writing files.",
      type: "boolean",
    }),
  ],
  examples: [
    defineExample({
      description: "Inspect migration work without writing files.",
      command: "aiu migrate --dry-run --json",
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
  errors: [
    {
      kind: "invalid-command-usage",
      description: "Migration command usage was invalid.",
    },
  ],
  exitCodes: [
    {
      code: 0,
      category: "success",
      description: "Migration audit plan was produced without mutating repository files.",
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

export const AIU_COMMAND_REGISTRY = createCommandRegistry({
  commands: [configCommand, doctorCommand, hookStopCommand, initCommand, migrateCommand, pathsCommand, statusCommand],
});
