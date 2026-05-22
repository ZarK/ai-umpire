import { defineCommand, defineExample, defineFlag } from "@tjalve/qube-cli/metadata";
import { createCommandRegistry } from "@tjalve/qube-cli/registry";

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

export const AIU_COMMAND_REGISTRY = createCommandRegistry({
  commands: [pathsCommand],
});
