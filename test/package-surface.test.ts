import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

type PackageJson = {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, { import?: string; types?: string }>;
  files?: string[];
  license?: string;
  main?: string;
  name?: string;
  packageManager?: string;
  publishConfig?: Record<string, boolean | string>;
  scripts?: Record<string, string>;
  types?: string;
  version?: string;
};

type PackDryRun = {
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string }>;
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

  it("publishes only the stable package runtime surface", async () => {
    const packageJson = await readPackageJson();
    const pack = await readPackDryRun();
    const packedPaths = pack.files.map((file) => file.path).sort();

    assert.equal(pack.name, "@tjalve/aiu");
    assert.equal(pack.version, packageJson.version);
    assert.equal(pack.filename, `tjalve-aiu-${packageJson.version}.tgz`);
    assert.equal(packageJson.name, "@tjalve/aiu");
    assert.equal(packageJson.license, "MIT");
    assert.equal(packageJson.main, "./dist/src/index.js");
    assert.equal(packageJson.types, "./dist/src/index.d.ts");
    assert.equal(packageJson.bin?.aiu, "dist/src/bin/aiu.js");
    assert.equal(packageJson.publishConfig?.access, "public");
    assert.equal(packageJson.publishConfig?.provenance, true);

    for (const required of [
      "README.md",
      "package.json",
      "dist/src/index.js",
      "dist/src/index.d.ts",
      "dist/src/opencode.js",
      "dist/src/opencode.d.ts",
      "dist/src/bin/aiu.js",
      "dist/src/cli.js",
      "dist/src/command_registry.js",
    ]) {
      assert.ok(packedPaths.includes(required), `${required} must be packed`);
    }

    for (const packedPath of packedPaths) {
      assert.equal(packedPath.startsWith("src/"), false, `${packedPath} must not publish TypeScript source`);
      assert.equal(packedPath.startsWith("test/"), false, `${packedPath} must not publish tests`);
      assert.equal(packedPath.startsWith("docs/"), false, `${packedPath} must not publish planning docs`);
      assert.equal(packedPath.startsWith(".github/"), false, `${packedPath} must not publish workflow internals`);
      assert.equal(packedPath.startsWith(".aie/"), false, `${packedPath} must not publish Executor state`);
      assert.equal(packedPath.startsWith(".umpire/"), false, `${packedPath} must not publish local Umpire state`);
      assert.equal(packedPath.endsWith(".ts") && !packedPath.endsWith(".d.ts"), false, `${packedPath} must not publish TypeScript source artifacts`);
      assert.notEqual(packedPath, "pnpm-lock.yaml");
      assert.notEqual(packedPath, "aiu.config.json");
      assert.notEqual(packedPath, ".npmrc");
    }
  });

  it("does not track generated build output or private local state", async () => {
    const packageJson = await readPackageJson();
    const tracked = await gitLsFiles(["dist", ".aie", ".umpire", `tjalve-aiu-${packageJson.version}.tgz`]);

    assert.deepEqual(tracked, []);
  });

  it("exports only documented stable package entrypoints", async () => {
    const packageJson = await readPackageJson();

    assert.deepEqual(Object.keys(packageJson.exports ?? {}).sort(), [".", "./opencode"]);
    assert.equal(packageJson.exports?.["."]?.types, "./dist/src/index.d.ts");
    assert.equal(packageJson.exports?.["./opencode"]?.types, "./dist/src/opencode.d.ts");
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
    assert.doesNotMatch(publishWorkflow, /workflow_dispatch:/);
    assert.match(publishWorkflow, /if:\s*startsWith\(github\.ref, 'refs\/tags\/publish-'\)/);
    assert.doesNotMatch(publishWorkflow, /refs\/heads\/main/);
    assert.match(publishWorkflow, /package-manager-cache:\s*false/);
    assert.match(publishWorkflow, /corepack prepare pnpm@11\.0\.4 --activate/);
    assert.match(publishWorkflow, /pnpm install --frozen-lockfile --ignore-scripts/);
    assert.match(publishWorkflow, /npm install -g npm@11\.15\.0 --ignore-scripts/);
    assert.match(publishWorkflow, /git merge-base --is-ancestor "\$tag_commit" origin\/main/);
    assert.match(publishWorkflow, /npm stage publish \. --access public --ignore-scripts/);
    assert.doesNotMatch(publishWorkflow, /pnpm publish/);
    assert.doesNotMatch(publishWorkflow, /(?:^|\s)npm publish(?:\s|$)/);
    assert.doesNotMatch(publishWorkflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
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

  it("documents safe release and install guidance", async () => {
    const docs = [
      await readFile(path.join(repoRoot, "README.md"), "utf8"),
      await readFile(path.join(repoRoot, "docs", "release-controls.md"), "utf8"),
    ].join("\n");

    assert.match(docs, /--save-exact --ignore-scripts/);
    assert.match(docs, /pnpm install --frozen-lockfile --ignore-scripts/);
    assert.match(docs, /trusted publishing/);
    assert.match(docs, /npm-publish/);
    assert.match(docs, /pnpm remove @tjalve\/aiu/);
    assert.doesNotMatch(docs, /@latest\b/);
    assert.doesNotMatch(docs, /curl\b[^|\n]*\|\s*(?:sh|bash)/i);
    assert.doesNotMatch(docs, /git\+https?:\/\/|github:[^\s`"]+/i);
  });
});

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

async function readPackDryRun(): Promise<PackDryRun> {
  const result = await execFileAsync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout) as PackDryRun;
}

async function gitLsFiles(paths: readonly string[]): Promise<readonly string[]> {
  const result = await execFileAsync("git", ["ls-files", "--", ...paths], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
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
