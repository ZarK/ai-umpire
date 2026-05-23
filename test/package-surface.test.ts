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
      assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
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
    const npmSettings = parseNpmrc(npmrc);

    assert.equal(npmSettings.get("ignore-scripts"), "true");
    assert.equal(npmSettings.get("save-exact"), "true");
    assert.match(pnpmLock, /lockfileVersion:/);
  });

  it("verifies CLI dependency contract", async () => {
    const packageJson = await readPackageJson();
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    assert.equal(Object.hasOwn(dependencies, "@tjalve/aie"), false);
    assert.equal(Object.hasOwn(dependencies, "@tjalve/aiq"), false);
    assert.equal(dependencies["@tjalve/qube-cli"], "0.1.1");
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

function parseNpmrc(raw: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    settings.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }

  return settings;
}
