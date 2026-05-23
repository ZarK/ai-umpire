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

describe("init planner", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("emits dry-run JSON without writing files", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "init");
    assert.equal(parsed.init.dryRun, true);
    assert.deepEqual(parsed.init.tools, ["opencode", "codex", "claude-code"]);
    assert.equal(parsed.init.files.length, 6);
    assert.equal(parsed.init.config.operation, "create");
    assert.equal(parsed.init.recommendedNextCommand, "aiu config --json");
    assert.equal(existsSync(path.join(target, "aiu.config.json")), false);
    assert.equal(existsSync(path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts")), false);
  });

  it("applies non-interactive host defaults for each selected tool", async () => {
    const cases = [
      {
        tool: "opencode",
        file: path.join(".opencode", "plugins", "ai-umpire-continuation.ts"),
      },
      {
        tool: "codex",
        file: path.join("plugins", "ai-umpire", "hooks", "hooks.json"),
      },
      {
        tool: "claude-code",
        file: path.join(".claude", "settings.json"),
      },
    ];

    for (const { tool, file } of cases) {
      const target = await createRepoRoot();
      const result = await runCli(target, ["init", "--tool", tool, "--json"]);
      const parsed = JSON.parse(result.stdout) as InitEnvelope;
      const config = JSON.parse(await readFile(path.join(target, "aiu.config.json"), "utf8")) as {
        hosts: { enabled: string[] };
      };

      assert.equal(result.exitCode, 0, tool);
      assert.equal(parsed.init.ok, true, tool);
      assert.deepEqual(parsed.init.tools, [tool], tool);
      assert.equal(existsSync(path.join(target, file)), true, tool);
      assert.deepEqual(config.hosts.enabled, [tool], tool);

      if (tool === "opencode") {
        assert.match(await readFile(path.join(target, file), "utf8"), /createAiuOpenCodePlugin/);
      } else if (tool === "codex") {
        const hooks = JSON.parse(await readFile(path.join(target, file), "utf8")) as {
          Stop: Array<{ hooks: Array<{ command: string; type: string }> }>;
        };
        const marketplace = JSON.parse(await readFile(path.join(target, ".agents", "plugins", "marketplace.json"), "utf8")) as {
          plugins: Array<{ name: string; source: { path: string } }>;
        };
        assert.equal(existsSync(path.join(target, "plugins", "ai-umpire", ".codex-plugin", "plugin.json")), true);
        assert.equal(existsSync(path.join(target, "plugins", "ai-umpire", "skills", "ai-umpire", "SKILL.md")), true);
        assert.equal(hooks.Stop[0]?.hooks[0]?.type, "command");
        assert.equal(hooks.Stop[0]?.hooks[0]?.command, "pnpm exec aiu hook-stop --tool codex");
        assert.equal(marketplace.plugins[0]?.name, "ai-umpire");
        assert.equal(marketplace.plugins[0]?.source.path, "./plugins/ai-umpire");
      } else if (tool === "claude-code") {
        const settings = JSON.parse(await readFile(path.join(target, file), "utf8")) as {
          hooks: { Stop: Array<{ hooks: Array<{ command: string; type: string }> }> };
        };
        assert.equal(settings.hooks.Stop[0]?.hooks[0]?.type, "command");
        assert.equal(settings.hooks.Stop[0]?.hooks[0]?.command, "pnpm exec aiu hook-stop --tool claude-code");
      }
    }
  });

  it("applies --tool all through host capability profiles", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--tool", "all", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;
    const config = JSON.parse(await readFile(path.join(target, "aiu.config.json"), "utf8")) as {
      hosts: { enabled: string[]; capabilities: Record<string, unknown> };
      trustedStateCommands: Record<string, { argv: string[] }>;
    };

    assert.equal(result.exitCode, 0);
    assert.deepEqual(parsed.init.hostProfiles.map((profile) => profile.tool), ["opencode", "codex", "claude-code"]);
    assert.deepEqual(parsed.init.hostProfiles.map((profile) => profile.supportLevel), ["supported", "experimental", "experimental"]);
    assert.deepEqual(config.hosts.enabled, ["opencode", "codex", "claude-code"]);
    assert.ok(config.hosts.capabilities.opencode);
    assert.ok(config.hosts.capabilities.codex);
    assert.ok(config.hosts.capabilities["claude-code"]);
    assert.deepEqual(config.trustedStateCommands.work.argv, ["aie", "status", "--json"]);
  });

  it("preserves conflicting host files unless --force is explicit", async () => {
    const target = await createRepoRoot();
    const wrapper = path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts");
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, "user content\n", "utf8");

    const blocked = await runCli(target, ["init", "--tool", "opencode", "--json"]);
    const blockedPlan = JSON.parse(blocked.stdout) as InitEnvelope;

    assert.equal(blocked.exitCode, 0);
    assert.equal(blockedPlan.init.ok, false);
    assert.equal(blockedPlan.init.files[0]?.operation, "conflict");
    assert.equal(await readFile(wrapper, "utf8"), "user content\n");
    assert.equal(existsSync(path.join(target, "aiu.config.json")), false);

    const forced = await runCli(target, ["init", "--tool", "opencode", "--force", "--json"]);
    const forcedPlan = JSON.parse(forced.stdout) as InitEnvelope;

    assert.equal(forced.exitCode, 0);
    assert.equal(forcedPlan.init.ok, true);
    assert.equal(forcedPlan.init.files[0]?.operation, "update");
    assert.match(await readFile(wrapper, "utf8"), /Managed by @tjalve\/aiu/);
  });

  it("does not apply a stale plan over newly conflicting files", async () => {
    const target = await createRepoRoot();
    const { applyAiuInitPlan, planAiuInit } = await import(path.join(repoRoot, "dist/src/init.js")) as {
      applyAiuInitPlan: (plan: InitPlan) => InitPlan;
      planAiuInit: (options: { cwd: string; tool: string }) => InitPlan;
    };
    const plan = planAiuInit({ cwd: target, tool: "opencode" });
    const wrapper = path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts");
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, "late user content\n", "utf8");

    const applied = applyAiuInitPlan(plan);

    assert.equal(applied.ok, false);
    assert.equal(applied.files[0]?.operation, "conflict");
    assert.equal(await readFile(wrapper, "utf8"), "late user content\n");
    assert.equal(existsSync(path.join(target, "aiu.config.json")), false);
  });

  it("treats unreadable managed paths as conflicts", async () => {
    const target = await createRepoRoot();
    const wrapper = path.join(target, ".opencode", "plugins", "ai-umpire-continuation.ts");
    await mkdir(wrapper, { recursive: true });

    const result = await runCli(target, ["init", "--tool", "opencode", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.init.ok, false);
    assert.equal(parsed.init.files[0]?.operation, "conflict");
    assert.match(parsed.init.files[0]?.reason ?? "", /could not be read/);
  });

  it("compares existing config semantically and reports merged config details", async () => {
    const target = await createRepoRoot();
    await runCli(target, ["init", "--tool", "all", "--json"]);
    const config = JSON.parse(await readFile(path.join(target, "aiu.config.json"), "utf8"));
    await writeFile(path.join(target, "aiu.config.json"), JSON.stringify(config), "utf8");

    const result = await runCli(target, ["init", "--tool", "all", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout) as InitEnvelope;

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.init.config.operation, "skip");
    assert.deepEqual(parsed.init.config.hosts, ["opencode", "codex", "claude-code"]);
    assert.deepEqual(parsed.init.config.trustedStateCommands, ["work"]);
  });

  it("human output names created, updated, skipped, and conflicted files", async () => {
    const target = await createRepoRoot();
    const result = await runCli(target, ["init", "--dry-run"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Created:/);
    assert.match(result.stdout, /Updated:/);
    assert.match(result.stdout, /Skipped:/);
    assert.match(result.stdout, /Conflicts:/);
    assert.match(result.stdout, /Config changes:/);
  });
});

interface InitEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly init: {
    readonly ok: boolean;
    readonly dryRun: boolean;
    readonly tools: string[];
    readonly hostProfiles: Array<{ tool: string; supportLevel: string }>;
    readonly files: Array<{ operation: string; reason?: string }>;
    readonly config: { operation: string; hosts: string[]; trustedStateCommands: string[] };
    readonly recommendedNextCommand: string;
  };
}

interface InitPlan {
  readonly ok: boolean;
  readonly files: Array<{ operation: string }>;
}

async function createRepoRoot(): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), "aiu-init-"));
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
