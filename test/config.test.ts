import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    });

    const result = loadAiuConfig({ cwd: repoRoot });

    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.config.hosts.enabled, ["opencode", "codex"]);
    assert.deepEqual(result.config.trustedStateCommands.work?.argv, ["aie", "status", "--json"]);
    assert.equal(result.config.timeouts.commandMs, 10_000);
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
