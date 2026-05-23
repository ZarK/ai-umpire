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

  it("pins CI and publish workflow actions to immutable commits", async () => {
    const workflowPaths = [
      path.join(repoRoot, ".github", "workflows", "ci.yml"),
      path.join(repoRoot, ".github", "workflows", "publish.yml"),
    ];

    for (const workflowPath of workflowPaths) {
      const workflow = await readFile(workflowPath, "utf8");
      const actionRefs = [...workflow.matchAll(/uses:\s*([^\s@]+)@([^\s]+)/g)];

      assert.ok(actionRefs.length > 0, workflowPath);
      for (const [, action, ref] of actionRefs) {
        assert.match(ref ?? "", /^[a-f0-9]{40}$/, `${workflowPath} ${action ?? "action"} must use a full commit SHA`);
      }
    }
  });

  it("keeps publish workflow on trusted publishing without long-lived npm tokens", async () => {
    const publishWorkflow = await readFile(path.join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");

    assert.match(publishWorkflow, /id-token:\s*write/);
    assert.match(publishWorkflow, /environment:\s*npm-publish/);
    assert.match(publishWorkflow, /git merge-base --is-ancestor "\$tag_commit" origin\/main/);
    assert.match(publishWorkflow, /pnpm publish --access public --provenance --no-git-checks/);
    assert.doesNotMatch(publishWorkflow, /NPM_TOKEN/);
  });

  it("does not persist checkout credentials in workflows", async () => {
    const workflowPaths = [
      path.join(repoRoot, ".github", "workflows", "ci.yml"),
      path.join(repoRoot, ".github", "workflows", "publish.yml"),
    ];

    for (const workflowPath of workflowPaths) {
      const workflow = await readFile(workflowPath, "utf8");

      assert.match(workflow, /persist-credentials:\s*false/, workflowPath);
    }
  });

  it("requires CODEOWNERS review for release-sensitive files", async () => {
    const codeowners = await readFile(path.join(repoRoot, ".github", "CODEOWNERS"), "utf8");

    assert.match(codeowners, /^\* @ZarK$/m);
    assert.match(codeowners, /^\.github\/workflows\/ @ZarK$/m);
    assert.match(codeowners, /^\.github\/CODEOWNERS @ZarK$/m);
    assert.match(codeowners, /^package\.json @ZarK$/m);
    assert.match(codeowners, /^pnpm-lock\.yaml @ZarK$/m);
    assert.match(codeowners, /^\.npmrc @ZarK$/m);
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
