import { defineCommand, defineExample, defineFlag } from "@tjalve/qube-cli/metadata";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";

import { AIU_CONFIG_FILENAME } from "./config.js";

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

export const AIU_COMMAND_REGISTRY = createCommandRegistry({
  commands: [configCommand, pathsCommand],
});
