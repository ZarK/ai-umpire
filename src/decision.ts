import {
  type AiuContinuationDecisionKind,
  type AiuGateState,
  type AiuPlanningAction,
  type AiuReasonCode,
  type AiuReviewState,
  type AiuQualityFinding,
  type AiuQualitySelectedTarget,
  type AiuQualityStage,
  type AiuStateFreshnessKind,
  type AiuStateValueKind,
  type AiuTrustLevel,
  type AiuTrustedStateEnvelope,
  type AiuTrustedStateKind,
  type AiuTrustedStatePayload,
  type AiuWorkItemState,
} from "./state.js";

export const AIU_DECISION_PROMPT_KINDS = [
  "work",
  "review",
  "repair",
  "planning",
  "quality",
  "whip",
  "wait",
  "stop",
] as const;

export const AIU_DECISION_MODES = ["continue", "repair", "wait", "stop"] as const;

export type AiuDecisionPromptKind = (typeof AIU_DECISION_PROMPT_KINDS)[number];

export interface AiuContinuationDecisionPolicy {
  readonly modes?: readonly AiuContinuationDecisionKind[];
  readonly stopOnUnknownState?: boolean;
  readonly stopOnStaleState?: boolean;
  readonly stopOnUnsafeState?: boolean;
  readonly stopOnSupplyChainApprovalBlock?: boolean;
  readonly allowParallelWork?: boolean;
  readonly allowParallelReview?: boolean;
  readonly planningEnabled?: boolean;
  readonly qualityEnabled?: boolean;
  readonly cooldownActive?: boolean;
  readonly supplyChainApprovalRequired?: boolean;
}

export interface AiuContinuationDecisionInput {
  readonly states: readonly AiuTrustedStateEnvelope[];
  readonly policy?: AiuContinuationDecisionPolicy;
  readonly whipTaskReady?: boolean;
  readonly whipTask?: AiuDecisionWhipTask;
  readonly whipStateError?: AiuDecisionSelectedItem;
}

export interface AiuDecisionWhipTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly priority?: number;
  readonly promptFingerprint?: string;
}

export interface AiuContinuationDecision {
  readonly kind: AiuContinuationDecisionKind;
  readonly reasonCodes: readonly AiuReasonCode[];
  readonly sourceSummaries: readonly AiuDecisionSourceSummary[];
  readonly selectedMode: AiuContinuationDecisionKind;
  readonly selectedItem?: AiuDecisionSelectedItem;
  readonly confidence: number;
  readonly promptKind: AiuDecisionPromptKind;
  readonly recommendedNextAction: string;
}

export interface AiuDecisionSourceSummary {
  readonly sourceId: string;
  readonly stateKind: AiuTrustedStateKind;
  readonly status: AiuStateValueKind;
  readonly trustLevel: AiuTrustLevel;
  readonly freshness: AiuStateFreshnessKind;
  readonly observedAt: string;
  readonly summary?: string;
}

export interface AiuDecisionSelectedItem {
  readonly kind: AiuTrustedStateKind | "gate" | "whip";
  readonly id?: string;
  readonly title?: string;
  readonly sourceId?: string;
  readonly status?: string;
  readonly targetKind?: string;
  readonly affectedPaths?: readonly string[];
  readonly command?: { readonly id: string; readonly argv: readonly [string, ...string[]]; readonly cwd?: string; readonly timeoutMs?: number; readonly maxOutputBytes?: number };
  readonly rerunCommand?: { readonly id: string; readonly argv: readonly [string, ...string[]]; readonly cwd?: string; readonly timeoutMs?: number; readonly maxOutputBytes?: number };
  readonly artifactChecks?: readonly string[];
  readonly expectedEvidence?: string;
  readonly prompt?: string;
  readonly priority?: number;
  readonly promptFingerprint?: string;
}

interface DecisionPolicy {
  readonly modes: readonly AiuContinuationDecisionKind[];
  readonly stopOnUnknownState: boolean;
  readonly stopOnStaleState: boolean;
  readonly stopOnUnsafeState: boolean;
  readonly stopOnSupplyChainApprovalBlock: boolean;
  readonly allowParallelWork: boolean;
  readonly allowParallelReview: boolean;
  readonly planningEnabled: boolean;
  readonly qualityEnabled: boolean;
  readonly cooldownActive: boolean;
  readonly supplyChainApprovalRequired: boolean;
}

interface IndexedState {
  readonly sourceId: string;
  readonly envelope: AiuTrustedStateEnvelope;
  readonly value: AiuTrustedStatePayload;
}

const DEFAULT_POLICY: DecisionPolicy = Object.freeze({
  modes: Object.freeze([...AIU_DECISION_MODES]),
  stopOnUnknownState: true,
  stopOnStaleState: true,
  stopOnUnsafeState: true,
  stopOnSupplyChainApprovalBlock: true,
  allowParallelWork: false,
  allowParallelReview: false,
  planningEnabled: true,
  qualityEnabled: true,
  cooldownActive: false,
  supplyChainApprovalRequired: false,
});

const HARD_STOP_VALUES = new Set<AiuStateValueKind>(["malformed", "unsupported", "untrusted"]);
const REPAIRABLE_VALUES = new Set<AiuStateValueKind>(["fail", "missing", "stale", "unknown"]);

export function decideAiuContinuation(input: AiuContinuationDecisionInput): AiuContinuationDecision {
  const policy = normalizeDecisionPolicy(input);
  const indexed = input.states.map(indexState);
  const summaries = input.states.map(summarizeSource);

  if (policy.supplyChainApprovalRequired && policy.stopOnSupplyChainApprovalBlock) {
    return decision(policy, "stop", "stop-supply-chain-approval", summaries, "stop", undefined, "Stop: supply-chain policy requires human approval before continuing.");
  }

  const hardStop = findHardInputStop(indexed, policy);
  if (hardStop) {
    return decision(policy, "stop", hardStop.reasonCode, summaries, "stop", hardStop.selectedItem, hardStop.nextAction);
  }

  if (policy.qualityEnabled) {
    const qualitySupplyChainBlock = findQualitySupplyChainBlock(indexed);
    if (qualitySupplyChainBlock && policy.stopOnSupplyChainApprovalBlock) {
      return decision(policy, "stop", "stop-supply-chain-approval", summaries, "stop", qualitySupplyChainBlock, "Stop: quality state reports supply-chain risk requiring human approval.");
    }

    const qualityHumanBlock = findQualityHumanBlock(indexed);
    if (qualityHumanBlock) {
      return decision(policy, "stop", "stop-human-input-required", summaries, "stop", qualityHumanBlock, "Stop: quality state requires human approval before continuing.");
    }

    const qualityUnsupportedBlock = findQualityUnsupportedBlock(indexed);
    if (qualityUnsupportedBlock) {
      return decision(policy, "stop", "stop-unsupported-input", summaries, "stop", qualityUnsupportedBlock, "Stop: quality state reports unsupported quality continuation.");
    }

    const qualityUnknownBlock = findQualityUnknownBlock(indexed, policy);
    if (qualityUnknownBlock) {
      return decision(policy, "stop", "stop-unknown-input", summaries, "stop", qualityUnknownBlock, "Stop: refresh quality state before continuing.");
    }
  }

  if (policy.planningEnabled) {
    const planningSupplyChainBlock = findPlanningSupplyChainBlock(indexed);
    if (planningSupplyChainBlock && policy.stopOnSupplyChainApprovalBlock) {
      return decision(policy, "stop", "stop-supply-chain-approval", summaries, "stop", planningSupplyChainBlock, "Stop: planning state reports supply-chain risk requiring human approval.");
    }

    const planningHumanBlock = findPlanningHumanBlock(indexed);
    if (planningHumanBlock) {
      return decision(policy, "stop", "stop-human-input-required", summaries, "stop", planningHumanBlock, "Stop: answer the named planning question before continuing.");
    }

    const planningUnsupportedBlock = findPlanningUnsupportedBlock(indexed);
    if (planningUnsupportedBlock) {
      return decision(policy, "stop", "stop-unsupported-input", summaries, "stop", planningUnsupportedBlock, "Stop: planning state reports unsupported planning continuation.");
    }

    const planningUnknownBlock = findPlanningUnknownBlock(indexed, policy);
    if (planningUnknownBlock) {
      return decision(policy, "stop", "stop-unknown-input", summaries, "stop", planningUnknownBlock, "Stop: refresh planning state before continuing.");
    }
  }

  const contradiction = findContradiction(indexed);
  if (contradiction) {
    return decision(policy, "stop", "stop-contradictory-state", summaries, "stop", contradiction, "Stop: refresh trusted state because sources report contradictory workflow state.");
  }

  const activeWork = collectActiveWork(indexed);
  if (activeWork.length > 1 && !policy.allowParallelWork) {
    return decision(policy, "stop", "stop-active-work-conflict", summaries, "stop", selectWorkItem(activeWork[0]), "Stop: reconcile multiple active work items before continuing.");
  }

  const activeReviews = collectActiveReviews(indexed);
  if (activeReviews.length > 1 && !policy.allowParallelReview) {
    return decision(policy, "stop", "stop-active-review-conflict", summaries, "stop", selectReview(activeReviews[0]), "Stop: reconcile multiple active review items before continuing.");
  }

  const repair = findRepair(indexed);
  if (repair) {
    return decision(policy, "repair", repair.reasonCode, summaries, "repair", repair.selectedItem, repair.nextAction);
  }

  if (policy.cooldownActive) {
    return decision(policy, "wait", "wait-cooldown-active", summaries, "wait", undefined, "Wait: a configured continuation cooldown is still active.");
  }

  const busyHost = findBusyHost(indexed);
  if (busyHost) {
    return decision(policy, "wait", "wait-host-session-busy", summaries, "wait", busyHost, "Wait: the host session is busy or cannot receive a prompt.");
  }

  if (activeReviews.length >= 1) {
    return decision(policy, "continue", "continue-active-review", summaries, "review", selectReview(activeReviews[0]), "Continue: handle the active review item before starting new work.");
  }

  if (activeWork.length >= 1) {
    return decision(policy, "continue", "continue-active-work", summaries, "work", selectWorkItem(activeWork[0]), "Continue: resume the active work item before starting new work.");
  }

  if (input.whipStateError) {
    return decision(policy, "stop", "stop-malformed-input", summaries, "stop", input.whipStateError, "Stop: fix malformed whip task state before continuing idle work.");
  }

  const planning = findPlanningContinuation(indexed, policy);
  if (planning) {
    return decision(policy, "continue", "continue-planning", summaries, "planning", planning, "Continue: run the next planning action from trusted planning state.");
  }

  const readyWork = collectReadyWork(indexed)[0];
  if (readyWork) {
    return decision(policy, "continue", "continue-ready-work", summaries, "work", selectWorkItem(readyWork), "Continue: start the highest-priority ready work item.");
  }

  const quality = findQualityContinuation(indexed, policy);
  if (quality) {
    return decision(policy, "continue", "continue-quality", summaries, "quality", quality, "Continue: run the ready quality or idle-work action.");
  }

  const whipTask = input.whipTask ?? (input.whipTaskReady === true ? { id: "ready", title: "Ready whip task", prompt: "Use the ready whip task slot." } : undefined);
  if (whipTask) {
    return decision(policy, "continue", "continue-whip-task", summaries, "whip", selectWhipTask(whipTask), "Continue: use the ready whip task slot.");
  }

  return decision(policy, "stop", "stop-clean", summaries, "stop", undefined, "Stop: no continuation, repair, or wait condition remains.");
}

function normalizeDecisionPolicy(input: AiuContinuationDecisionInput): DecisionPolicy {
  const statePolicy = input.states.find((item) => item.value.kind === "continuation-policy")?.value;
  const configured = input.policy ?? {};
  const allowedModes = statePolicy?.kind === "continuation-policy" ? statePolicy.allowedModes : undefined;

  return Object.freeze({
    modes: normalizeModes(configured.modes ?? allowedModes),
    stopOnUnknownState: normalizeBoolean(configured.stopOnUnknownState, statePolicy?.kind === "continuation-policy" ? statePolicy.stopOnUnknownState : undefined, DEFAULT_POLICY.stopOnUnknownState),
    stopOnStaleState: normalizeBoolean(configured.stopOnStaleState, statePolicy?.kind === "continuation-policy" ? statePolicy.stopOnStaleState : undefined, DEFAULT_POLICY.stopOnStaleState),
    stopOnUnsafeState: configured.stopOnUnsafeState ?? DEFAULT_POLICY.stopOnUnsafeState,
    stopOnSupplyChainApprovalBlock: normalizeBoolean(configured.stopOnSupplyChainApprovalBlock, statePolicy?.kind === "continuation-policy" ? statePolicy.stopOnSupplyChainApprovalBlock : undefined, DEFAULT_POLICY.stopOnSupplyChainApprovalBlock),
    allowParallelWork: configured.allowParallelWork ?? DEFAULT_POLICY.allowParallelWork,
    allowParallelReview: configured.allowParallelReview ?? DEFAULT_POLICY.allowParallelReview,
    planningEnabled: configured.planningEnabled ?? DEFAULT_POLICY.planningEnabled,
    qualityEnabled: configured.qualityEnabled ?? DEFAULT_POLICY.qualityEnabled,
    cooldownActive: configured.cooldownActive ?? DEFAULT_POLICY.cooldownActive,
    supplyChainApprovalRequired: configured.supplyChainApprovalRequired ?? DEFAULT_POLICY.supplyChainApprovalRequired,
  });
}

function normalizeModes(value: readonly AiuContinuationDecisionKind[] | undefined): readonly AiuContinuationDecisionKind[] {
  const modes = (value ?? DEFAULT_POLICY.modes).filter((item, index, all) => DEFAULT_POLICY.modes.includes(item) && all.indexOf(item) === index);
  return Object.freeze(modes.length === 0 ? [...DEFAULT_POLICY.modes] : modes);
}

function normalizeBoolean(
  configured: boolean | undefined,
  stateValue: boolean | "unknown" | "unsupported" | undefined,
  fallback: boolean,
): boolean {
  if (configured !== undefined) return configured;
  if (typeof stateValue === "boolean") return stateValue;
  return fallback;
}

function findHardInputStop(indexed: readonly IndexedState[], policy: DecisionPolicy): { readonly reasonCode: AiuReasonCode; readonly selectedItem?: AiuDecisionSelectedItem; readonly nextAction: string } | undefined {
  for (const item of indexed) {
    if (item.envelope.trustLevel === "untrusted") {
      return {
        reasonCode: "stop-untrusted-input",
        selectedItem: selectState(item),
        nextAction: "Stop: replace untrusted state with trusted structured state before continuing.",
      };
    }
    if (policy.stopOnStaleState && item.envelope.freshness.kind === "stale") {
      return {
        reasonCode: "stop-stale-input",
        selectedItem: selectState(item),
        nextAction: "Stop: refresh stale trusted state before continuing.",
      };
    }
    if (item.envelope.diagnostics.some((diagnostic) => diagnostic.kind === "malformed")) {
      return {
        reasonCode: "stop-malformed-input",
        selectedItem: selectState(item),
        nextAction: "Stop: fix malformed trusted state output before continuing.",
      };
    }
    if (policy.stopOnUnsafeState && HARD_STOP_VALUES.has(item.value.status)) {
      return {
        reasonCode: statusReasonCode(item.value.status),
        selectedItem: selectState(item),
        nextAction: `Stop: ${item.value.kind} state is ${item.value.status} and cannot be used safely.`,
      };
    }
    if (policy.stopOnUnknownState && item.value.status === "unknown" && !isRepairableUnknown(item.value.kind)) {
      return {
        reasonCode: "stop-unknown-input",
        selectedItem: selectState(item),
        nextAction: "Stop: refresh unknown trusted state before continuing.",
      };
    }
  }

  return undefined;
}

function findPlanningHumanBlock(indexed: readonly IndexedState[]): AiuDecisionSelectedItem | undefined {
  for (const item of indexed) {
    if (!hasKind(item, "planning")) continue;
    if (
      item.value.humanInputRequired === true
      || item.value.unresolvedQuestions.some((question) => question.requiresHuman === true || isHumanPlanningQuestion(question.category))
      || item.value.stopCondition?.requiresHuman === true
      || (item.value.stopCondition?.status !== "pass" && (
        item.value.stopCondition?.category === "human-question"
        || item.value.stopCondition?.category === "ambiguous-mapping"
        || item.value.stopCondition?.category === "artifact-inconsistency"
      ))
    ) {
      return selectPlanningState(item);
    }
  }
  return undefined;
}

function findPlanningSupplyChainBlock(indexed: readonly IndexedState[]): AiuDecisionSelectedItem | undefined {
  for (const item of indexed) {
    if (!hasKind(item, "planning")) continue;
    if (
      item.value.supplyChainApprovalRequired === true
      || (item.value.stopCondition?.status !== "pass" && item.value.stopCondition?.category === "supply-chain-approval")
      || item.value.unresolvedQuestions.some((question) => question.category === "supply-chain" && question.requiresHuman !== false)
    ) {
      return selectPlanningState(item);
    }
  }
  return undefined;
}

function findPlanningUnsupportedBlock(indexed: readonly IndexedState[]): AiuDecisionSelectedItem | undefined {
  for (const item of indexed) {
    if (!hasKind(item, "planning")) continue;
    if (item.value.needsPlanning === "unsupported" || item.value.nextAction?.status === "unsupported" || item.value.stopCondition?.status === "unsupported") {
      return selectPlanningState(item);
    }
  }
  return undefined;
}

function findPlanningUnknownBlock(indexed: readonly IndexedState[], policy: DecisionPolicy): AiuDecisionSelectedItem | undefined {
  if (!policy.stopOnUnknownState) {
    return undefined;
  }
  for (const item of indexed) {
    if (!hasKind(item, "planning")) continue;
    if (
      item.value.needsPlanning === "unknown"
      || item.value.humanInputRequired === "unknown"
      || item.value.supplyChainApprovalRequired === "unknown"
      || item.value.unresolvedQuestions.some((question) => question.status === "unknown" || question.requiresHuman === "unknown")
      || item.value.artifacts.some((artifact) => artifact.status === "unknown")
      || item.value.stopCondition?.status === "unknown"
      || (item.value.needsPlanning === true && selectPlanningAction(item) === undefined)
    ) {
      return selectPlanningState(item);
    }
  }
  return undefined;
}

function findQualitySupplyChainBlock(indexed: readonly IndexedState[]): AiuDecisionSelectedItem | undefined {
  for (const item of indexed) {
    if (!hasKind(item, "quality")) continue;
    if (item.value.supplyChainApprovalRequired === true || item.value.findings.some((finding) => finding.supplyChainApprovalRequired === true)) {
      return selectQualityState(item);
    }
  }
  return undefined;
}

function findQualityHumanBlock(indexed: readonly IndexedState[]): AiuDecisionSelectedItem | undefined {
  for (const item of indexed) {
    if (!hasKind(item, "quality")) continue;
    if (item.value.humanApprovalRequired === true || item.value.findings.some((finding) => finding.humanApprovalRequired === true)) {
      return selectQualityState(item);
    }
  }
  return undefined;
}

function findQualityUnsupportedBlock(indexed: readonly IndexedState[]): AiuDecisionSelectedItem | undefined {
  for (const item of indexed) {
    if (!hasKind(item, "quality")) continue;
    if (item.value.ready === "unsupported" || item.value.lastRunStatus === "unsupported") {
      return selectQualityState(item);
    }
  }
  return undefined;
}

function findQualityUnknownBlock(indexed: readonly IndexedState[], policy: DecisionPolicy): AiuDecisionSelectedItem | undefined {
  if (!policy.stopOnUnknownState) {
    return undefined;
  }
  for (const item of indexed) {
    if (!hasKind(item, "quality")) continue;
    if (
      item.value.ready === "unknown"
      || item.value.lastRunStatus === "unknown"
      || item.value.humanApprovalRequired === "unknown"
      || item.value.supplyChainApprovalRequired === "unknown"
      || item.value.findings.some((finding) => finding.humanApprovalRequired === "unknown" || finding.supplyChainApprovalRequired === "unknown")
      || (item.value.ready === true && selectQualityTarget(item) === undefined)
    ) {
      return selectQualityState(item);
    }
  }
  return undefined;
}

function findContradiction(indexed: readonly IndexedState[]): AiuDecisionSelectedItem | undefined {
  const workSignatures = new Set(indexed.filter((item) => hasKind(item, "work-queue")).map((item) => workQueueSignature(item.value)));
  if (workSignatures.size > 1) {
    const first = indexed.find((item) => item.value.kind === "work-queue");
    return first ? selectState(first) : undefined;
  }

  const repositorySignatures = new Set(
    indexed
      .filter((item) => hasKind(item, "repository"))
      .map((item) => [item.value.activeRef ?? "", item.value.baseRef ?? "", item.value.baseFreshness, item.value.syncStatus].join("\0")),
  );
  if (repositorySignatures.size > 1) {
    const first = indexed.find((item) => item.value.kind === "repository");
    return first ? selectState(first) : undefined;
  }

  return undefined;
}

function findBusyHost(indexed: readonly IndexedState[]): AiuDecisionSelectedItem | undefined {
  const busy = indexed.find((item) => item.value.kind === "host-session" && (item.value.sessionStatus === "busy" || item.value.canPrompt === false));
  return busy ? selectState(busy) : undefined;
}

function findRepair(indexed: readonly IndexedState[]): { readonly reasonCode: AiuReasonCode; readonly selectedItem?: AiuDecisionSelectedItem; readonly nextAction: string } | undefined {
  const activeReviewRepair = indexed.find((item) => item.value.kind === "review" && (item.value.status === "fail" || item.value.reviewStatus === "blocked" || item.value.reviewStatus === "unknown"));
  if (activeReviewRepair) {
    return {
      reasonCode: "repair-active-review",
      selectedItem: selectState(activeReviewRepair),
      nextAction: "Repair: refresh or reconcile the active review state.",
    };
  }

  const activeWorkRepair = collectActiveWork(indexed).find((item) => item.status !== "pass" || item.blockers.length > 0 || item.lifecycle === "unknown");
  if (activeWorkRepair) {
    return {
      reasonCode: "repair-active-work",
      selectedItem: selectWorkItem(activeWorkRepair),
      nextAction: "Repair: resolve active work state before continuing.",
    };
  }

  const repositoryRepair = indexed.find((item) => item.value.kind === "repository" && (item.value.dirty !== "pass" || item.value.baseFreshness !== "pass" || item.value.syncStatus === "behind" || item.value.syncStatus === "diverged" || item.value.syncStatus === "unknown"));
  if (repositoryRepair) {
    return {
      reasonCode: "repair-repository-state",
      selectedItem: selectState(repositoryRepair),
      nextAction: "Repair: update the repository state, clean the checkout, or refresh base-ref freshness.",
    };
  }

  const gateRepair = indexed
    .filter((item) => hasKind(item, "gate-evidence"))
    .flatMap((item) => item.value.gates.map((gate) => ({ gate, sourceId: item.sourceId })))
    .find((item) => item.gate.required && REPAIRABLE_VALUES.has(item.gate.status));
  if (gateRepair) {
    return {
      reasonCode: "repair-gate-evidence",
      selectedItem: selectGate(gateRepair.gate, gateRepair.sourceId),
      nextAction: "Repair: run or refresh required gate evidence before merge, submit, or completion.",
    };
  }

  return undefined;
}

function collectActiveWork(indexed: readonly IndexedState[]): readonly AiuWorkItemState[] {
  return uniqueWorkItems([
    ...indexed.filter((item) => hasKind(item, "work-queue")).flatMap((item) => item.value.activeItems),
    ...indexed.filter((item) => item.value.kind === "work-item" && item.value.lifecycle === "active").map((item) => item.value as AiuWorkItemState),
  ]);
}

function collectReadyWork(indexed: readonly IndexedState[]): readonly AiuWorkItemState[] {
  return uniqueWorkItems([
    ...indexed.filter((item) => hasKind(item, "work-queue")).flatMap((item) => item.value.readyItems),
    ...indexed.filter((item) => item.value.kind === "work-item" && item.value.lifecycle === "ready").map((item) => item.value as AiuWorkItemState),
  ]).sort(compareWorkPriority);
}

function collectActiveReviews(indexed: readonly IndexedState[]): readonly AiuReviewState[] {
  return uniqueReviews(indexed
    .filter((item) => item.value.kind === "review" && (item.value.reviewStatus === "active" || item.value.reviewStatus === "changes-requested"))
    .map((item) => item.value as AiuReviewState));
}

function workQueueSignature(value: Extract<AiuTrustedStatePayload, { readonly kind: "work-queue" }>): string {
  return JSON.stringify({
    status: value.status,
    activeItems: value.activeItems.map(workItemSignature).sort(),
    readyItems: value.readyItems.map(workItemSignature).sort(),
  });
}

function workItemSignature(value: AiuWorkItemState): string {
  return JSON.stringify({
    id: value.id,
    lifecycle: value.lifecycle,
    status: value.status,
    blockers: [...value.blockers].sort(),
    priority: value.priority ?? "",
  });
}

function uniqueReviews(items: readonly AiuReviewState[]): readonly AiuReviewState[] {
  return [...new Map(items.map((item) => [reviewIdentity(item), item])).values()];
}

function reviewIdentity(item: AiuReviewState): string {
  return item.targetId ?? `${item.reviewStatus}:${item.status}:${item.unresolvedFeedbackCount ?? ""}`;
}

function findPlanningContinuation(indexed: readonly IndexedState[], policy: DecisionPolicy): AiuDecisionSelectedItem | undefined {
  if (!policy.planningEnabled) {
    return undefined;
  }
  for (const planning of indexed.filter((item) => hasKind(item, "planning"))) {
    if (planning.value.needsPlanning !== true || planning.value.humanInputRequired !== false) {
      continue;
    }
    const action = selectPlanningAction(planning);
    if (action) {
      return action;
    }
  }
  return undefined;
}

function findQualityContinuation(indexed: readonly IndexedState[], policy: DecisionPolicy): AiuDecisionSelectedItem | undefined {
  if (!policy.qualityEnabled) {
    return undefined;
  }
  for (const quality of indexed.filter((item) => hasKind(item, "quality"))) {
    if (quality.value.ready !== true) {
      continue;
    }
    const target = selectQualityTarget(quality);
    if (target) {
      return target;
    }
  }
  return undefined;
}

function uniqueWorkItems(items: readonly AiuWorkItemState[]): AiuWorkItemState[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function compareWorkPriority(left: AiuWorkItemState, right: AiuWorkItemState): number {
  return priorityRank(right.priority) - priorityRank(left.priority) || left.id.localeCompare(right.id);
}

function priorityRank(value: AiuWorkItemState["priority"]): number {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "normal") return 2;
  if (value === "low") return 1;
  return 0;
}

function indexState(envelope: AiuTrustedStateEnvelope): IndexedState {
  return Object.freeze({
    sourceId: envelope.sourceId,
    envelope,
    value: envelope.value,
  });
}

function summarizeSource(envelope: AiuTrustedStateEnvelope): AiuDecisionSourceSummary {
  return Object.freeze({
    sourceId: envelope.sourceId,
    stateKind: envelope.stateKind,
    status: envelope.value.status,
    trustLevel: envelope.trustLevel,
    freshness: envelope.freshness.kind,
    observedAt: envelope.observedAt,
    ...(envelope.value.summary ? { summary: envelope.value.summary } : {}),
  });
}

function decision(
  policy: DecisionPolicy,
  kind: AiuContinuationDecisionKind,
  reasonCode: AiuReasonCode,
  sourceSummaries: readonly AiuDecisionSourceSummary[],
  promptKind: AiuDecisionPromptKind,
  selectedItem: AiuDecisionSelectedItem | undefined,
  recommendedNextAction: string,
): AiuContinuationDecision {
  const selectedMode = selectAllowedMode(policy, kind);
  const reasonCodes: readonly AiuReasonCode[] = selectedMode === kind ? [reasonCode] : ["stop-safety-block"];
  return Object.freeze({
    kind: selectedMode === kind ? kind : "stop",
    reasonCodes: Object.freeze([...reasonCodes]),
    sourceSummaries: Object.freeze([...sourceSummaries]),
    selectedMode,
    ...(selectedItem ? { selectedItem: Object.freeze({ ...selectedItem }) } : {}),
    confidence: selectedMode === kind ? confidenceFor(kind) : 0.4,
    promptKind: selectedMode === kind ? promptKind : "stop",
    recommendedNextAction: selectedMode === kind ? recommendedNextAction : `Stop: decision mode ${kind} is not allowed by policy.`,
  });
}

function selectAllowedMode(policy: DecisionPolicy, kind: AiuContinuationDecisionKind): AiuContinuationDecisionKind {
  return policy.modes.includes(kind) ? kind : "stop";
}

function confidenceFor(kind: AiuContinuationDecisionKind): number {
  if (kind === "stop") return 1;
  if (kind === "repair") return 0.9;
  if (kind === "wait") return 0.95;
  return 0.85;
}

function selectState(item: IndexedState): AiuDecisionSelectedItem {
  return Object.freeze({
    kind: item.value.kind,
    sourceId: item.sourceId,
    status: item.value.status,
  });
}

function selectPlanningState(item: IndexedState & { readonly value: Extract<AiuTrustedStatePayload, { readonly kind: "planning" }> }): AiuDecisionSelectedItem {
  return Object.freeze({
    kind: "planning",
    sourceId: item.sourceId,
    status: item.value.status,
    ...(item.value.currentPhase ? { title: item.value.currentPhase } : {}),
    affectedPaths: Object.freeze([...item.value.draftPaths]),
  });
}

function selectPlanningAction(item: IndexedState & { readonly value: Extract<AiuTrustedStatePayload, { readonly kind: "planning" }> }): AiuDecisionSelectedItem | undefined {
  const action = item.value.nextAction;
  if (!isConcretePlanningAction(action)) return undefined;
  return Object.freeze({
    kind: "planning",
    id: action.id,
    ...(action.title ? { title: action.title } : {}),
    sourceId: item.sourceId,
    status: action.status,
    targetKind: action.kind ?? "planning-action",
    affectedPaths: Object.freeze([...action.draftPaths, ...item.value.draftPaths].filter((path, index, all) => all.indexOf(path) === index)),
    ...(action.command ? { command: action.command } : {}),
    artifactChecks: Object.freeze([...action.artifactChecks]),
    expectedEvidence: action.expectedEvidence ?? "Updated trusted Bootstrap planning state plus the configured planning action evidence.",
  });
}

function selectWorkItem(item: AiuWorkItemState | undefined): AiuDecisionSelectedItem | undefined {
  if (!item) return undefined;
  return Object.freeze({
    kind: "work-item",
    id: item.id,
    ...(item.title ? { title: item.title } : {}),
    status: item.status,
  });
}

function selectReview(item: AiuReviewState | undefined): AiuDecisionSelectedItem | undefined {
  if (!item) return undefined;
  return Object.freeze({
    kind: "review",
    ...(item.targetId ? { id: item.targetId } : {}),
    status: item.reviewStatus,
  });
}

function selectGate(gate: AiuGateState, sourceId: string): AiuDecisionSelectedItem {
  return Object.freeze({
    kind: "gate",
    id: gate.id,
    title: gate.name,
    sourceId,
    status: gate.status,
  });
}

function selectQualityState(item: IndexedState & { readonly value: Extract<AiuTrustedStatePayload, { readonly kind: "quality" }> }): AiuDecisionSelectedItem {
  return Object.freeze({
    kind: "quality",
    sourceId: item.sourceId,
    status: item.value.status,
  });
}

function selectQualityTarget(item: IndexedState & { readonly value: Extract<AiuTrustedStatePayload, { readonly kind: "quality" }> }): AiuDecisionSelectedItem | undefined {
  const target = item.value.selectedTarget?.status === "fail"
    ? item.value.selectedTarget
    : firstFailingQualityTarget(item.value.findings, item.value.stages);
  if (!target) return undefined;
  const command = target.command ?? item.value.nextCommand;
  const rerunCommand = target.rerunCommand ?? item.value.rerunCommand;
  return Object.freeze({
    kind: "quality",
    id: target.id,
    ...(target.title ? { title: target.title } : {}),
    sourceId: item.sourceId,
    status: target.status,
    targetKind: target.kind,
    affectedPaths: Object.freeze([...target.affectedPaths]),
    ...(command ? { command } : {}),
    ...(rerunCommand ? { rerunCommand } : {}),
    expectedEvidence: target.expectedEvidence ?? "Updated trusted quality state plus the rerun check output.",
  });
}

function selectWhipTask(task: AiuDecisionWhipTask): AiuDecisionSelectedItem {
  return Object.freeze({
    kind: "whip",
    id: task.id,
    title: task.title,
    status: "ready",
    prompt: task.prompt,
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
    ...(task.promptFingerprint ? { promptFingerprint: task.promptFingerprint } : {}),
  });
}

function firstFailingQualityTarget(
  findings: readonly AiuQualityFinding[],
  stages: readonly AiuQualityStage[],
): AiuQualitySelectedTarget | undefined {
  const finding = findings.find((item) => item.status === "fail");
  if (finding) {
    return Object.freeze({
      kind: "finding" as const,
      id: finding.id,
      ...(finding.title ? { title: finding.title } : {}),
      ...(finding.stageId ? { stageId: finding.stageId } : {}),
      status: finding.status,
      affectedPaths: Object.freeze([...finding.affectedPaths]),
      ...(finding.command ? { command: finding.command } : {}),
      ...(finding.rerunCommand ? { rerunCommand: finding.rerunCommand } : {}),
      expectedEvidence: "Resolve the finding and rerun the configured quality check.",
    });
  }
  const stage = stages.find((item) => item.status === "fail");
  if (stage) {
    return Object.freeze({
      kind: "stage" as const,
      id: stage.id,
      ...(stage.title ? { title: stage.title } : {}),
      status: stage.status,
      affectedPaths: Object.freeze([...stage.affectedPaths]),
      ...(stage.command ? { command: stage.command } : {}),
      ...(stage.rerunCommand ? { rerunCommand: stage.rerunCommand } : {}),
      expectedEvidence: "Fix one concrete failure in this stage and rerun the configured quality check.",
    });
  }
  return undefined;
}

function statusReasonCode(value: AiuStateValueKind): AiuReasonCode {
  if (value === "malformed") return "stop-malformed-input";
  if (value === "unsupported") return "stop-unsupported-input";
  if (value === "untrusted") return "stop-untrusted-input";
  if (value === "stale") return "stop-stale-input";
  if (value === "unknown") return "stop-unknown-input";
  return "stop-safety-block";
}

function isRepairableUnknown(kind: AiuTrustedStateKind): boolean {
  return kind === "repository" || kind === "gate-evidence" || kind === "review";
}

function isConcretePlanningAction(action: AiuPlanningAction | undefined): action is AiuPlanningAction {
  return action !== undefined
    && action.status === "pass"
    && action.id.length > 0
    && (action.command !== undefined || action.artifactChecks.length > 0 || action.draftPaths.length > 0);
}

function isHumanPlanningQuestion(category: string | undefined): boolean {
  const externalSchemaQuestion = ["provider", "schema"].join("-");
  return category === "product-decision" || category === externalSchemaQuestion || category === "work-item-mapping" || category === "artifact-inconsistency";
}

function hasKind<TKind extends AiuTrustedStateKind>(
  item: IndexedState,
  kind: TKind,
): item is IndexedState & { readonly value: Extract<AiuTrustedStatePayload, { readonly kind: TKind }> } {
  return item.value.kind === kind;
}
