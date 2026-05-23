import { createCli, createCommand, createSchemaCommand, runCli } from "@tjalve/qube-cli/runtime";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getAiuPackageAssetPaths, getAiuPackageRoot } from "./assets.js";
import {
  AIU_CONFIG_FILENAME,
  AIU_CONFIG_SCHEMA_VERSION,
  AIU_HOST_CAPABILITY_NAMES,
  AIU_HOSTS,
  formatConfigDiagnostics,
  getDefaultAiuConfig,
  loadAiuConfig,
} from "./config.js";
import { AIU_COMMAND_REGISTRY, configCommand, initCommand, pathsCommand } from "./command_registry.js";
import { applyAiuInitPlan, formatInitPlan, planAiuInit, type AiuInitTool } from "./init.js";

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

const packageJson = JSON.parse(readFileSync(path.join(getAiuPackageRoot(), "package.json"), "utf8")) as PackageJson;
let runtimeRegistry = AIU_COMMAND_REGISTRY;

export const aiuCli = createCli({
  bin: "aiu",
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  description: packageJson.description,
  registry: AIU_COMMAND_REGISTRY,
  commands: [
    createCommand(configCommand, (context) => {
      const configPath = typeof context.flags.config === "string" ? context.flags.config : undefined;
      const result = loadAiuConfig(configPath ? { configPath } : {});
      const human = [
        `selectedPath: ${result.selectedPath}`,
        `found: ${String(result.found)}`,
        `valid: ${String(result.ok)}`,
        "",
        formatConfigDiagnostics(result.diagnostics),
      ].join("\n");

      return {
        human,
        json: {
          config: {
            selectedPath: result.selectedPath,
            repoRoot: result.repoRoot,
            found: result.found,
            defaultsUsed: result.defaultsUsed,
            valid: result.ok,
            value: result.config,
            diagnostics: result.diagnostics,
          },
        },
      };
    }),
    createCommand(initCommand, (context) => {
      const tool = typeof context.flags.tool === "string" ? (context.flags.tool as AiuInitTool) : undefined;
      const dryRun = context.flags["dry-run"] === true;
      const force = context.flags.force === true;
      const plan = applyAiuInitPlan(planAiuInit({ tool, dryRun, force }));
      return {
        human: formatInitPlan(plan),
        json: {
          init: plan,
        },
      };
    }),
    createCommand(pathsCommand, () => {
      const assetPaths = getAiuPackageAssetPaths();
      return {
        human: [
          `packageRoot: ${assetPaths.packageRoot}`,
          `pluginWrapperRelativePath: ${assetPaths.pluginWrapperRelativePath}`,
          "",
        ].join("\n"),
        json: {
          paths: assetPaths,
        },
      };
    }),
    createSchemaCommand({
      registry: () => runtimeRegistry,
      bin: "aiu",
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      sections: {
        config: {
          schemaVersion: AIU_CONFIG_SCHEMA_VERSION,
          defaultPath: AIU_CONFIG_FILENAME,
          defaultConfig: getDefaultAiuConfig(),
          hostNames: AIU_HOSTS,
          hostCapabilityNames: AIU_HOST_CAPABILITY_NAMES,
        },
      },
    }),
  ],
});

runtimeRegistry = aiuCli.registry;

export async function runAiuCli(input: readonly string[]): Promise<number> {
  const result = await runCli(aiuCli, input);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}
