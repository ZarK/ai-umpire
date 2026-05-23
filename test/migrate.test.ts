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
const aiuBin = path.join(repoRoot, "dist/src/bin/aiu.js");
const tempRoots: string[] = [];

describe("migration planner", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("detects repo-local hooks and local-checkout references without writing files", async () => {
    const target = await createRepoRoot();
    await mkdir(path.join(target, ".opencode", "plugins"), { recursive: true });
    await writeFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "export const local = true;\n", "utf8");
    await writeFile(
      path.join(target, "package.json"),
      JSON.stringify(
        {
          private: true,
          devDependencies: {
            "@tjalve/aiu": "file:../ai-umpire",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runCli(target, ["migrate", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout) as MigrationEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.migrate.ok, false);
    assert.equal(parsed.migrate.dryRun, true);
    assert.deepEqual(parsed.migrate.repoLocalHooks.map((finding) => finding.relativePath), [
      path.join(".opencode", "plugins", "ai-umpire-continuation.ts"),
    ]);
    assert.deepEqual(parsed.migrate.localCheckoutReferences.map((finding) => finding.relativePath), ["package.json"]);
    assert.ok(parsed.migrate.cleanupCandidates.length >= 2);
    assert.ok(parsed.migrate.conflicts.length >= 2);
    assert.equal(parsed.migrate.statePreservation.action, "preserve");
    assert.equal(parsed.migrate.recommendedNextCommand, "aiu init --dry-run --json");

    const human = await runCli(target, ["migrate", "--dry-run"]);
    assert.equal(human.exitCode, 0);
    assert.match(human.stdout, /Conflicts/);
    assert.match(human.stdout, /migration-review-required/);
    assert.equal(existsSync(path.join(target, ".umpire")), false);
    assert.equal(existsSync(path.join(target, "aiu.config.json")), false);
  });
});

interface MigrationEnvelope {
  readonly ok: boolean;
  readonly migrate: {
    readonly dryRun: boolean;
    readonly ok: boolean;
    readonly repoLocalHooks: Array<{ relativePath: string }>;
    readonly localCheckoutReferences: Array<{ relativePath: string }>;
    readonly scanErrors: unknown[];
    readonly cleanupCandidates: unknown[];
    readonly conflicts: unknown[];
    readonly statePreservation: { action: string };
    readonly recommendedNextCommand: string;
  };
}

async function createRepoRoot(): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), "aiu-migrate-"));
  tempRoots.push(target);
  await mkdir(path.join(target, ".git"));
  return target;
}

async function runCli(cwd: string, input: readonly string[]) {
  try {
    const result = await execFileAsync(process.execPath, [aiuBin, ...input], { cwd });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    assert(error !== null && typeof error === "object");
    const failed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}
