import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadAiuConfig } from "../dist/src/config.js";
import {
  AIU_DEFAULT_WHIP_TASKS,
  decideAiuWhipContinuation,
  readAiuWhipState,
  resolveAiuWhipStatePath,
  resolveAiuWhipTasks,
  runAiuWhipCommand,
} from "../src/whip.ts";

const tempRoots: string[] = [];

describe("whip policy", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("selects package default tasks when enabled by default", async () => {
    const repoRoot = await createRepoRoot();
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const decision = decideAiuWhipContinuation({ config });
    const firstDefault = AIU_DEFAULT_WHIP_TASKS[0];

    assert.ok(firstDefault);
    assert.equal(config.whip.enabled, true);
    assert.deepEqual(resolveAiuWhipTasks(config.whip).map((task) => task.id), AIU_DEFAULT_WHIP_TASKS.map((task) => task.id));
    assert.equal(decision.outcome, "prompt");
    assert.equal(decision.enqueuesPrompt, true);
    assert.equal(decision.promptDeliveryCompletesTask, false);
    assert.equal(decision.task?.id, firstDefault.id);
  });

  it("merges repo tasks with defaults, deduplicates ids, and uses sorted priority", async () => {
    const repoRoot = await createRepoRoot();
    const firstDefault = AIU_DEFAULT_WHIP_TASKS[0];
    assert.ok(firstDefault);
    await writeConfig(repoRoot, {
      version: 1,
      whip: {
        enabled: true,
        usePackageDefaults: true,
        tasks: [
          {
            id: firstDefault.id,
            title: "Repo override",
            prompt: "Run the repo override for the default task.",
            priority: 50,
          },
          {
            id: "repo-high-priority",
            title: "Repo high priority",
            prompt: "Run this high priority repo task.",
            priority: 1,
          },
        ],
      },
    });
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const resolved = resolveAiuWhipTasks(config.whip);
    const decision = decideAiuWhipContinuation({ config });

    assert.equal(new Set(resolved.map((task) => task.id)).size, resolved.length);
    assert.equal(resolved.filter((task) => task.id === firstDefault.id).length, 1);
    assert.equal(resolved.find((task) => task.id === firstDefault.id)?.title, "Repo override");
    assert.equal(resolved[0]?.id, "repo-high-priority");
    assert.equal(decision.task?.id, "repo-high-priority");
  });

  it("stops cleanly without prompt when whip is disabled and preserves existing state", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      whip: {
        enabled: false,
      },
    });
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const decision = decideAiuWhipContinuation({
      config,
      state: {
        tasks: [{ id: "review-doc-command-examples", status: "pending" }],
      },
    });

    assert.equal(decision.outcome, "disabled");
    assert.equal(decision.ok, false);
    assert.equal(decision.enqueuesPrompt, false);
    assert.equal(decision.stateAction, "preserve");
    assert.deepEqual(decision.reasonCodes, ["whip-disabled"]);
  });

  it("allows repositories to replace package defaults with explicit empty or custom task lists", async () => {
    const emptyRepo = await createRepoRoot();
    await writeConfig(emptyRepo, {
      version: 1,
      whip: {
        enabled: true,
        usePackageDefaults: false,
        tasks: [],
      },
    });
    const emptyDecision = decideAiuWhipContinuation({ config: loadAiuConfig({ cwd: emptyRepo }).config });

    assert.equal(emptyDecision.outcome, "idle-no-work");
    assert.equal(emptyDecision.enqueuesPrompt, false);
    assert.deepEqual(emptyDecision.reasonCodes, ["whip-no-ready-task"]);

    const customRepo = await createRepoRoot();
    await writeConfig(customRepo, {
      version: 1,
      whip: {
        enabled: true,
        usePackageDefaults: false,
        tasks: [
          {
            id: "repo-docs",
            title: "Review repo docs",
            prompt: "Review repository docs for stale aiu examples.",
            priority: 5,
          },
        ],
      },
    });
    const customConfig = loadAiuConfig({ cwd: customRepo }).config;
    const customDecision = decideAiuWhipContinuation({ config: customConfig });

    assert.deepEqual(resolveAiuWhipTasks(customConfig.whip).map((task) => task.id), ["repo-docs"]);
    assert.equal(customDecision.outcome, "prompt");
    assert.equal(customDecision.task?.prompt, "Review repository docs for stale aiu examples.");
  });

  it("does not let whip policy affect higher-priority continuation", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      whip: {
        enabled: false,
      },
    });
    const decision = decideAiuWhipContinuation({
      config: loadAiuConfig({ cwd: repoRoot }).config,
      higherPriorityReady: true,
    });

    assert.equal(decision.outcome, "higher-priority-ready");
    assert.equal(decision.enqueuesPrompt, false);
    assert.deepEqual(decision.reasonCodes, ["higher-priority-continuation-ready"]);
  });

  it("does not treat prompted state as task completion", async () => {
    const repoRoot = await createRepoRoot();
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const firstDefault = AIU_DEFAULT_WHIP_TASKS[0];
    assert.ok(firstDefault);
    const decision = decideAiuWhipContinuation({
      config,
      state: {
        tasks: [{ id: firstDefault.id, status: "prompted" }],
      },
    });

    assert.equal(decision.outcome, "prompt");
    assert.equal(decision.task?.id, firstDefault.id);
    assert.equal(decision.promptDeliveryCompletesTask, false);
  });

  it("skips completed and cancelled state tasks", async () => {
    const repoRoot = await createRepoRoot();
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const firstDefault = AIU_DEFAULT_WHIP_TASKS[0];
    const secondDefault = AIU_DEFAULT_WHIP_TASKS[1];
    assert.ok(firstDefault);
    assert.ok(secondDefault);
    const decision = decideAiuWhipContinuation({
      config,
      state: {
        tasks: [
          { id: firstDefault.id, status: "completed" },
          { id: secondDefault.id, status: "cancelled" },
        ],
      },
    });

    assert.equal(decision.outcome, "idle-no-work");
    assert.equal(decision.enqueuesPrompt, false);
  });

  it("re-selects a completed task when its prompt fingerprint changes", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      whip: {
        enabled: true,
        usePackageDefaults: false,
        tasks: [
          {
            id: "repo-docs",
            title: "Review repo docs",
            prompt: "Review the updated repository docs.",
            priority: 5,
          },
        ],
      },
    });
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const decision = decideAiuWhipContinuation({
      config,
      state: {
        tasks: [{ id: "repo-docs", status: "completed", promptFingerprint: "previous-definition" }],
      },
    });

    assert.equal(decision.outcome, "prompt");
    assert.equal(decision.task?.id, "repo-docs");
  });

  it("stores whip state under configurable paths and validates missing state as empty", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      whip: {
        statePath: ".umpire/custom-whip.json",
      },
    });
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const statePath = resolveAiuWhipStatePath(repoRoot, config);
    const read = readAiuWhipState(repoRoot, config);

    assert.equal(statePath, path.join(repoRoot, ".umpire", "custom-whip.json"));
    assert.equal(read.ok, true);
    assert.deepEqual(read.state.tasks, []);
  });

  it("adds repo-owned tasks with dry-run support and stable persisted state", async () => {
    const repoRoot = await createRepoRoot();
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const dryRun = runAiuWhipCommand({
      action: "add",
      repoRoot,
      config,
      dryRun: true,
      observedAt: "2026-05-23T12:00:00.000Z",
      id: "repo-docs",
      title: "Review repo docs",
      prompt: "Review repository docs for stale aiu examples.",
      priority: 5,
    });

    assert.equal(dryRun.changed, true);
    assert.equal(existsSync(resolveAiuWhipStatePath(repoRoot, config)), false);

    const applied = runAiuWhipCommand({
      action: "add",
      repoRoot,
      config,
      observedAt: "2026-05-23T12:00:00.000Z",
      id: "repo-docs",
      title: "Review repo docs",
      prompt: "Review repository docs for stale aiu examples.",
      priority: 5,
    });
    const persisted = JSON.parse(await readFile(resolveAiuWhipStatePath(repoRoot, config), "utf8")) as { tasks: Array<{ id: string; status: string; source: string }> };

    assert.equal(applied.errors.length, 0);
    assert.equal(applied.tasks[0]?.id, "repo-docs");
    assert.equal(persisted.tasks[0]?.id, "repo-docs");
    assert.equal(persisted.tasks[0]?.status, "pending");
    assert.equal(persisted.tasks[0]?.source, "cli");
  });

  it("blocks mutating commands when whip is disabled", async () => {
    const repoRoot = await createRepoRoot();
    await writeConfig(repoRoot, {
      version: 1,
      whip: {
        enabled: false,
      },
    });
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const add = runAiuWhipCommand({
      action: "add",
      repoRoot,
      config,
      id: "repo-docs",
      title: "Review repo docs",
      prompt: "Review repository docs.",
      priority: 5,
    });
    const status = runAiuWhipCommand({ action: "status", repoRoot, config });

    assert.equal(add.changed, false);
    assert.equal(existsSync(resolveAiuWhipStatePath(repoRoot, config)), false);
    assert.deepEqual(add.errors.map((error) => error.code), ["whip-disabled"]);
    assert.equal(status.errors.length, 0);
  });

  it("cancels and completes tasks only through explicit state transitions", async () => {
    const repoRoot = await createRepoRoot();
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const firstDefault = AIU_DEFAULT_WHIP_TASKS[0];
    const secondDefault = AIU_DEFAULT_WHIP_TASKS[1];
    assert.ok(firstDefault);
    assert.ok(secondDefault);

    const missingEvidence = runAiuWhipCommand({
      action: "complete",
      repoRoot,
      config,
      id: firstDefault.id,
    });
    assert.deepEqual(missingEvidence.errors.map((error) => error.code), ["whip-evidence-required"]);

    const complete = runAiuWhipCommand({
      action: "complete",
      repoRoot,
      config,
      observedAt: "2026-05-23T12:10:00.000Z",
      id: firstDefault.id,
      evidence: "Ran focused docs test and updated stale command.",
    });
    const cancel = runAiuWhipCommand({
      action: "cancel",
      repoRoot,
      config,
      observedAt: "2026-05-23T12:20:00.000Z",
      id: secondDefault.id,
      reason: "Superseded by tracked issue.",
    });
    const decision = decideAiuWhipContinuation({ config, state: readAiuWhipState(repoRoot, config).state });

    assert.equal(complete.errors.length, 0);
    assert.equal(cancel.errors.length, 0);
    assert.equal(cancel.tasks.find((task) => task.id === secondDefault.id)?.cancellationReason, "Superseded by tracked issue.");
    assert.equal(decision.outcome, "idle-no-work");
    assert.equal(decision.promptDeliveryCompletesTask, false);
  });

  it("reports malformed state, invalid commands, invalid transitions, unknown ids, and stale ownership", async () => {
    const repoRoot = await createRepoRoot();
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const statePath = resolveAiuWhipStatePath(repoRoot, config);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "{", "utf8");

    const malformed = runAiuWhipCommand({ action: "status", repoRoot, config });
    assert.deepEqual(malformed.errors.map((error) => error.code), ["whip-state-malformed"]);

    await writeFile(statePath, JSON.stringify({
      schemaVersion: 1,
      tasks: [
        {
          id: "owned",
          title: "Owned task",
          prompt: "Continue the owned task.",
          priority: 1,
          status: "prompted",
          source: "cli",
          ownerSessionId: "ses_old",
          promptedAt: "2026-05-22T00:00:00.000Z",
        },
        {
          id: "done",
          title: "Done task",
          prompt: "Already done.",
          priority: 2,
          status: "completed",
          source: "cli",
        },
        {
          id: "stale-owned",
          title: "Stale owned task",
          prompt: "Continue the stale owned task.",
          priority: 3,
          status: "prompted",
          source: "cli",
          ownerSessionId: "ses_stale",
          promptedAt: "not-a-date",
          updatedAt: "2026-05-22T00:00:00.000Z",
        },
      ],
    }), "utf8");

    const stale = runAiuWhipCommand({ action: "status", repoRoot, config, observedAt: "2026-05-23T12:00:00.000Z" });
    const invalidCommand = runAiuWhipCommand({ action: "archive", repoRoot, config });
    const unknown = runAiuWhipCommand({ action: "cancel", repoRoot, config, id: "missing" });
    const invalid = runAiuWhipCommand({ action: "complete", repoRoot, config, id: "done", evidence: "already done" });

    assert.deepEqual(stale.staleOwnership.map((task) => task.id), ["owned", "stale-owned"]);
    assert.deepEqual(invalidCommand.errors.map((error) => error.code), ["whip-invalid-command"]);
    assert.deepEqual(unknown.errors.map((error) => error.code), ["whip-task-not-found"]);
    assert.deepEqual(invalid.errors.map((error) => error.code), ["whip-invalid-transition"]);
  });
});

async function createRepoRoot(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "aiu-whip-"));
  tempRoots.push(repoRoot);
  await mkdir(path.join(repoRoot, ".git"));
  return repoRoot;
}

async function writeConfig(repoRoot: string, config: unknown): Promise<void> {
  await writeFile(path.join(repoRoot, "aiu.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
