import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  packageManager?: string;
  scripts?: Record<string, string>;
};

describe("package foundation", () => {
  it("uses pnpm and exact dependency versions", async () => {
    const packageJson = await readPackageJson();
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    for (const version of Object.values(dependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    }
  });

  it("does not define install lifecycle scripts", async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.scripts).not.toHaveProperty("preinstall");
    expect(packageJson.scripts).not.toHaveProperty("install");
    expect(packageJson.scripts).not.toHaveProperty("postinstall");
  });

  it("does not publish legacy helper scripts or queue policy assets", async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.files).toEqual(["dist/src", "README.md"]);
    expect(packageJson.files).not.toContain("scripts");
    expect(packageJson.files).not.toContain("queue-policy.json");
  });

  it("keeps durable pnpm safety defaults in the repository", async () => {
    const npmrc = await readFile(path.join(repoRoot, ".npmrc"), "utf8");
    const pnpmLock = await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");

    expect(npmrc).toContain("ignore-scripts=true");
    expect(npmrc).toContain("save-exact=true");
    expect(pnpmLock).toContain("lockfileVersion:");
  });

  it("does not depend on companion workflow CLIs", async () => {
    const packageJson = await readPackageJson();
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    expect(Object.keys(dependencies)).not.toContain("@tjalve/aie");
    expect(Object.keys(dependencies)).not.toContain("@tjalve/aiq");
  });
});

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}
