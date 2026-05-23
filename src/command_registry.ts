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
  description: "Show package asset paths for the installed AI Umpire package.",
  flags: [jsonFlag],
  examples: [
    defineExample({
      description: "Show package asset paths.",
      command: "aiu paths",
    }),
    defineExample({
      description: "Show package asset paths as JSON.",
      command: "aiu paths --json",
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

export const AIU_COMMAND_REGISTRY = createCommandRegistry({
  commands: [configCommand, initCommand, pathsCommand],
});
