import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { getAiuResolvedPaths, runAiuDoctor } from "../dist/src/doctor.js";
import { getAiuHostCapabilityProfile } from "../dist/src/host_policy.js";

const tempRoots: string[] = [];

describe("doctor diagnostics", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reports healthy package, config, and state paths", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, { version: 1 });

    const report = runAiuDoctor({ cwd: repoRoot });

    assert.equal(report.status, "warning");
    assert.equal(report.config.found, true);
    assert.equal(report.config.valid, true);
    assert.ok(report.checks.some((check) => check.kind === "node-version-supported"));
    assert.ok(report.checks.some((check) => check.kind === "package-name-valid"));
    assert.ok(report.checks.some((check) => check.kind === "state-path-creatable"));
    assert.ok(report.checks.some((check) => check.kind === "host-runtime-disabled"));
  });

  it("reports missing config without mutating the repository", async () => {
    const repoRoot = await createRepoRoot();

    const report = runAiuDoctor({ cwd: repoRoot });

    assert.equal(report.status, "warning");
    assert.equal(report.config.found, false);
    assert.ok(report.checks.some((check) => check.kind === "config-missing"));
  });

  it("reports invalid config with stable error kinds", async () => {
    const repoRoot = await createRepoRoot();
    await writeFile(path.join(repoRoot, "aiu.config.json"), "{ invalid json", "utf8");

    const report = runAiuDoctor({ cwd: repoRoot });
    const kinds = report.checks.map((check) => check.kind);

    assert.equal(report.status, "error");
    assert.equal(report.config.valid, false);
    assert.ok(kinds.includes("config-invalid"));
    assert.ok(kinds.includes("invalid-json"));
  });

  it("reports missing configured host files", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      hosts: {
        enabled: ["codex"],
        modes: {
          codex: ["stop"],
        },
      },
    });

    const report = runAiuDoctor({ cwd: repoRoot });

    assert.equal(report.status, "warning");
    assert.ok(report.checks.some((check) => check.kind === "host-file-missing" && check.path?.endsWith(path.join("plugins", "ai-umpire", "hooks", "hooks.json"))));
  });

  it("reports package-backed host entrypoints for installed managed files", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      hosts: {
        enabled: ["opencode", "codex", "claude-code"],
        modes: {
          opencode: ["continue", "repair", "wait", "stop"],
          codex: ["stop"],
          "claude-code": ["stop"],
        },
      },
    });
    await writeManagedHostFiles(repoRoot, "opencode");
    await writeManagedHostFiles(repoRoot, "codex");
    await writeManagedHostFiles(repoRoot, "claude-code");

    const report = runAiuDoctor({ cwd: repoRoot });
    const entrypointChecks = report.checks.filter((check) => check.kind === "host-entrypoint-package-backed");

    assert.equal(entrypointChecks.length, 3);
    assert.ok(entrypointChecks.some((check) => check.path?.endsWith(path.join(".opencode", "plugins", "ai-umpire-continuation.ts"))));
    assert.ok(entrypointChecks.some((check) => check.path?.endsWith(path.join("plugins", "ai-umpire", "hooks", "hooks.json"))));
    assert.ok(entrypointChecks.some((check) => check.path?.endsWith(path.join(".claude", "settings.json"))));
  });

  it("reports unmanaged host entrypoints that do not delegate to the package runtime", async () => {
    const repoRoot = await createRepoRoot();
    const hookPath = path.join(repoRoot, "plugins", "ai-umpire", "hooks", "hooks.json");
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: "node scripts/old-aiu-hook.js" }] }] }), "utf8");
    await writeConfig(repoRoot, {
      version: 1,
      hosts: {
        enabled: ["codex"],
        modes: {
          codex: ["stop"],
        },
      },
    });

    const report = runAiuDoctor({ cwd: repoRoot });

    assert.ok(report.checks.some((check) => check.kind === "host-entrypoint-unmanaged" && check.path === hookPath));
  });

  it("reports host capability and policy compatibility", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      hosts: {
        enabled: ["opencode", "codex"],
        capabilities: {
          opencode: {
            promptDelivery: "none",
          },
        },
        modes: {
          opencode: ["continue"],
          codex: ["continue"],
        },
      },
    });

    const report = runAiuDoctor({ cwd: repoRoot });

    assert.equal(report.status, "error");
    assert.ok(report.checks.some((check) => check.kind === "host-capability-disabled" && check.category === "host"));
    assert.ok(report.checks.some((check) => check.kind === "host-capability-experimental" && check.category === "host"));
    assert.equal(report.checks.filter((check) => check.kind === "host-capability-disabled").length, 1);
  });

  it("reports unsafe stop-hook blocking even when no host is enabled", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      hosts: {
        enabled: [],
        stopHookBlocking: {
          codex: true,
        },
      },
    });

    const report = runAiuDoctor({ cwd: repoRoot });

    assert.equal(report.status, "error");
    assert.ok(report.checks.some((check) => check.kind === "host-runtime-disabled" && check.category === "host"));
    const stopHookCheck = report.checks.find((check) => check.kind === "host-stop-hook-blocking-unsafe" && check.category === "host");
    assert.ok(stopHookCheck);
    assert.match(stopHookCheck.suggestedNextAction, /hosts\.stopHookBlocking\.codex/);
  });

  it("reports trusted command availability without executing commands", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      trustedStateCommands: {
        node: {
          argv: [process.execPath, "--version"],
        },
        missing: {
          argv: ["definitely-not-aiu-test-command"],
        },
      },
    });

    const report = runAiuDoctor({ cwd: repoRoot });
    const trustedChecks = report.checks.filter((check) => check.category === "trusted-command");

    assert.equal(report.status, "error");
    assert.ok(trustedChecks.some((check) => check.kind === "trusted-command-found" && check.path === process.execPath));
    assert.ok(trustedChecks.some((check) => check.kind === "trusted-command-missing" && check.path === "definitely-not-aiu-test-command"));
  });

  it("reports idle mode readiness and whip ownership diagnostics without mutating state", async () => {
    const repoRoot = await createRepoRoot();
    const whipPath = path.join(repoRoot, ".umpire", "whip.json");
    await mkdir(path.dirname(whipPath), { recursive: true });
    const whipState = {
      schemaVersion: 1,
      tasks: [{
        id: "owned",
        title: "Owned idle task",
        prompt: "Inspect one stale doc example and update it only if incorrect.",
        priority: 1,
        status: "prompted",
        source: "cli",
        ownerSessionId: "ses_old",
        promptedAt: "2026-05-20T00:00:00.000Z",
      }],
    };
    await writeFile(whipPath, `${JSON.stringify(whipState, null, 2)}\n`, "utf8");
    await writeConfig(repoRoot, {
      version: 1,
      trustedStateCommands: {
        planning: { argv: [process.execPath, "--version"] },
        quality: { argv: [process.execPath, "--version"] },
      },
    });

    const before = await readText(whipPath);
    const report = runAiuDoctor({ cwd: repoRoot });
    const after = await readText(whipPath);
    const kinds = report.checks.map((check) => check.kind);

    assert.equal(after, before);
    assert.ok(kinds.includes("planning-mode-enabled"));
    assert.ok(kinds.includes("planning-trusted-command-found"));
    assert.ok(kinds.includes("quality-mode-enabled"));
    assert.ok(kinds.includes("quality-trusted-command-found"));
    assert.ok(kinds.includes("whip-state-valid"));
    assert.ok(kinds.includes("whip-stale-ownership"));
    assert.ok(kinds.includes("whip-orphaned-ownership"));
  });

  it("reports disabled idle modes without validating disabled whip state", async () => {
    const repoRoot = await createRepoRoot();
    await mkdir(path.join(repoRoot, ".umpire"), { recursive: true });
    await writeFile(path.join(repoRoot, ".umpire", "whip.json"), "{", "utf8");
    await writeConfig(repoRoot, {
      version: 1,
      planning: { enabled: false },
      quality: { enabled: false },
      whip: { enabled: false },
    });

    const report = runAiuDoctor({ cwd: repoRoot });
    const kinds = report.checks.map((check) => check.kind);

    assert.ok(kinds.includes("planning-mode-disabled"));
    assert.ok(kinds.includes("quality-mode-disabled"));
    assert.ok(kinds.includes("whip-mode-disabled"));
    assert.equal(kinds.includes("whip-state-malformed"), false);
  });

  it("requires exact idle mode trusted command source ids", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      trustedStateCommands: {
        preplanning: { argv: [process.execPath, "--version"] },
        qualityish: { argv: [process.execPath, "--version"] },
      },
    });

    const report = runAiuDoctor({ cwd: repoRoot });
    const planningChecks = report.checks.filter((check) => check.id.startsWith("planning-trusted-command"));
    const qualityChecks = report.checks.filter((check) => check.id.startsWith("quality-trusted-command"));

    assert.equal(planningChecks.length, 1);
    assert.equal(planningChecks[0]?.kind, "planning-trusted-command-missing");
    assert.equal(qualityChecks.length, 1);
    assert.equal(qualityChecks[0]?.kind, "quality-trusted-command-missing");
  });

  it("treats backslash executable tokens as direct trusted command paths", async () => {
    const repoRoot = await createRepoRoot();
    const executableToken = ".\\local-tool.exe";
    const executablePath = path.resolve(repoRoot, executableToken);
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executablePath, 0o700);
    await writeConfig(repoRoot, {
      version: 1,
      trustedStateCommands: {
        local: {
          argv: [executableToken],
        },
      },
    });

    const report = runAiuDoctor({ cwd: repoRoot });

    assert.ok(report.checks.some((check) => check.kind === "trusted-command-found" && check.path === executablePath));
  });

  it("does not report executable directories as trusted command executables", async () => {
    const repoRoot = await createRepoRoot();
    const directoryToken = "./local-tool-dir";
    const directoryPath = path.resolve(repoRoot, directoryToken);
    await mkdir(directoryPath);
    await chmod(directoryPath, 0o700);
    await writeConfig(repoRoot, {
      version: 1,
      trustedStateCommands: {
        local: {
          argv: [directoryToken],
        },
      },
    });

    const report = runAiuDoctor({ cwd: repoRoot });

    assert.ok(report.checks.some((check) => check.kind === "trusted-command-missing" && check.path === directoryToken));
  });

  it("reports package, config, state, host, and trusted command paths as redacted data", async () => {
    const tokenLikePrefix = `aiu-doctor-ghp_${"A".repeat(36)}-`;
    const repoRoot = await createRepoRoot(tokenLikePrefix);
    await writeConfig(repoRoot, {
      version: 1,
      trustedStateCommands: {
        node: {
          argv: [process.execPath, "--version"],
        },
      },
    });

    const paths = getAiuResolvedPaths({ cwd: repoRoot });
    const report = runAiuDoctor({ cwd: repoRoot });
    const serialized = JSON.stringify({ paths, report });

    assert.equal(paths.config.found, true);
    assert.ok(paths.hosts.some((host) => host.host === "opencode"));
    assert.ok(paths.trustedCommands.some((command) => command.sourceId === "node" && command.found));
    assert.match(serialized, /\[REDACTED\]/);
    assert.doesNotMatch(serialized, /ghp_[A-Z]{36}/);
  });
});

async function createRepoRoot(prefix = "aiu-doctor-"): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(repoRoot);
  await mkdir(path.join(repoRoot, ".git"));
  return repoRoot;
}

async function writeConfig(repoRoot: string, config: unknown): Promise<void> {
  await writeFile(path.join(repoRoot, "aiu.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function readText(pathValue: string): Promise<string> {
  return await readFile(pathValue, "utf8");
}

async function writeManagedHostFiles(repoRoot: string, host: "opencode" | "codex" | "claude-code"): Promise<void> {
  for (const file of getAiuHostCapabilityProfile(host).managedFiles) {
    const target = path.join(repoRoot, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}
