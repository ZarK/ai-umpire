import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AIU_REASON_CODES,
  AIU_TRUSTED_STATE_KINDS,
  AIU_TRUSTED_STATE_SCHEMA_VERSION,
  type AiuContinuationPolicyState,
  type AiuGateEvidenceState,
  type AiuHostSessionState,
  type AiuPlanningState,
  type AiuQualityState,
  type AiuRepositoryState,
  type AiuReviewState,
  type AiuStateValueKind,
  type AiuTrustedStateEnvelope,
  type AiuTrustedStatePayload,
  type AiuWorkItemState,
  type AiuWorkQueueState,
  createAiuTrustedStateEnvelope,
  getAiuReasonCodeCatalog,
  isAiuStateNonSuccess,
  isAiuStateSuccess,
} from "../src/state.ts";

describe("trusted state models", () => {
  it("creates typed trusted state envelopes for every core state kind", () => {
    const envelopes = fixtures().map((value) => envelope(value));

    assert.deepEqual(
      envelopes.map((item) => item.stateKind),
      [...AIU_TRUSTED_STATE_KINDS],
    );

    for (const item of envelopes) {
      assert.equal(item.schemaVersion, AIU_TRUSTED_STATE_SCHEMA_VERSION);
      assert.equal(item.stateKind, item.value.kind);
      assert.equal(item.sourceId, "fixture");
      assert.equal(item.command.id, "fixture-command");
      assert.equal(item.trustLevel, "trusted");
      assert.equal(item.capabilities.queue, "supported");
      assert.deepEqual(item.unknownFields, []);
      assert.deepEqual(item.diagnostics, []);
    }
  });

  it("treats unknown and unsupported as distinct non-success values", () => {
    assert.equal(isAiuStateSuccess("pass"), true);
    assert.equal(isAiuStateNonSuccess("pass"), false);

    const nonSuccessValues: readonly AiuStateValueKind[] = ["fail", "missing", "stale", "unknown", "unsupported", "untrusted", "malformed"];
    for (const value of nonSuccessValues) {
      assert.equal(isAiuStateSuccess(value), false, value);
      assert.equal(isAiuStateNonSuccess(value), true, value);
    }
  });

  it("centralizes reason codes by continuation decision category", () => {
    const catalog = getAiuReasonCodeCatalog();
    const catalogCodes = catalog.map((item) => item.code);

    assert.deepEqual(catalogCodes, [...AIU_REASON_CODES]);
    assert.ok(catalog.some((item) => item.code === "continue-active-work" && item.decision === "continue"));
    assert.ok(catalog.some((item) => item.code === "repair-active-review" && item.decision === "repair"));
    assert.ok(catalog.some((item) => item.code === "wait-host-session-busy" && item.decision === "wait"));
    assert.ok(catalog.some((item) => item.code === "stop-malformed-input" && item.category === "input"));
    assert.ok(catalog.some((item) => item.code === "stop-stale-input" && item.category === "input"));
    assert.ok(catalog.some((item) => item.code === "stop-safety-block" && item.category === "safety"));
    assert.ok(catalog.some((item) => item.code === "continue-planning"));
    assert.ok(catalog.some((item) => item.code === "continue-quality"));
  });

  it("freezes envelope snapshots without retaining mutable nested input references", () => {
    const argv: [string, ...string[]] = ["fixture"];
    const blockers: string[] = [];
    const value: AiuWorkItemState = {
      kind: "work-item",
      status: "pass",
      id: "45",
      lifecycle: "active",
      blockers,
    };

    const result = createAiuTrustedStateEnvelope({
      sourceId: "fixture",
      command: {
        id: "fixture-command",
        argv,
      },
      observedAt: "2026-05-23T00:00:00.000Z",
      trustLevel: "trusted",
      capabilities: {
        queue: "supported",
      },
      freshness: {
        kind: "fresh",
        observedAt: "2026-05-23T00:00:00.000Z",
      },
      value,
    });

    argv.push("mutated");
    blockers.push("late-blocker");

    assert.deepEqual(result.command.argv, ["fixture"]);
    assert.deepEqual(result.value.blockers, []);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.command), true);
    assert.equal(Object.isFrozen(result.command.argv), true);
    assert.equal(Object.isFrozen(result.freshness), true);
    assert.equal(Object.isFrozen(result.value), true);
    assert.equal(Object.isFrozen(result.value.blockers), true);
  });

  it("freezes cyclic nested snapshots without recursing forever", () => {
    const cyclicBlockers: unknown[] = [];
    cyclicBlockers.push(cyclicBlockers);
    const result = createAiuTrustedStateEnvelope({
      sourceId: "fixture",
      command: {
        id: "fixture-command",
        argv: ["fixture"],
      },
      observedAt: "2026-05-23T00:00:00.000Z",
      trustLevel: "trusted",
      capabilities: {
        queue: "supported",
      },
      freshness: {
        kind: "fresh",
        observedAt: "2026-05-23T00:00:00.000Z",
      },
      value: {
        kind: "work-item",
        status: "pass",
        id: "45",
        lifecycle: "active",
        blockers: cyclicBlockers as string[],
      },
    });

    const clonedBlockers = result.value.blockers as unknown[];
    assert.equal(clonedBlockers[0], clonedBlockers);
    assert.notEqual(clonedBlockers, cyclicBlockers);
    assert.equal(Object.isFrozen(clonedBlockers), true);
  });

  it("fixtures cover valid, failed, missing, stale, unknown, unsupported, untrusted, and malformed states", () => {
    const statuses = collectFixtureStatuses(fixtures());

    for (const expected of ["pass", "fail", "missing", "stale", "unknown", "unsupported", "untrusted", "malformed"] as const) {
      assert.equal(statuses.has(expected), true, expected);
    }
  });

});

function envelope<TState extends AiuTrustedStatePayload>(value: TState): AiuTrustedStateEnvelope<TState> {
  return createAiuTrustedStateEnvelope({
    sourceId: "fixture",
    command: {
      id: "fixture-command",
      argv: ["fixture"],
      timeoutMs: 1_000,
      maxOutputBytes: 16_384,
    },
    observedAt: "2026-05-23T00:00:00.000Z",
    trustLevel: "trusted",
    capabilities: {
      queue: "supported",
    },
    freshness: {
      kind: "fresh",
      observedAt: "2026-05-23T00:00:00.000Z",
      ageMs: 0,
      staleAfterMs: 60_000,
    },
    value,
  });
}

function fixtures(): readonly AiuTrustedStatePayload[] {
  const activeItem: AiuWorkItemState = {
    kind: "work-item",
    status: "pass",
    id: "45",
    title: "Define trusted state models",
    lifecycle: "active",
    priority: "high",
    blockers: [],
    reasonCodes: ["continue-active-work"],
  };

  const failedBlockedItem: AiuWorkItemState = {
    kind: "work-item",
    status: "fail",
    id: "blocked",
    lifecycle: "blocked",
    blockers: ["missing-gate-evidence"],
    reasonCodes: ["repair-active-work"],
  };

  const workQueue: AiuWorkQueueState = {
    kind: "work-queue",
    status: "pass",
    activeItems: [activeItem],
    readyItems: [],
    blockedItems: [failedBlockedItem],
    unknownItems: [],
  };

  const review: AiuReviewState = {
    kind: "review",
    status: "missing",
    reviewStatus: "none",
    unresolvedFeedbackCount: 0,
  };

  const repository: AiuRepositoryState = {
    kind: "repository",
    status: "stale",
    activeRef: "issue/45-m21-define-trusted-state-models-and-reas",
    baseRef: "main",
    dirty: "pass",
    baseFreshness: "stale",
    syncStatus: "unknown",
    reasonCodes: ["stop-stale-input"],
  };

  const gateEvidence: AiuGateEvidenceState = {
    kind: "gate-evidence",
    status: "unknown",
    gates: [
      {
        id: "quality-gate-1",
        name: "release check",
        status: "unknown",
        required: true,
        reasonCodes: ["repair-gate-evidence"],
      },
    ],
  };

  const planning: AiuPlanningState = {
    kind: "planning",
    status: "unsupported",
    needsPlanning: "unsupported",
    humanInputRequired: "unknown",
    decisions: [],
    unresolvedQuestions: [],
    draftPaths: [],
    artifacts: [],
    providers: [],
    reasonCodes: ["stop-unsupported-input"],
  };

  const quality: AiuQualityState = {
    kind: "quality",
    status: "untrusted",
    ready: "unknown",
    lastRunStatus: "untrusted",
    stages: [],
    findings: [],
    failingChecks: [],
    affectedPaths: [],
    reasonCodes: ["stop-untrusted-input"],
  };

  const hostSession: AiuHostSessionState = {
    kind: "host-session",
    status: "malformed",
    hostId: "fixture-host",
    sessionStatus: "unknown",
    canPrompt: "unknown",
    reasonCodes: ["stop-malformed-input"],
  };

  const continuationPolicy: AiuContinuationPolicyState = {
    kind: "continuation-policy",
    status: "pass",
    allowedModes: ["continue", "repair", "wait", "stop"],
    stopOnUnknownState: true,
    stopOnStaleState: true,
    stopOnSupplyChainApprovalBlock: true,
    allowProviderMutation: false,
    allowBackgroundScheduling: false,
  };

  return [workQueue, activeItem, review, repository, gateEvidence, planning, quality, hostSession, continuationPolicy];
}

function collectFixtureStatuses(values: readonly AiuTrustedStatePayload[]): Set<AiuStateValueKind> {
  const statuses = new Set(values.map((item) => item.status));
  for (const value of values) {
    if (value.kind === "work-queue") {
      for (const item of [...value.activeItems, ...value.readyItems, ...value.blockedItems, ...value.unknownItems]) {
        statuses.add(item.status);
      }
    }
    if (value.kind === "gate-evidence") {
      for (const gate of value.gates) {
        statuses.add(gate.status);
      }
    }
  }

  return statuses;
}
