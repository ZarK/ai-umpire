#!/usr/bin/env node

import { stderr, stdout } from "node:process";

import { getAiuPackageAssetPaths } from "../assets.js";

const helpText = `AI Umpire package CLI

Usage:
  aiu paths [--json]
  aiu --help
`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args[0];

  if (command === undefined || command === "--help" || command === "-h") {
    stdout.write(helpText);
    return 0;
  }

  if (command === "paths") {
    const jsonMode = args.includes("--json");
    const assetPaths = getAiuPackageAssetPaths();
    if (jsonMode) {
      stdout.write(`${JSON.stringify(assetPaths, null, 2)}\n`);
      return 0;
    }

    stdout.write(`packageRoot: ${assetPaths.packageRoot}\n`);
    stdout.write(`pluginWrapperRelativePath: ${assetPaths.pluginWrapperRelativePath}\n`);
    return 0;
  }

  stderr.write(`Unknown command: ${command}\n`);
  stderr.write(helpText);
  return 2;
}

process.exitCode = await main(process.argv);
