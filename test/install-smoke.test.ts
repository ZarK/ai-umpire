import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const packDir = await createTempRoot("aiu-pack-");
    const target = await createBlankRepo();
    const tarball = await packPackage(packDir);

    await runPnpm(["add", "-D", "--save-exact", "--ignore-scripts", tarball], target);
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

async function createBlankRepo(): Promise<string> {
  const target = await createTempRoot("aiu-install-");
  await mkdir(path.join(target, ".git"));
  await writeFile(
    path.join(target, "package.json"),
    `${JSON.stringify({ private: true, packageManager: "pnpm@11.0.4", devDependencies: {} }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(target, ".npmrc"), "ignore-scripts=true\nsave-exact=true\n", "utf8");
  return target;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
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
