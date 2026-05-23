import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type * as Decision from "../src/decision.ts";
import {
  createAiuTrustedStateEnvelope,
  type AiuGateEvidenceState,
  type AiuHostSessionState,
  type AiuPlanningState,
  type AiuQualityState,
  type AiuRepositoryState,
  type AiuReviewState,
  type AiuTrustedStateEnvelope,
  type AiuTrustedStatePayload,
  type AiuWorkItemState,
  type AiuWorkQueueState,
} from "../src/state.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const observedAt = "2026-05-23T00:00:00.000Z";
const { decideAiuContinuation } = await loadDecision();

describe("continuation decision engine", () => {
  it("stops immediately when supply-chain approval is required", () => {
    assertDecision(
      decideAiuContinuation({
        states: [env(workQueue({ readyItems: [workItem("47", "ready")] }))],
        policy: { supplyChainApprovalRequired: true },
      }),
      "stop",
      "stop-supply-chain-approval",
    );
  });

  it("stops on malformed, stale, untrusted, and unsupported trusted input", () => {
    assertDecision(decideAiuContinuation({ states: [env(hostSession({ status: "malformed" }))] }), "stop", "stop-malformed-input");
    assertDecision(decideAiuContinuation({ states: [env(workQueue(), { freshness: "stale" })] }), "stop", "stop-stale-input");
    assertDecision(decideAiuContinuation({ states: [env(quality({ status: "pass" }), { trustLevel: "untrusted" })] }), "stop", "stop-untrusted-input");
    assertDecision(decideAiuContinuation({ states: [env(planning({ status: "unsupported", needsPlanning: "unsupported" }))] }), "stop", "stop-unsupported-input");
  });

  it("stops when planning needs a human answer", () => {
    const result = decideAiuContinuation({
      states: [env(planning({
        needsPlanning: true,
        humanInputRequired: true,
        unresolvedQuestions: [{
          id: "provider-fields",
          category: "provider-schema",
          status: "fail",
          requiresHuman: true,
          affectedPaths: ["docs/spec.md"],
        }],
      }))],
    });

    assertDecision(result, "stop", "stop-human-input-required");
    assert.equal(result.selectedItem?.kind, "planning");
  });

  it("stops on contradictory trusted state and multiple active items unless policy allows parallel work", () => {
    assertDecision(
      decideAiuContinuation({
        states: [
          env(workQueue({ activeItems: [workItem("47", "active")] }), { sourceId: "work-a" }),
          env(workQueue({ activeItems: [workItem("48", "active")] }), { sourceId: "work-b" }),
        ],
      }),
      "stop",
      "stop-contradictory-state",
    );

    assertDecision(
      decideAiuContinuation({
        states: [
          env(workQueue({ activeItems: [workItem("47", "active")], readyItems: [workItem("48", "ready")] }), { sourceId: "work-a" }),
          env(workQueue({ activeItems: [workItem("47", "active")], readyItems: [workItem("49", "ready")] }), { sourceId: "work-b" }),
        ],
      }),
      "stop",
      "stop-contradictory-state",
    );

    assertDecision(
      decideAiuContinuation({
        states: [
          env(workQueue({ activeItems: [workItem("47", "active", { title: "Original title" })] }), { sourceId: "work-a" }),
          env(workQueue({ activeItems: [workItem("47", "active", { title: "Renamed title" })] }), { sourceId: "work-b" }),
        ],
      }),
      "continue",
      "continue-active-work",
    );

    assertDecision(
      decideAiuContinuation({
        states: [env(workQueue({ activeItems: [workItem("47", "active"), workItem("48", "active")] }))],
      }),
      "stop",
      "stop-active-work-conflict",
    );

    assertDecision(
      decideAiuContinuation({
        states: [env(review("active", { targetId: "pr-1" })), env(review("changes-requested", { targetId: "pr-2" }))],
      }),
      "stop",
      "stop-active-review-conflict",
    );

    assertDecision(
      decideAiuContinuation({
        states: [env(review("active", { targetId: "pr-1" })), env(review("changes-requested", { targetId: "pr-1" }))],
      }),
      "continue",
      "continue-active-review",
    );

    assertDecision(
      decideAiuContinuation({
        states: [env(workQueue({ activeItems: [workItem("47", "active"), workItem("48", "active")] }))],
        policy: { allowParallelWork: true },
      }),
      "continue",
      "continue-active-work",
    );
  });

  it("waits while cooldown or host session state blocks prompt delivery", () => {
    assertDecision(
      decideAiuContinuation({
        states: [env(workQueue({ activeItems: [workItem("47", "active")] }))],
        policy: { cooldownActive: true },
      }),
      "wait",
      "wait-cooldown-active",
    );

    assertDecision(
      decideAiuContinuation({
        states: [env(hostSession({ sessionStatus: "busy" })), env(workQueue({ activeItems: [workItem("47", "active")] }))],
      }),
      "wait",
      "wait-host-session-busy",
    );
  });

  it("repairs invalid active review, work, repository, and gate state before continuing", () => {
    assertDecision(decideAiuContinuation({ states: [env(review("blocked"))] }), "repair", "repair-active-review");
    assertDecision(
      decideAiuContinuation({ states: [env(workQueue({ activeItems: [workItem("47", "active", { status: "fail" })] }))] }),
      "repair",
      "repair-active-work",
    );
    assertDecision(decideAiuContinuation({ states: [env(repository({ baseFreshness: "unknown", syncStatus: "unknown" }))] }), "repair", "repair-repository-state");
    for (const status of ["fail", "missing", "unknown", "stale"] as const) {
      assertDecision(
        decideAiuContinuation({
          states: [env(gateEvidence([{ id: "release", name: "release check", required: true, status }]))],
        }),
        "repair",
        "repair-gate-evidence",
      );
    }
  });

  it("repairs actionable invalid state before waiting on cooldown or host busy state", () => {
    assertDecision(
      decideAiuContinuation({
        states: [env(review("blocked"))],
        policy: { cooldownActive: true },
      }),
      "repair",
      "repair-active-review",
    );

    assertDecision(
      decideAiuContinuation({
        states: [env(review("blocked")), env(hostSession({ sessionStatus: "busy" }))],
      }),
      "repair",
      "repair-active-review",
    );
  });

  it("continues active review and active work before ready work", () => {
    const activeReview = decideAiuContinuation({
      states: [env(review("changes-requested", { targetId: "60" })), env(workQueue({ readyItems: [workItem("47", "ready")] }))],
    });
    assertDecision(activeReview, "continue", "continue-active-review");
    assert.equal(activeReview.promptKind, "review");
    assert.equal(activeReview.selectedItem?.id, "60");

    const activeWork = decideAiuContinuation({
      states: [env(workQueue({ activeItems: [workItem("46", "active")], readyItems: [workItem("47", "ready")] }))],
    });
    assertDecision(activeWork, "continue", "continue-active-work");
    assert.equal(activeWork.selectedItem?.id, "46");
  });

  it("continues planning, ready work, quality work, whip slot, or clean stop in priority order", () => {
    const planningDecision = decideAiuContinuation({ states: [env(planning({
      needsPlanning: true,
      nextAction: {
        id: "refresh-milestone",
        title: "Refresh milestone draft",
        kind: "bootstrap-plan",
        status: "pass",
        command: { id: "bootstrap-plan", argv: ["bootstrap", "plan"] },
        artifactChecks: ["docs/spec.md"],
        draftPaths: ["docs/M4-whip-tasks-quality-idle-work-and-planning-continuation.md"],
        expectedEvidence: "Updated planning artifacts and trusted planning state.",
      },
    }))] });
    assertDecision(planningDecision, "continue", "continue-planning");
    assert.equal(planningDecision.promptKind, "planning");
    assert.equal(planningDecision.selectedItem?.id, "refresh-milestone");
    assert.deepEqual(planningDecision.selectedItem?.artifactChecks, ["docs/spec.md"]);

    const inactiveStopConditionDecision = decideAiuContinuation({ states: [env(planning({
      needsPlanning: true,
      stopCondition: {
        id: "resolved-schema",
        category: "human-question",
        status: "pass",
        affectedPaths: ["docs/spec.md"],
      },
      nextAction: {
        id: "continue-after-resolution",
        status: "pass",
        artifactChecks: ["docs/spec.md"],
        draftPaths: [],
      },
    }))] });
    assertDecision(inactiveStopConditionDecision, "continue", "continue-planning");
    assert.equal(inactiveStopConditionDecision.selectedItem?.id, "continue-after-resolution");

    assertDecision(
      decideAiuContinuation({
        states: [env(planning({ needsPlanning: "unknown", humanInputRequired: "unknown" })), env(workQueue({ readyItems: [workItem("47", "ready")] }))],
      }),
      "stop",
      "stop-unknown-input",
    );

    assertDecision(
      decideAiuContinuation({
        states: [env(planning({
          needsPlanning: true,
          nextAction: {
            id: "ambiguous",
            status: "unknown",
            artifactChecks: [],
            draftPaths: [],
          },
        }))],
      }),
      "stop",
      "stop-unknown-input",
    );

    assertDecision(
      decideAiuContinuation({
        states: [env(planning({
          needsPlanning: true,
          nextAction: {
            id: "refresh-milestone",
            status: "pass",
            artifactChecks: ["docs/spec.md"],
            draftPaths: [],
          },
        }))],
        policy: { planningEnabled: false },
      }),
      "stop",
      "stop-clean",
    );

    const ready = decideAiuContinuation({
      states: [env(workQueue({ readyItems: [workItem("low", "ready", { priority: "low" }), workItem("critical", "ready", { priority: "critical" })] }))],
    });
    assertDecision(ready, "continue", "continue-ready-work");
    assert.equal(ready.selectedItem?.id, "critical");

    const qualityDecision = decideAiuContinuation({ states: [env(quality({
      ready: true,
      lastRunStatus: "fail",
      stages: [{
        id: "typecheck",
        title: "Typecheck",
        status: "fail",
        affectedPaths: ["src/decision.ts"],
        command: { id: "quality-typecheck", argv: ["pnpm", "run", "typecheck"] },
        rerunCommand: { id: "quality-typecheck", argv: ["pnpm", "run", "typecheck"] },
      }],
      failingChecks: ["typecheck"],
    }))] });
    assertDecision(qualityDecision, "continue", "continue-quality");
    assert.equal(qualityDecision.promptKind, "quality");
    assert.equal(qualityDecision.selectedItem?.id, "typecheck");
    assert.equal(qualityDecision.selectedItem?.targetKind, "stage");
    assert.deepEqual(qualityDecision.selectedItem?.affectedPaths, ["src/decision.ts"]);

    const selectedFailDecision = decideAiuContinuation({ states: [env(quality({
      ready: true,
      lastRunStatus: "fail",
      selectedTarget: {
        kind: "stage",
        id: "selected-typecheck",
        status: "fail",
        affectedPaths: ["src/trusted_adapter.ts"],
      },
      stages: [{ id: "lint", status: "fail", affectedPaths: ["src/decision.ts"] }],
    }))] });
    assertDecision(selectedFailDecision, "continue", "continue-quality");
    assert.equal(selectedFailDecision.selectedItem?.id, "selected-typecheck");
    assert.deepEqual(selectedFailDecision.selectedItem?.affectedPaths, ["src/trusted_adapter.ts"]);

    const selectedPassFallbackDecision = decideAiuContinuation({ states: [env(quality({
      ready: true,
      lastRunStatus: "fail",
      selectedTarget: {
        kind: "stage",
        id: "stale-selection",
        status: "pass",
        affectedPaths: ["src/stale.ts"],
      },
      findings: [{
        id: "real-failure",
        status: "fail",
        affectedPaths: ["src/decision.ts"],
      }],
    }))] });
    assertDecision(selectedPassFallbackDecision, "continue", "continue-quality");
    assert.equal(selectedPassFallbackDecision.selectedItem?.id, "real-failure");
    assert.equal(selectedPassFallbackDecision.selectedItem?.targetKind, "finding");

    assertDecision(
      decideAiuContinuation({
        states: [env(quality({
          ready: true,
          lastRunStatus: "fail",
          selectedTarget: {
            kind: "stage",
            id: "incomplete-selection",
            status: "unknown",
            affectedPaths: [],
          },
        }))],
      }),
      "stop",
      "stop-unknown-input",
    );

    assertDecision(
      decideAiuContinuation({
        states: [env(quality({
          ready: true,
          lastRunStatus: "fail",
          findings: [{
            id: "unsafe-package",
            status: "fail",
            affectedPaths: ["package.json"],
            supplyChainApprovalRequired: true,
          }],
        }))],
      }),
      "stop",
      "stop-supply-chain-approval",
    );
    assertDecision(
      decideAiuContinuation({ states: [env(quality({ ready: "unknown", lastRunStatus: "unknown" }))] }),
      "stop",
      "stop-unknown-input",
    );
    assertDecision(
      decideAiuContinuation({ states: [env(quality({ ready: "unsupported", lastRunStatus: "unsupported" }))] }),
      "stop",
      "stop-unsupported-input",
    );
    assertDecision(
      decideAiuContinuation({ states: [env(quality({ ready: true, lastRunStatus: "fail" }))] }),
      "stop",
      "stop-unknown-input",
    );
    assertDecision(
      decideAiuContinuation({
        states: [env(quality({
          ready: true,
          lastRunStatus: "fail",
          stages: [{ id: "lint", status: "fail", affectedPaths: [] }],
        }))],
        policy: { qualityEnabled: false },
      }),
      "stop",
      "stop-clean",
    );
    assertDecision(decideAiuContinuation({ states: [], whipTaskReady: true }), "continue", "continue-whip-task");
    assertDecision(decideAiuContinuation({ states: [env(workQueue())] }), "stop", "stop-clean");
  });

  it("stops when the selected decision mode is disallowed by policy", () => {
    const result = decideAiuContinuation({
      states: [env(workQueue({ activeItems: [workItem("47", "active")] }))],
      policy: { modes: ["stop"] },
    });

    assertDecision(result, "stop", "stop-safety-block");
    assert.equal(result.selectedMode, "stop");
  });

  it("keeps the decision engine side-effect free and provider-neutral", async () => {
    const source = await readFile(path.join(repoRoot, "src", "decision.ts"), "utf8");

    assert.doesNotMatch(source, /from\s+["']node:fs/);
    assert.doesNotMatch(source, /from\s+["']node:child_process/);
    assert.doesNotMatch(source, /from\s+["']\.\/cli(?:\.(?:[cm]?ts|[cm]?js))?["']/);
    assert.doesNotMatch(source, /from\s+["']\.\/command_registry(?:\.(?:[cm]?ts|[cm]?js))?["']/);
    assert.doesNotMatch(source, /\bgithub\b/i);
    assert.doesNotMatch(source, /\bprovider[A-Z_-]/i);
  });
});

async function loadDecision(): Promise<typeof Decision> {
  return await import(path.join(repoRoot, "dist/src/decision.js")) as typeof Decision;
}

function assertDecision(result: Decision.AiuContinuationDecision, kind: Decision.AiuContinuationDecision["kind"], reasonCode: string): void {
  assert.equal(result.kind, kind);
  assert.equal(result.reasonCodes[0], reasonCode);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Array.isArray(result.sourceSummaries), true);
  assert.equal(typeof result.confidence, "number");
  assert.equal(typeof result.recommendedNextAction, "string");
}

function env<TState extends AiuTrustedStatePayload>(
  value: TState,
  options: {
    readonly sourceId?: string;
    readonly freshness?: "fresh" | "stale" | "unknown";
    readonly trustLevel?: "trusted" | "advisory" | "untrusted";
  } = {},
): AiuTrustedStateEnvelope<TState> {
  return createAiuTrustedStateEnvelope({
    sourceId: options.sourceId ?? value.kind,
    command: {
      id: `${options.sourceId ?? value.kind}-command`,
      argv: ["fixture"],
    },
    observedAt,
    trustLevel: options.trustLevel ?? "trusted",
    capabilities: {
      [value.kind]: "supported",
    },
    freshness: {
      kind: options.freshness ?? "fresh",
      observedAt,
    },
    value,
  });
}

function workItem(
  id: string,
  lifecycle: AiuWorkItemState["lifecycle"],
  overrides: Partial<AiuWorkItemState> = {},
): AiuWorkItemState {
  return {
    kind: "work-item",
    status: "pass",
    id,
    title: `Work ${id}`,
    lifecycle,
    priority: "normal",
    blockers: [],
    ...overrides,
  };
}

function workQueue(overrides: Partial<AiuWorkQueueState> = {}): AiuWorkQueueState {
  return {
    kind: "work-queue",
    status: "pass",
    activeItems: [],
    readyItems: [],
    blockedItems: [],
    unknownItems: [],
    ...overrides,
  };
}

function review(reviewStatus: AiuReviewState["reviewStatus"], overrides: Partial<AiuReviewState> = {}): AiuReviewState {
  return {
    kind: "review",
    status: reviewStatus === "blocked" ? "fail" : "pass",
    reviewStatus,
    unresolvedFeedbackCount: reviewStatus === "changes-requested" ? 1 : 0,
    ...overrides,
  };
}

function repository(overrides: Partial<AiuRepositoryState> = {}): AiuRepositoryState {
  return {
    kind: "repository",
    status: "pass",
    activeRef: "issue/47-m23-implement-pure-continuation-decision",
    baseRef: "main",
    dirty: "pass",
    baseFreshness: "pass",
    syncStatus: "in-sync",
    ...overrides,
  };
}

function gateEvidence(gates: Array<{ readonly id: string; readonly name: string; readonly required: boolean; readonly status: AiuGateEvidenceState["gates"][number]["status"] }>): AiuGateEvidenceState {
  return {
    kind: "gate-evidence",
    status: "pass",
    gates: gates.map((gate) => ({
      ...gate,
      reasonCodes: gate.status === "pass" ? [] : ["repair-gate-evidence"],
    })),
  };
}

function planning(overrides: Partial<AiuPlanningState> = {}): AiuPlanningState {
  return {
    kind: "planning",
    status: "pass",
    needsPlanning: false,
    humanInputRequired: false,
    decisions: [],
    unresolvedQuestions: [],
    draftPaths: [],
    artifacts: [],
    providers: [],
    ...overrides,
  };
}

function quality(overrides: Partial<AiuQualityState> = {}): AiuQualityState {
  return {
    kind: "quality",
    status: "pass",
    ready: false,
    lastRunStatus: "pass",
    stages: [],
    findings: [],
    failingChecks: [],
    affectedPaths: [],
    ...overrides,
  };
}

function hostSession(overrides: Partial<AiuHostSessionState> = {}): AiuHostSessionState {
  return {
    kind: "host-session",
    status: "pass",
    hostId: "fixture-host",
    sessionStatus: "idle",
    canPrompt: true,
    ...overrides,
  };
}
