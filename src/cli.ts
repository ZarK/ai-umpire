import { createCli, createCommand, createSchemaCommand, runCli } from "@tjalve/qube-cli/runtime";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getAiuPackageAssetPaths, getAiuPackageRoot } from "./assets.js";
import { AIU_COMMAND_REGISTRY, pathsCommand } from "./command_registry.js";

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
