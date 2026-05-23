import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { getDefaultAiuConfig, type AiuConfig } from "../dist/src/config.js";
import { readAiuContinuationState, resolveAiuContinuationPaths } from "../dist/src/continuation_store.js";
import { runAiuOpenCodeContinuation } from "../dist/src/opencode.js";
import { createAiuTrustedStateEnvelope, type AiuPlanningState, type AiuQualityState, type AiuTrustedStateEnvelope, type AiuWorkItemState, type AiuWorkQueueState } from "../dist/src/state.js";

const repoRoot = path.resolve(process.cwd());
const tempContinuationRoots = new Set<string>();

after(async () => {
  await Promise.all([...tempContinuationRoots].map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenCode continuation runtime", () => {
  it("delivers rendered prompts for idle continue decisions", async () => {
    const config = opencodeConfig();
    const delivered: string[] = [];
    const result = await runAiuOpenCodeContinuation(
      { type: "session.idle", payload: { sessionId: "ses_1", selectedSessionId: "ses_1" } },
      {
        cwd: repoRoot,
        config,
        observedAt: "2026-05-23T12:00:00.000Z",
        trustedStates: [workQueueEnvelope({ readyItems: [workItem("65", "M3.2")] })],
        deliverPrompt: (prompt) => {
          delivered.push(prompt.body);
          return { delivered: true, targetSessionId: "ses_1" };
        },
      },
    );

    assert.equal(result.handled, true);
    assert.equal(result.decision?.kind, "continue");
    assert.equal(result.prompt?.decisionKind, "continue");
    assert.equal(result.prompt?.selectedItem?.id, "65");
    assert.match(result.prompt?.fingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.equal(result.delivery?.delivered, true);
    assert.equal(delivered.length, 1);
  });

  it("delivers planning, quality, and whip prompts through the shared prompt payload", async () => {
    const cases = [
      {
        name: "planning",
        states: [planningEnvelope()],
        expectedKind: "planning",
        expectedId: "bootstrap-plan",
      },
      {
        name: "quality",
        states: [qualityEnvelope()],
        expectedKind: "quality",
        expectedId: "typecheck",
      },
      {
        name: "whip",
        states: [],
        expectedKind: "whip",
        expectedId: "review-doc-command-examples",
      },
    ] as const;

    for (const item of cases) {
      const delivered: Array<{ readonly kind: string; readonly id?: string; readonly body: string }> = [];
      const result = await runAiuOpenCodeContinuation(
        { type: "session.idle", payload: { sessionId: `ses_${item.name}`, selectedSessionId: `ses_${item.name}` } },
        {
          cwd: repoRoot,
          config: opencodeConfig(),
          observedAt: "2026-05-23T12:00:00.000Z",
          trustedStates: item.states,
          deliverPrompt: (prompt) => {
            delivered.push({ kind: prompt.kind, id: prompt.selectedItem?.id, body: prompt.body });
            return { delivered: true, targetSessionId: `ses_${item.name}` };
          },
        },
      );

      assert.equal(result.delivery?.delivered, true, item.name);
      assert.equal(result.prompt?.kind, item.expectedKind, item.name);
      assert.equal(result.prompt?.selectedItem?.id, item.expectedId, item.name);
      assert.equal(delivered[0]?.kind, item.expectedKind, item.name);
      assert.equal(delivered[0]?.id, item.expectedId, item.name);
      if (item.name === "whip") {
        assert.match(delivered[0]?.body ?? "", /Prompt delivery does not complete the whip task/);
        assert.match(await readFile(String(result.metadata?.logPath), "utf8"), /"promptKind":"whip"/);
        assert.match(await readFile(String(result.metadata?.logPath), "utf8"), /"selectedItem":\{"kind":"whip"/);
      }
    }
  });

  it("persists prompt ownership and suppresses duplicate targets", async () => {
    const config = opencodeConfig();
    const target = await mkdtemp(path.join(tmpdir(), "aiu-opencode-state-"));
    try {
      const trustedStates = [workQueueEnvelope({ activeItems: [workItem("67", "M3.4", "active")] })];
      const first = await runAiuOpenCodeContinuation(
        { type: "session.idle", payload: { sessionId: "ses_owner", selectedSessionId: "ses_owner" } },
        {
          cwd: target,
          config,
          observedAt: "2026-05-23T12:00:00.000Z",
          trustedStates,
          deliverPrompt: () => ({ delivered: true, targetSessionId: "ses_owner" }),
        },
      );
      const paths = resolveAiuContinuationPaths(target, config);
      const state = readAiuContinuationState(paths);

      assert.equal(first.delivery?.delivered, true);
      assert.equal(state?.ownerSessionId, "ses_owner");
      assert.equal(state?.lastPromptFingerprint, first.prompt?.fingerprint);
      assert.equal(state?.selectedItem?.id, "67");

      const duplicate = await runAiuOpenCodeContinuation(
        { type: "session.idle", payload: { sessionId: "ses_owner", selectedSessionId: "ses_owner" } },
        {
          cwd: target,
          config,
          observedAt: "2026-05-23T12:20:00.000Z",
          trustedStates,
          deliverPrompt: () => {
            throw new Error("duplicate prompt must not be delivered");
          },
        },
      );

      assert.equal(duplicate.delivery, undefined);
      assert.ok(duplicate.metadata?.suppressions?.includes("duplicate-prompt-target"));
      assert.notEqual(duplicate.metadata?.promptFingerprint, undefined);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("suppresses helper, busy, selected-session, and active-user events", async () => {
    const cases = [
      { payload: { helperSession: true }, reason: "helper-session" },
      { payload: { busy: true }, reason: "session-busy" },
      { payload: { sessionId: "ses_a", selectedSessionId: "ses_b" }, reason: "selected-session-conflict" },
      { payload: { typing: true }, reason: "user-active" },
    ];

    for (const { payload, reason } of cases) {
      const result = await runAiuOpenCodeContinuation(
        { type: "session.idle", payload },
        {
          cwd: repoRoot,
          config: opencodeConfig(),
          observedAt: "2026-05-23T12:00:00.000Z",
          trustedStates: [workQueueEnvelope({ activeItems: [workItem("65", "M3.2", "active")] })],
          deliverPrompt: () => {
            throw new Error("suppressed events must not deliver prompts");
          },
        },
      );

      assert.equal(result.decision?.kind, "wait", reason);
      assert.equal(result.prompt, undefined, reason);
      assert.ok(result.metadata?.suppressions?.includes(reason), reason);
    }
  });

  it("treats todo activity as advisory interruption state only", async () => {
    const result = await runAiuOpenCodeContinuation(
      { type: "todo.update", payload: { todoActive: true } },
      {
        cwd: repoRoot,
        config: opencodeConfig(),
        observedAt: "2026-05-23T12:00:00.000Z",
        trustedStates: [workQueueEnvelope({ readyItems: [workItem("65", "M3.2")] })],
        deliverPrompt: () => {
          throw new Error("todo activity must not force delivery");
        },
      },
    );

    assert.equal(result.decision?.kind, "wait");
    assert.ok(result.metadata?.suppressions?.includes("todo-active"));
  });

  it("suppresses prompt delivery on trusted adapter errors", async () => {
    const result = await runAiuOpenCodeContinuation(
      { type: "session.idle" },
      {
        cwd: repoRoot,
        config: {
          ...opencodeConfig(),
          trustedStateCommands: {
            broken: {
              argv: [process.execPath, "-e", "process.exit(2)"],
            },
          },
        },
        observedAt: "2026-05-23T12:00:00.000Z",
        deliverPrompt: () => {
          throw new Error("adapter errors must not deliver prompts");
        },
      },
    );

    assert.equal(result.decision?.kind, "stop");
    assert.ok(result.decision?.reasonCodes.includes("stop-malformed-input"));
    assert.equal(result.prompt, undefined);
    assert.ok(result.metadata?.adapterErrors?.some((error) => error.startsWith("broken: Trusted command broken exited with code 2.")));
  });

  it("aggregates injected trusted state with configured adapters", async () => {
    const result = await runAiuOpenCodeContinuation(
      { type: "session.idle" },
      {
        cwd: repoRoot,
        config: {
          ...opencodeConfig(),
          trustedStateCommands: {
            broken: {
              argv: [process.execPath, "-e", "process.exit(2)"],
            },
          },
        },
        observedAt: "2026-05-23T12:00:00.000Z",
        trustedStates: [workQueueEnvelope({ readyItems: [workItem("65", "M3.2")] })],
        deliverPrompt: () => {
          throw new Error("partial trusted state must not deliver prompts");
        },
      },
    );

    assert.equal(result.decision?.kind, "stop");
    assert.ok(result.metadata?.adapterErrors?.some((error) => error.startsWith("broken: Trusted command broken exited with code 2.")));
  });

  it("suppresses prompt delivery during cooldown and records session metadata", async () => {
    const result = await runAiuOpenCodeContinuation(
      { type: "session.idle", payload: { sessionId: "ses_1", selectedSessionId: "ses_1" } },
      {
        cwd: repoRoot,
        config: opencodeConfig(),
        observedAt: "2026-05-23T12:05:00.000Z",
        lastPromptAt: "2026-05-23T12:00:00.000Z",
        trustedStates: [workQueueEnvelope({ activeItems: [workItem("65", "M3.2", "active")] })],
        deliverPrompt: () => {
          throw new Error("cooldown must suppress prompt delivery");
        },
      },
    );

    assert.equal(result.decision?.kind, "wait");
    assert.equal(result.metadata?.sessionId, "ses_1");
    assert.equal(result.metadata?.selectedSessionId, "ses_1");
    assert.ok(result.metadata?.suppressions?.includes("wait-cooldown-active"));
    assert.equal(new Set(result.metadata?.suppressions).size, result.metadata?.suppressions?.length);
  });

  it("returns delivery failures without throwing or retrying", async () => {
    const result = await runAiuOpenCodeContinuation(
      { type: "session.idle" },
      {
        cwd: repoRoot,
        config: opencodeConfig(),
        observedAt: "2026-05-23T12:00:00.000Z",
        trustedStates: [workQueueEnvelope({ activeItems: [workItem("65", "M3.2", "active")] })],
        deliverPrompt: () => {
          throw new Error("host rejected prompt");
        },
      },
    );

    assert.equal(result.decision?.kind, "continue");
    assert.equal(result.delivery?.delivered, false);
    assert.match(result.delivery?.reason ?? "", /host rejected prompt/);
    assert.ok(result.metadata?.suppressions?.some((reason) => reason.startsWith("prompt-delivery-error:")));
  });

  it("normalizes malformed delivery hook results", async () => {
    const result = await runAiuOpenCodeContinuation(
      { type: "session.idle" },
      {
        cwd: repoRoot,
        config: opencodeConfig(),
        observedAt: "2026-05-23T12:00:00.000Z",
        trustedStates: [workQueueEnvelope({ activeItems: [workItem("65", "M3.2", "active")] })],
        deliverPrompt: () => ({ delivered: "yes", targetSessionId: 42 }) as never,
      },
    );

    assert.deepEqual(result.delivery, { delivered: false });
  });

  it("serializes events with lock contention and stale lock recovery logs", async () => {
    const config = opencodeConfig();
    const target = await mkdtemp(path.join(tmpdir(), "aiu-opencode-lock-"));
    try {
      const paths = resolveAiuContinuationPaths(target, config);
      await mkdir(paths.lockDir, { recursive: true });
      await writeFile(paths.lockPath, JSON.stringify({
        schemaVersion: 1,
        ownerId: "current-owner",
        eventType: "session.idle",
        sessionId: "ses_lock",
        acquiredAt: "2026-05-23T12:00:00.000Z",
      }), "utf8");

      const contended = await runAiuOpenCodeContinuation(
        { type: "session.idle", payload: { sessionId: "ses_lock" } },
        {
          cwd: target,
          config,
          observedAt: "2026-05-23T12:00:01.000Z",
          trustedStates: [workQueueEnvelope({ activeItems: [workItem("67", "M3.4", "active")] })],
          deliverPrompt: () => {
            throw new Error("lock contention must not deliver");
          },
        },
      );
      assert.ok(contended.metadata?.suppressions?.includes("lock-held"));

      const recovered = await runAiuOpenCodeContinuation(
        { type: "session.idle", payload: { sessionId: "ses_lock" } },
        {
          cwd: target,
          config,
          observedAt: "2026-05-23T12:02:00.000Z",
          trustedStates: [workQueueEnvelope({ activeItems: [workItem("68", "M3.5", "active")] })],
          deliverPrompt: () => ({ delivered: true, targetSessionId: "ses_lock" }),
        },
      );
      const log = await readFile(paths.logPath, "utf8");

      assert.equal(recovered.delivery?.delivered, true);
      assert.equal(recovered.metadata?.staleLockRecovered, true);
      assert.match(log, /"event":"lock-contended"/);
      assert.match(log, /"event":"stale-lock-recovered"/);
      assert.match(log, /"event":"decision"/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("keeps delivered prompts successful when persistence or logging fails", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "aiu-opencode-persistence-fail-"));
    try {
      const stateFile = path.join(target, "state-file");
      const logFile = path.join(target, "log-file");
      await writeFile(stateFile, "not a directory", "utf8");
      await writeFile(logFile, "not a directory", "utf8");
      const config = {
        ...opencodeConfig(),
        paths: {
          stateDir: stateFile,
          lockDir: path.join(target, "locks"),
          logDir: logFile,
        },
      };

      const result = await runAiuOpenCodeContinuation(
        { type: "session.idle", payload: { sessionId: "ses_owner", selectedSessionId: "ses_owner" } },
        {
          cwd: target,
          config,
          observedAt: "2026-05-23T12:00:00.000Z",
          trustedStates: [workQueueEnvelope({ activeItems: [workItem("67", "M3.4", "active")] })],
          deliverPrompt: () => ({ delivered: true, targetSessionId: "ses_owner" }),
        },
      );

      assert.equal(result.delivery?.delivered, true);
      assert.ok(result.metadata?.suppressions?.includes("continuation-state-write-failed"));
      assert.ok(result.metadata?.suppressions?.includes("continuation-log-write-failed"));
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

function opencodeConfig(): AiuConfig {
  const stateRoot = path.join(tmpdir(), `aiu-opencode-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempContinuationRoots.add(stateRoot);
  return {
    ...getDefaultAiuConfig(),
    hosts: {
      ...getDefaultAiuConfig().hosts,
      enabled: ["opencode"] as const,
      capabilities: {
        opencode: {
          promptDelivery: "host",
          sessionState: true,
          userActivity: true,
          selectedSession: true,
          todoRead: true,
        },
      },
      modes: {
        opencode: ["continue", "repair", "wait", "stop"] as const,
      },
    },
    timeouts: {
      ...getDefaultAiuConfig().timeouts,
      hostMs: 5_000,
    },
    cooldowns: {
      ...getDefaultAiuConfig().cooldowns,
      promptMs: 600_000,
    },
    paths: {
      stateDir: path.join(stateRoot, "state"),
      lockDir: path.join(stateRoot, "locks"),
      logDir: path.join(stateRoot, "logs"),
    },
  };
}

function workQueueEnvelope(overrides: Partial<AiuWorkQueueState> = {}): AiuTrustedStateEnvelope<AiuWorkQueueState> {
  return createAiuTrustedStateEnvelope({
    sourceId: "fixture-work",
    command: { id: "fixture-work", argv: ["fixture-work"] },
    observedAt: "2026-05-23T12:00:00.000Z",
    trustLevel: "trusted",
    capabilities: {},
    freshness: { kind: "fresh", observedAt: "2026-05-23T12:00:00.000Z" },
    value: {
      kind: "work-queue",
      status: "pass",
      activeItems: [],
      readyItems: [],
      blockedItems: [],
      unknownItems: [],
      ...overrides,
    },
  });
}

function planningEnvelope(): AiuTrustedStateEnvelope<AiuPlanningState> {
  return createAiuTrustedStateEnvelope({
    sourceId: "fixture-planning",
    command: { id: "fixture-planning", argv: ["fixture-planning"] },
    observedAt: "2026-05-23T12:00:00.000Z",
    trustLevel: "trusted",
    capabilities: {},
    freshness: { kind: "fresh", observedAt: "2026-05-23T12:00:00.000Z" },
    value: {
      kind: "planning",
      status: "pass",
      needsPlanning: true,
      humanInputRequired: false,
      decisions: [],
      unresolvedQuestions: [],
      draftPaths: [],
      artifacts: [],
      providers: [],
      nextAction: {
        id: "bootstrap-plan",
        status: "pass",
        command: { id: "bootstrap-plan", argv: ["bootstrap", "plan"] },
        artifactChecks: ["docs/spec.md"],
        draftPaths: ["docs/M4-whip-tasks-quality-idle-work-and-planning-continuation.md"],
      },
    },
  });
}

function qualityEnvelope(): AiuTrustedStateEnvelope<AiuQualityState> {
  return createAiuTrustedStateEnvelope({
    sourceId: "fixture-quality",
    command: { id: "fixture-quality", argv: ["fixture-quality"] },
    observedAt: "2026-05-23T12:00:00.000Z",
    trustLevel: "trusted",
    capabilities: {},
    freshness: { kind: "fresh", observedAt: "2026-05-23T12:00:00.000Z" },
    value: {
      kind: "quality",
      status: "pass",
      ready: true,
      lastRunStatus: "fail",
      stages: [{
        id: "typecheck",
        status: "fail",
        affectedPaths: ["src/decision.ts"],
        command: { id: "quality-typecheck", argv: ["pnpm", "run", "typecheck"] },
      }],
      findings: [],
      failingChecks: ["typecheck"],
      affectedPaths: ["src/decision.ts"],
    },
  });
}

function workItem(id: string, title: string, lifecycle: AiuWorkItemState["lifecycle"] = "ready"): AiuWorkItemState {
  return {
    kind: "work-item",
    status: "pass",
    id,
    title,
    lifecycle,
    priority: "high",
    blockers: [],
  };
}
