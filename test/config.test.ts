import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadAiuConfig } from "../src/config.ts";

const tempRoots: string[] = [];

describe("config foundation", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("discovers missing repository config and returns conservative defaults", async () => {
    const repoRoot = await createRepoRoot();
    const result = loadAiuConfig({ cwd: path.join(repoRoot, "nested") });

    assert.equal(result.ok, true);
    assert.equal(result.found, false);
    assert.equal(result.defaultsUsed, true);
    assert.equal(result.selectedPath, path.join(repoRoot, "aiu.config.json"));
    assert.equal(result.config.version, 1);
    assert.deepEqual(result.config.paths, {
      stateDir: ".umpire/state",
      lockDir: ".umpire/locks",
      logDir: ".umpire/logs",
    });
    assert.equal(result.config.continuation.stopOnUnknownState, true);
    assert.equal(result.config.continuation.stopOnUnsafeState, true);
    assert.equal(result.config.continuation.stopOnSupplyChainApprovalBlock, true);
    assert.equal(result.config.continuation.allowBackgroundScheduling, false);
    assert.equal(result.config.continuation.trustUnstructuredProse, false);
    assert.equal(result.config.supplyChain.stopOnApprovalRequired, true);
    assert.equal(result.config.whip.enabled, true);
    assert.equal(result.config.whip.usePackageDefaults, true);
    assert.deepEqual(result.config.whip.tasks, []);
    assert.equal(result.config.whip.statePath, ".umpire/whip.json");
  });

  it("loads valid config with argv trusted state descriptors", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      hosts: {
        enabled: ["opencode", "codex"],
        capabilities: {
          opencode: {
            stopHook: true,
            promptDelivery: "host",
          },
        },
      },
      trustedStateCommands: {
        work: {
          argv: ["aie", "status", "--json"],
          timeoutMs: 10_000,
          maxOutputBytes: 65_536,
        },
      },
      continuation: {
        modes: ["continue", "repair", "wait", "stop"],
        stopOnUnknownState: true,
        stopOnUnsafeState: true,
        stopOnSupplyChainApprovalBlock: true,
        allowProviderMutation: false,
        allowBackgroundScheduling: false,
        trustUnstructuredProse: false,
      },
      timeouts: {
        commandMs: 10_000,
        hostMs: 2_000,
      },
      cooldowns: {
        promptMs: 120_000,
      },
      paths: {
        stateDir: ".umpire/state",
        lockDir: ".umpire/locks",
        logDir: ".umpire/logs",
      },
      supplyChain: {
        stopOnApprovalRequired: true,
      },
      whip: {
        enabled: false,
        usePackageDefaults: false,
        statePath: ".umpire/custom-whip.json",
        tasks: [
          {
            id: "repo-docs",
            title: "Review repo docs",
            prompt: "Review repository docs for stale aiu examples.",
            priority: 10,
          },
        ],
      },
    });

    const result = loadAiuConfig({ cwd: repoRoot });

    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.config.hosts.enabled, ["opencode", "codex"]);
    assert.deepEqual(result.config.trustedStateCommands.work?.argv, ["aie", "status", "--json"]);
    assert.equal(result.config.timeouts.commandMs, 10_000);
    assert.equal(result.config.whip.enabled, false);
    assert.equal(result.config.whip.usePackageDefaults, false);
    assert.equal(result.config.whip.statePath, ".umpire/custom-whip.json");
    assert.deepEqual(result.config.whip.tasks.map((task) => task.id), ["repo-docs"]);
  });

  it("returns stable validation diagnostics for unsafe config", async () => {
    const repoRoot = await createRepoRoot();
    await writeFile(path.join(repoRoot, "state-file"), "not a directory\n", "utf8");
    await writeConfig(repoRoot, {
      version: 1,
      hosts: {
        enabled: ["neovim"],
      },
      trustedStateCommands: {
        unsafe: {
          command: "aie status --json",
        },
        missing: {
          argv: [],
        },
      },
      continuation: {
        modes: ["continue"],
        stopOnSupplyChainApprovalBlock: true,
        allowBackgroundScheduling: true,
        trustUnstructuredProse: true,
        legacyHelperMode: true,
      },
      timeouts: {
        commandMs: 0,
      },
      paths: {
        stateDir: "state-file",
      },
      supplyChain: {
        stopOnApprovalRequired: false,
      },
      whip: {
        enabled: "sometimes",
        tasks: [
          {
            id: "bad id",
            title: "",
            prompt: "",
            priority: -1,
          },
        ],
      },
      runtimeFallback: true,
    });

    const result = loadAiuConfig({ cwd: repoRoot });
    const kinds = result.diagnostics.map((diagnostic) => diagnostic.kind);

    assert.equal(result.ok, false);
    assert.ok(kinds.includes("invalid-host"));
    assert.ok(kinds.includes("unsafe-command-descriptor"));
    assert.ok(kinds.includes("missing-command-path"));
    assert.ok(kinds.includes("invalid-duration"));
    assert.ok(kinds.includes("contradictory-policy"));
    assert.ok(kinds.includes("path-not-directory"));
    assert.ok(kinds.includes("unsafe-policy"));
    assert.ok(kinds.includes("legacy-fallback-unsupported"));
    assert.ok(kinds.includes("invalid-boolean"));
    assert.ok(kinds.includes("invalid-whip-task-id"));
    assert.ok(kinds.includes("invalid-whip-task-title"));
    assert.ok(kinds.includes("invalid-whip-task-prompt"));
    assert.ok(kinds.includes("invalid-whip-task-priority"));
  });

  it("rejects state paths below file ancestors and non-searchable directories", async (t) => {
    const repoRoot = await createRepoRoot();
    const blockedDir = path.join(repoRoot, "blocked-dir");
    await writeFile(path.join(repoRoot, "state-parent-file"), "not a directory\n", "utf8");
    await mkdir(blockedDir);
    await chmod(blockedDir, 0o600);
    if (canAccess(blockedDir, constants.W_OK | constants.X_OK)) {
      await chmod(blockedDir, 0o700);
      t.skip("directory search permission is not enforced on this platform or user");
      return;
    }

    try {
      await writeConfig(repoRoot, {
        version: 1,
        paths: {
          stateDir: "state-parent-file/child",
          lockDir: "blocked-dir/locks",
          logDir: ".umpire/logs",
        },
      });

      const result = loadAiuConfig({ cwd: repoRoot });
      const pathDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.kind === "path-not-writable");

      assert.equal(result.ok, false);
      assert.ok(pathDiagnostics.some((diagnostic) => diagnostic.path === "$.paths.stateDir"));
      assert.ok(pathDiagnostics.some((diagnostic) => diagnostic.path === "$.paths.lockDir"));
    } finally {
      await chmod(blockedDir, 0o700);
    }
  });

  it("rejects whip state paths that cannot be written as files", async () => {
    const repoRoot = await createRepoRoot();
    await mkdir(path.join(repoRoot, "whip-state-dir"));
    await writeFile(path.join(repoRoot, "state-parent-file"), "not a directory\n", "utf8");
    await writeConfig(repoRoot, {
      version: 1,
      whip: {
        statePath: "whip-state-dir",
      },
    });
    const directoryResult = loadAiuConfig({ cwd: repoRoot });

    assert.equal(directoryResult.ok, false);
    assert.ok(directoryResult.diagnostics.some((diagnostic) => diagnostic.kind === "path-not-writable" && diagnostic.path === "$.whip.statePath"));

    await writeConfig(repoRoot, {
      version: 1,
      whip: {
        statePath: "state-parent-file/whip.json",
      },
    });
    const fileAncestorResult = loadAiuConfig({ cwd: repoRoot });

    assert.equal(fileAncestorResult.ok, false);
    assert.ok(fileAncestorResult.diagnostics.some((diagnostic) => diagnostic.kind === "path-not-writable" && diagnostic.path === "$.whip.statePath"));
  });

  it("does not validate unused whip state paths when whip is disabled", async () => {
    const repoRoot = await createRepoRoot();
    await mkdir(path.join(repoRoot, "whip-state-dir"));
    await writeConfig(repoRoot, {
      version: 1,
      whip: {
        enabled: false,
        statePath: "",
      },
    });

    const result = loadAiuConfig({ cwd: repoRoot });

    assert.equal(result.ok, true);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.config.whip.statePath, ".umpire/whip.json");
  });
});

async function createRepoRoot(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "aiu-config-"));
  tempRoots.push(repoRoot);
  await mkdir(path.join(repoRoot, ".git"));
  await mkdir(path.join(repoRoot, "nested"));
  return repoRoot;
}

async function writeConfig(repoRoot: string, config: unknown): Promise<void> {
  await writeFile(path.join(repoRoot, "aiu.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function canAccess(targetPath: string, mode: number): boolean {
  try {
    accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}
