import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AIU_PLUGIN_WRAPPER_RELATIVE_PATH = path.join(
  ".opencode",
  "plugins",
  "ai-umpire-continuation.ts",
);

export interface AiuPackageAssetPaths {
  packageRoot: string;
  pluginWrapperRelativePath: string;
}

export function getAiuPackageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, ".."),
    path.resolve(moduleDir, "..", ".."),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return candidates[0] ?? moduleDir;
}

export function getAiuPackageAssetPaths(): AiuPackageAssetPaths {
  return {
    packageRoot: getAiuPackageRoot(),
    pluginWrapperRelativePath: AIU_PLUGIN_WRAPPER_RELATIVE_PATH,
  };
}
