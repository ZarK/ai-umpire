import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("defaults to non-mutating dry-run behavior for empty repositories", async () => {
    const target = await createRepoRoot();

    const result = await runCli(target, ["migrate", "--json"]);
    const parsed = JSON.parse(result.stdout) as MigrationEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.migrate.ok, true);
    assert.equal(parsed.migrate.dryRun, true);
    assert.deepEqual(parsed.migrate.inventory, []);
    assert.equal(parsed.migrate.filesToCreate.length >= 3, true);
    assert.equal(existsSync(path.join(target, "aiu.config.json")), false);
    assert.equal(existsSync(path.join(target, ".umpire")), false);
  });

  it("preserves already package-backed host files without conflicts", async () => {
    const target = await createRepoRoot();
    await mkdir(path.join(target, ".opencode", "plugins"), { recursive: true });
    await writeFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), [
      "// Managed by @tjalve/aiu.",
      "// Compose custom behavior outside this package-managed file.",
      "import { createAiuOpenCodePlugin } from \"@tjalve/aiu/opencode\";",
      "",
      "export default createAiuOpenCodePlugin();",
      "",
    ].join("\n"), "utf8");

    const result = await runCli(target, ["migrate", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout) as MigrationEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.migrate.ok, true);
    assert.deepEqual(parsed.migrate.repoLocalHooks, []);
    assert.ok(parsed.migrate.filesToPreserve.some((item) => item.relativePath === path.join(".opencode", "plugins", "ai-umpire-continuation.ts") && item.category === "package-backed-host-file"));
  });

  it("detects migration inventory and full dry-run plan without writing files", async () => {
    const target = await createRepoRoot();
    await mkdir(path.join(target, ".opencode", "plugins"), { recursive: true });
    await mkdir(path.join(target, ".opencode", "commands"), { recursive: true });
    await mkdir(path.join(target, ".codex", "hooks"), { recursive: true });
    await mkdir(path.join(target, ".claude"), { recursive: true });
    await mkdir(path.join(target, ".agents", "plugins"), { recursive: true });
    await mkdir(path.join(target, "packages", "app"), { recursive: true });
    await mkdir(path.join(target, "packages", "lib"), { recursive: true });
    await mkdir(path.join(target, "plugins", "ai-umpire", "hooks"), { recursive: true });
    await mkdir(path.join(target, "scripts"), { recursive: true });
    await mkdir(path.join(target, ".umpire"), { recursive: true });
    await writeFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "export const local = true;\n", "utf8");
    await writeFile(path.join(target, ".agents", "plugins", "marketplace.json"), JSON.stringify({ managedBy: "@tjalve/aiu", extraLocalPolicy: true }), "utf8");
    await writeFile(path.join(target, ".codex", "hooks", "ai-umpire-stop.json"), JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: "node scripts/aiu-stop.js" }] }] }), "utf8");
    await writeFile(path.join(target, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "pnpm exec aiu hook-stop --tool claude-code" }] }] }, custom: true }), "utf8");
    await writeFile(path.join(target, "plugins", "ai-umpire", "hooks", "hooks.json"), JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: "node scripts/aiu-stop.js" }] }] }), "utf8");
    await writeFile(path.join(target, "scripts", "aiu-stop.js"), "console.log('ai-umpire hook-stop helper');\n", "utf8");
    await writeFile(path.join(target, ".opencode", "commands", "make-it-so.md"), "Run the local AI Umpire continuation prompt.\n", "utf8");
    await writeFile(path.join(target, ".opencode", "mystery.md"), "Umpire notes from an unknown local customization.\n", "utf8");
    await writeFile(path.join(target, ".umpire", "whip.json"), JSON.stringify({ schemaVersion: 1, tasks: [] }), "utf8");
    await writeFile(path.join(target, "AGENTS.md"), "Use ../ai-umpire local command paths until migrated.\n", "utf8");
    await writeFile(path.join(target, "aiu.config.json"), JSON.stringify({
      version: 1,
      prompts: { sections: { work: { prepend: "Repo prompt." } } },
      trustedStateCommands: {
        work: { argv: ["aie", "status", "--json"] },
      },
    }, null, 2), "utf8");
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
    await writeFile(path.join(target, "packages", "app", "package.json"), JSON.stringify({
      private: true,
      dependencies: {
        "@tjalve/aiu": "link:../../ai-umpire",
      },
    }, null, 2), "utf8");
    await writeFile(path.join(target, "packages", "lib", "package.json"), JSON.stringify({
      private: true,
      dependencies: {
        "@tjalve/aiu": "0.0.0",
      },
    }, null, 2), "utf8");

    const result = await runCli(target, ["migrate", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout) as MigrationEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.migrate.ok, false);
    assert.equal(parsed.migrate.dryRun, true);
    assert.equal(parsed.migrate.configPath.endsWith("aiu.config.json"), true);
    assert.deepEqual(parsed.migrate.repoLocalHooks.map((finding) => finding.relativePath).sort(), [
      ".agents/plugins/marketplace.json",
      ".claude/settings.json",
      ".codex/hooks/ai-umpire-stop.json",
      path.join(".opencode", "plugins", "ai-umpire-continuation.ts"),
      path.join("plugins", "ai-umpire", "hooks", "hooks.json"),
    ]);
    assert.deepEqual(parsed.migrate.localCheckoutReferences.map((finding) => finding.relativePath).sort(), ["AGENTS.md", "package.json", path.join("packages", "app", "package.json")]);
    assert.ok(parsed.migrate.copiedHelpers.some((finding) => finding.relativePath === path.join("scripts", "aiu-stop.js")));
    assert.ok(parsed.migrate.commandWrappers.some((finding) => finding.relativePath === path.join(".opencode", "commands", "make-it-so.md")));
    assert.ok(parsed.migrate.promptCustomizations.some((finding) => finding.relativePath === "aiu.config.json"));
    assert.ok(parsed.migrate.stateFindings.some((finding) => finding.relativePath === path.join(".umpire", "whip.json")));
    assert.ok(parsed.migrate.hostInstructionReferences.some((finding) => finding.relativePath === "AGENTS.md"));
    assert.ok(parsed.migrate.trustedCommandDescriptors.some((finding) => finding.sourceCommandSummary === "aie status --json"));
    assert.ok(parsed.migrate.reviewRequired.some((finding) => finding.category === "unknown-aiu-file" && finding.relativePath === path.join(".opencode", "mystery.md")));
    assert.equal(parsed.migrate.reviewRequired.some((finding) => finding.category === "unknown-aiu-file" && finding.relativePath === path.join("packages", "lib", "package.json")), false);
    assert.ok(parsed.migrate.cleanupCandidates.length >= 4);
    assert.ok(parsed.migrate.conflicts.length >= 6);
    assert.ok(parsed.migrate.filesToCreate.length >= 1);
    assert.ok(parsed.migrate.filesToUpdate.some((item) => item.relativePath === "package.json"));
    assert.ok(parsed.migrate.filesToPreserve.some((item) => item.relativePath === path.join(".umpire", "whip.json")));
    assert.ok(parsed.migrate.packageBackedCommandPaths.some((command) => command.command === "pnpm exec aiu hook-stop --tool codex"));
    assert.equal(parsed.migrate.statePreservation.action, "preserve");
    assert.ok(parsed.migrate.stateMigrations.some((item) => item.relativePath === path.join(".umpire", "whip.json") && item.recognized));
    assert.ok(parsed.migrate.requiredConfirmations.length >= 3);
    assert.ok(parsed.migrate.hostTrustSteps.length >= 3);
    assert.equal(parsed.migrate.recommendedNextCommand, "aiu init --dry-run --json");

    const human = await runCli(target, ["migrate", "--dry-run"]);
    assert.equal(human.exitCode, 0);
    assert.match(human.stdout, /Conflicts/);
    assert.match(human.stdout, /migration-review-required/);
    assert.equal(existsSync(path.join(target, ".umpire", "whip.json")), true);
    assert.equal(existsSync(path.join(target, "aiu.config.json")), true);
  });

  it("applies package-backed config and managed host files only when explicitly requested", async () => {
    const target = await createRepoRoot();

    const dryRun = await runCli(target, ["migrate", "--json"]);
    const dryRunJson = JSON.parse(dryRun.stdout) as MigrationEnvelope;
    assert.equal(dryRunJson.migrate.dryRun, true);
    assert.equal(existsSync(path.join(target, "aiu.config.json")), false);

    const result = await runCli(target, ["migrate", "--apply", "--json"]);
    const parsed = JSON.parse(result.stdout) as MigrationApplyEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.migrate.applied, true);
    assert.equal(parsed.migrate.dryRun, false);
    assert.equal(parsed.migrate.ok, true);
    assert.ok(parsed.migrate.changed.some((item) => item.relativePath === "aiu.config.json" && item.action === "create"));
    assert.ok(parsed.migrate.changed.some((item) => item.relativePath === path.join(".opencode", "plugins", "ai-umpire-continuation.ts")));
    assert.equal(existsSync(path.join(target, "aiu.config.json")), true);
    const config = JSON.parse(await readFile(path.join(target, "aiu.config.json"), "utf8")) as { hosts: { enabled: string[] }; trustedStateCommands: Record<string, unknown> };
    assert.deepEqual(config.hosts.enabled, ["opencode", "codex", "claude-code"]);
    assert.ok("work" in config.trustedStateCommands);
    assert.match(await readFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "utf8"), /@tjalve\/aiu\/opencode/);
    assert.equal(existsSync(path.join(target, ".umpire")), false);
  });

  it("preserves existing config, prompt customizations, and state while reporting conflicts", async () => {
    const target = await createRepoRoot();
    await mkdir(path.join(target, ".opencode", "plugins"), { recursive: true });
    await mkdir(path.join(target, ".umpire"), { recursive: true });
    await writeFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "export const repoLocalPrompt = true;\n", "utf8");
    await writeFile(path.join(target, ".umpire", "continuation.json"), JSON.stringify({ schemaVersion: 1, active: true }), "utf8");
    await writeFile(path.join(target, "aiu.config.json"), JSON.stringify({
      version: 1,
      prompts: { sections: { work: { prepend: "Keep this repo prompt." } } },
      trustedStateCommands: {
        work: { argv: ["aie", "status", "--json"] },
      },
      hosts: { enabled: ["opencode"] },
    }, null, 2), "utf8");

    const result = await runCli(target, ["migrate", "--apply", "--json"]);
    const parsed = JSON.parse(result.stdout) as MigrationApplyEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.migrate.ok, false);
    assert.ok(parsed.migrate.conflicted.some((item) => item.relativePath === path.join(".opencode", "plugins", "ai-umpire-continuation.ts")));
    assert.ok(parsed.migrate.reviewRequired.some((item) => item.relativePath === path.join(".opencode", "plugins", "ai-umpire-continuation.ts")));
    assert.equal(parsed.migrate.recommendedNextCommand, "aiu migrate --apply --force --json");
    assert.ok(parsed.migrate.preserved.some((item) => item.relativePath === "aiu.config.json" && item.category === "existing-config"));
    assert.ok(parsed.migrate.preserved.some((item) => item.relativePath === path.join(".umpire", "continuation.json")));
    assert.equal(await readFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "utf8"), "export const repoLocalPrompt = true;\n");
    assert.match(await readFile(path.join(target, "aiu.config.json"), "utf8"), /Keep this repo prompt/);
    assert.match(await readFile(path.join(target, ".umpire", "continuation.json"), "utf8"), /"active":true/);
  });

  it("force apply replaces managed host files when no non-managed blockers remain", async () => {
    const target = await createRepoRoot();
    await mkdir(path.join(target, ".opencode", "plugins"), { recursive: true });
    await writeFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "export const oldLocalHook = true;\n", "utf8");

    const result = await runCli(target, ["migrate", "--apply", "--force", "--json"]);
    const parsed = JSON.parse(result.stdout) as MigrationApplyEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.migrate.force, true);
    assert.equal(parsed.migrate.ok, true);
    assert.ok(parsed.migrate.changed.some((item) => item.relativePath === path.join(".opencode", "plugins", "ai-umpire-continuation.ts") && item.action === "update"));
    assert.equal(parsed.migrate.recommendedNextCommand, "aiu doctor --json");
    assert.match(await readFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "utf8"), /createAiuOpenCodePlugin/);
  });

  it("does not partially apply force when non-managed cleanup candidates remain", async () => {
    const target = await createRepoRoot();
    await mkdir(path.join(target, ".opencode", "plugins"), { recursive: true });
    await mkdir(path.join(target, "scripts"), { recursive: true });
    await writeFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "export const oldLocalHook = true;\n", "utf8");
    await writeFile(path.join(target, "scripts", "aiu-stop.js"), "console.log('old ai-umpire helper');\n", "utf8");

    const result = await runCli(target, ["migrate", "--apply", "--force", "--json"]);
    const parsed = JSON.parse(result.stdout) as MigrationApplyEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.migrate.force, true);
    assert.equal(parsed.migrate.ok, false);
    assert.equal(parsed.migrate.changed.some((item) => item.relativePath === path.join(".opencode", "plugins", "ai-umpire-continuation.ts")), false);
    assert.ok(parsed.migrate.skipped.some((item) => item.relativePath === path.join("scripts", "aiu-stop.js") && item.category === "cleanup-candidate"));
    assert.equal(parsed.migrate.recommendedNextCommand, "Review reported paths, then rerun aiu migrate --dry-run --json.");
    assert.equal(await readFile(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts"), "utf8"), "export const oldLocalHook = true;\n");
    assert.equal(await readFile(path.join(target, "scripts", "aiu-stop.js"), "utf8"), "console.log('old ai-umpire helper');\n");
  });

  it("reports managed write failures as conflicts without aborting apply output", async () => {
    const target = await createRepoRoot();
    await writeFile(path.join(target, ".opencode"), "not a directory\n", "utf8");

    const result = await runCli(target, ["migrate", "--apply", "--json"]);
    const parsed = JSON.parse(result.stdout) as MigrationApplyEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.migrate.ok, false);
    assert.ok(parsed.migrate.conflicted.some((item) => item.relativePath === path.join(".opencode", "plugins", "ai-umpire-continuation.ts") && item.category === "package-managed-host-file"));
    assert.equal(await readFile(path.join(target, ".opencode"), "utf8"), "not a directory\n");
  });
});

interface MigrationEnvelope {
  readonly ok: boolean;
  readonly migrate: {
    readonly dryRun: boolean;
    readonly ok: boolean;
    readonly configPath: string;
    readonly inventory: unknown[];
    readonly packageBackedCommandPaths: Array<{ command: string }>;
    readonly repoLocalHooks: Array<{ relativePath: string }>;
    readonly localCheckoutReferences: Array<{ relativePath: string }>;
    readonly copiedHelpers: Array<{ relativePath: string }>;
    readonly commandWrappers: Array<{ relativePath: string }>;
    readonly promptCustomizations: Array<{ relativePath: string }>;
    readonly stateFindings: Array<{ relativePath: string }>;
    readonly hostInstructionReferences: Array<{ relativePath: string }>;
    readonly trustedCommandDescriptors: Array<{ relativePath: string; sourceCommandSummary?: string }>;
    readonly reviewRequired: Array<{ relativePath: string; category: string }>;
    readonly scanErrors: unknown[];
    readonly cleanupCandidates: unknown[];
    readonly conflicts: unknown[];
    readonly filesToCreate: Array<{ relativePath: string; category: string }>;
    readonly filesToUpdate: Array<{ relativePath: string; category: string }>;
    readonly filesToPreserve: Array<{ relativePath: string; category: string }>;
    readonly statePreservation: { action: string };
    readonly stateMigrations: Array<{ relativePath: string; recognized: boolean }>;
    readonly requiredConfirmations: string[];
    readonly hostTrustSteps: string[];
    readonly recommendedNextCommand: string;
  };
}

interface MigrationApplyEnvelope {
  readonly ok: boolean;
  readonly migrate: {
    readonly ok: boolean;
    readonly dryRun: boolean;
    readonly applied: boolean;
    readonly force: boolean;
    readonly changed: Array<{ relativePath: string; action: string; category: string }>;
    readonly preserved: Array<{ relativePath: string; action: string; category: string }>;
    readonly skipped: Array<{ relativePath: string; action: string; category: string }>;
    readonly conflicted: Array<{ relativePath: string; action: string; category: string }>;
    readonly reviewRequired: Array<{ relativePath: string; action: string; category: string }>;
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
