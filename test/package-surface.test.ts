import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

    assert.match(packageJson.packageManager ?? "", /^pnpm@\d+\.\d+\.\d+$/);
    for (const version of Object.values(dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    }
  });

  it("does not define install lifecycle scripts", async () => {
    const packageJson = await readPackageJson();

    assert.equal(Object.hasOwn(packageJson.scripts ?? {}, "preinstall"), false);
    assert.equal(Object.hasOwn(packageJson.scripts ?? {}, "install"), false);
    assert.equal(Object.hasOwn(packageJson.scripts ?? {}, "postinstall"), false);
  });

  it("does not publish legacy helper scripts or queue policy assets", async () => {
    const packageJson = await readPackageJson();

    assert.deepEqual(packageJson.files, ["dist/src", "README.md"]);
    assert.equal(packageJson.files?.includes("scripts"), false);
    assert.equal(packageJson.files?.includes("queue-policy.json"), false);
  });

  it("keeps durable pnpm safety defaults in the repository", async () => {
    const npmrc = await readFile(path.join(repoRoot, ".npmrc"), "utf8");
    const pnpmLock = await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");

    assert.match(npmrc, /ignore-scripts=true/);
    assert.match(npmrc, /save-exact=true/);
    assert.match(pnpmLock, /lockfileVersion:/);
  });

  it("does not depend on companion workflow CLIs", async () => {
    const packageJson = await readPackageJson();
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    assert.equal(Object.hasOwn(dependencies, "@tjalve/aie"), false);
    assert.equal(Object.hasOwn(dependencies, "@tjalve/aiq"), false);
  });

  it("does not pull frontend build tooling through the test runner", async () => {
    const packageJson = await readPackageJson();
    const pnpmLock = await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    assert.equal(Object.hasOwn(dependencies, "vitest"), false);
    assert.equal(Object.hasOwn(dependencies, "vite"), false);
    assert.doesNotMatch(pnpmLock, /\n\s+vite@/);
    assert.doesNotMatch(pnpmLock, /\n\s+vitest@/);
    assert.doesNotMatch(pnpmLock, /\n\s+postcss@/);
    assert.doesNotMatch(pnpmLock, /\n\s+rolldown@/);
  });
});

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}
