import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { getDefaultAiuConfig, type AiuConfig } from "../dist/src/config.js";
import { runAiuOpenCodeContinuation } from "../dist/src/opencode.js";
import { createAiuTrustedStateEnvelope, type AiuTrustedStateEnvelope, type AiuWorkItemState, type AiuWorkQueueState } from "../dist/src/state.js";

const repoRoot = path.resolve(process.cwd());

describe("OpenCode continuation runtime", () => {
  it("delivers rendered prompts for idle continue decisions", async () => {
    const delivered: string[] = [];
    const result = await runAiuOpenCodeContinuation(
      { type: "session.idle", payload: { sessionId: "ses_1", selectedSessionId: "ses_1" } },
      {
        cwd: repoRoot,
        config: opencodeConfig(),
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
});

function opencodeConfig(): AiuConfig {
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
