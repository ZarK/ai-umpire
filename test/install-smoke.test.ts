import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoots: string[] = [];

describe("packed tarball install smoke", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("installs the packed package into a blank repo and runs init dry-run", async () => {
    const root = await createTempRoot("aiu-install-smoke-");
    const packDir = path.join(root, "pack");
    const target = path.join(root, "repo");
    await mkdir(packDir);
    await mkdir(target);
    const tarball = await packPackage(packDir);
    await createLockedBlankRepo(target, tarball);

    await runPnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--offline"], target);
    const result = await runPnpm(["exec", "aiu", "init", "--dry-run", "--json"], target);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;

    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "init");
    assert.equal(parsed.init.ok, true);
    assert.equal(parsed.init.dryRun, true);
    assert.deepEqual(parsed.init.tools, ["opencode", "codex", "claude-code"]);
    assert.equal(parsed.init.files.length, 3);
    assert.equal(parsed.init.config.operation, "create");
    assert.equal(existsSync(path.join(target, "aiu.config.json")), false);
    assert.equal(existsSync(path.join(target, ".opencode")), false);
    assert.equal(existsSync(path.join(target, ".codex")), false);
    assert.equal(existsSync(path.join(target, ".claude")), false);
    assert.equal(existsSync(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts")), false);
    assert.equal(existsSync(path.join(target, ".codex", "hooks", "ai-umpire-stop.json")), false);
    assert.equal(existsSync(path.join(target, ".claude", "hooks", "ai-umpire-stop.json")), false);
  });
});

interface InitEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly init: {
    readonly ok: boolean;
    readonly dryRun: boolean;
    readonly tools: string[];
    readonly files: Array<{ operation: string }>;
    readonly config: { operation: string };
  };
}

async function packPackage(packDir: string): Promise<string> {
  const result = await runPnpm(["pack", "--pack-destination", packDir], repoRoot);
  const packedName = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"));

  assert.ok(packedName, `pnpm pack did not print a tarball name: ${result.stdout}`);
  return path.isAbsolute(packedName) ? packedName : path.join(packDir, packedName);
}

async function createLockedBlankRepo(target: string, tarball: string): Promise<void> {
  await mkdir(path.join(target, ".git"));
  const tarballSpecifier = `file:${path.relative(target, tarball).split(path.sep).join("/")}`;
  await writeFile(
    path.join(target, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        packageManager: "pnpm@11.0.4",
        devDependencies: {
          "@tjalve/aiu": tarballSpecifier,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path.join(target, ".npmrc"), "ignore-scripts=true\nsave-exact=true\n", "utf8");
  await writeFile(path.join(target, "pnpm-lock.yaml"), await buildSmokeLockfile(tarballSpecifier, tarball), "utf8");
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function buildSmokeLockfile(tarballSpecifier: string, tarball: string): Promise<string> {
  const rootLock = await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const lockfileVersion = readLockfileVersion(rootLock);
  const packages = readLockfileSection(rootLock, "packages", "snapshots");
  const snapshots = readLockfileSection(rootLock, "snapshots");
  const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;

  return [
    `lockfileVersion: ${lockfileVersion}`,
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      '@tjalve/aiu':",
    `        specifier: ${tarballSpecifier}`,
    `        version: ${tarballSpecifier}`,
    "",
    "packages:",
    "",
    `  '@tjalve/aiu@${tarballSpecifier}':`,
    `    resolution: {integrity: ${integrity}, tarball: ${tarballSpecifier}}`,
    "    version: 0.0.0",
    "    engines: {node: '>=24.0.0'}",
    "    hasBin: true",
    "",
    packages,
    "snapshots:",
    "",
    `  '@tjalve/aiu@${tarballSpecifier}':`,
    "    dependencies:",
    "      '@tjalve/qube-cli': 0.1.1",
    "",
    snapshots,
  ].join("\n");
}

function readLockfileVersion(lockfile: string): string {
  const match = /^lockfileVersion:\s*(.+)$/m.exec(lockfile);
  assert.ok(match?.[1], "Missing lockfileVersion in pnpm-lock.yaml");
  return match[1];
}

function readLockfileSection(lockfile: string, heading: "packages" | "snapshots", nextHeading?: "snapshots"): string {
  const startMarker = `${heading}:\n\n`;
  const start = lockfile.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${heading} section in pnpm-lock.yaml`);
  const contentStart = start + startMarker.length;
  const contentEnd = nextHeading === undefined ? lockfile.length : lockfile.indexOf(`\n${nextHeading}:\n\n`, contentStart);
  assert.notEqual(contentEnd, -1, `Missing ${nextHeading} section in pnpm-lock.yaml`);
  return `${lockfile.slice(contentStart, contentEnd).trimEnd()}\n`;
}

async function runPnpm(args: readonly string[], cwd: string) {
  try {
    return await execFileAsync("pnpm", [...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (error) {
    assert(error !== null && typeof error === "object");
    const failed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    assert.fail(
      [
        `pnpm ${args.join(" ")} failed with exit code ${failed.code ?? 1}`,
        failed.stdout ?? "",
        failed.stderr ?? "",
      ].join("\n"),
    );
  }
}
