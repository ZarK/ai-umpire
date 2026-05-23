import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadAiuConfig } from "../src/config.ts";
import { AIU_DEFAULT_WHIP_TASKS, decideAiuWhipContinuation, resolveAiuWhipTasks } from "../src/whip.ts";

const tempRoots: string[] = [];

describe("whip policy", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("selects package default tasks when enabled by default", async () => {
    const repoRoot = await createRepoRoot();
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const decision = decideAiuWhipContinuation({ config });

    assert.equal(config.whip.enabled, true);
    assert.deepEqual(resolveAiuWhipTasks(config.whip).map((task) => task.id), AIU_DEFAULT_WHIP_TASKS.map((task) => task.id));
    assert.equal(decision.outcome, "prompt");
    assert.equal(decision.enqueuesPrompt, true);
    assert.equal(decision.promptDeliveryCompletesTask, false);
    assert.equal(decision.task?.id, AIU_DEFAULT_WHIP_TASKS[0]?.id);
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
    const decision = decideAiuWhipContinuation({
      config,
      state: {
        tasks: [{ id: AIU_DEFAULT_WHIP_TASKS[0]?.id ?? "", status: "prompted" }],
      },
    });

    assert.equal(decision.outcome, "prompt");
    assert.equal(decision.task?.id, AIU_DEFAULT_WHIP_TASKS[0]?.id);
    assert.equal(decision.promptDeliveryCompletesTask, false);
  });

  it("skips completed and cancelled state tasks", async () => {
    const repoRoot = await createRepoRoot();
    const config = loadAiuConfig({ cwd: repoRoot }).config;
    const decision = decideAiuWhipContinuation({
      config,
      state: {
        tasks: [
          { id: AIU_DEFAULT_WHIP_TASKS[0]?.id ?? "", status: "completed" },
          { id: AIU_DEFAULT_WHIP_TASKS[1]?.id ?? "", status: "cancelled" },
        ],
      },
    });

    assert.equal(decision.outcome, "idle-no-work");
    assert.equal(decision.enqueuesPrompt, false);
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
