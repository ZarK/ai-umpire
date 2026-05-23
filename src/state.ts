export const AIU_TRUSTED_STATE_SCHEMA_VERSION = 1;

export const AIU_TRUSTED_STATE_KINDS = [
  "work-queue",
  "work-item",
  "review",
  "repository",
  "gate-evidence",
  "planning",
  "quality",
  "host-session",
  "continuation-policy",
] as const;

export const AIU_STATE_VALUE_KINDS = [
  "pass",
  "fail",
  "missing",
  "stale",
  "unknown",
  "unsupported",
  "untrusted",
  "malformed",
] as const;

export const AIU_TRUST_LEVELS = ["trusted", "advisory", "untrusted"] as const;
export const AIU_STATE_FRESHNESS_KINDS = ["fresh", "stale", "unknown"] as const;
export const AIU_STATE_CAPABILITY_SUPPORT = ["supported", "unsupported", "unknown"] as const;
export const AIU_QUALITY_TARGET_KINDS = ["stage", "finding"] as const;

export const AIU_REASON_CODES = [
  "continue-active-work",
  "continue-active-review",
  "continue-planning",
  "continue-quality",
  "continue-ready-work",
  "continue-whip-task",
  "repair-active-work",
  "repair-active-review",
  "repair-repository-state",
  "repair-gate-evidence",
  "wait-host-session-busy",
  "wait-cooldown-active",
  "stop-clean",
  "stop-malformed-input",
  "stop-stale-input",
  "stop-unknown-input",
  "stop-unsupported-input",
  "stop-untrusted-input",
  "stop-safety-block",
  "stop-supply-chain-approval",
  "stop-human-input-required",
  "stop-contradictory-state",
  "stop-active-work-conflict",
  "stop-active-review-conflict",
] as const;

export const AIU_REASON_CODE_CATALOG: readonly AiuReasonCodeDefinition[] = Object.freeze([
  reasonCode("continue-active-work", "continuation", "continue", "An active work item is safe to continue."),
  reasonCode("continue-active-review", "continuation", "continue", "An active review item is safe to continue."),
  reasonCode("continue-planning", "continuation", "continue", "Planning work is ready and does not require human input."),
  reasonCode("continue-quality", "continuation", "continue", "Quality or idle work is ready to run."),
  reasonCode("continue-ready-work", "continuation", "continue", "A ready work item can be started."),
  reasonCode("continue-whip-task", "continuation", "continue", "A configured whip task slot is available after higher-priority work is idle."),
  reasonCode("repair-active-work", "repair", "repair", "Active work state is invalid or incomplete and needs repair."),
  reasonCode("repair-active-review", "repair", "repair", "Active review state is invalid or incomplete and needs repair."),
  reasonCode("repair-repository-state", "repair", "repair", "Repository state is dirty, stale, or inconsistent."),
  reasonCode("repair-gate-evidence", "repair", "repair", "Gate evidence is failed, missing, stale, or unknown."),
  reasonCode("wait-host-session-busy", "wait", "wait", "The host session is busy and should not be interrupted."),
  reasonCode("wait-cooldown-active", "wait", "wait", "A configured cooldown blocks another continuation prompt."),
  reasonCode("stop-clean", "stop", "stop", "No continuation, repair, or wait condition remains."),
  reasonCode("stop-malformed-input", "input", "stop", "A trusted state payload is malformed."),
  reasonCode("stop-stale-input", "input", "stop", "A trusted state payload is stale."),
  reasonCode("stop-unknown-input", "input", "stop", "A trusted state payload reports unknown state."),
  reasonCode("stop-unsupported-input", "input", "stop", "A required trusted state capability is unsupported."),
  reasonCode("stop-untrusted-input", "input", "stop", "A required trusted state source is untrusted."),
  reasonCode("stop-safety-block", "safety", "stop", "A hard safety block prevents continuation."),
  reasonCode("stop-supply-chain-approval", "safety", "stop", "Supply-chain policy requires human approval."),
  reasonCode("stop-human-input-required", "safety", "stop", "Planning or policy requires a human answer."),
  reasonCode("stop-contradictory-state", "safety", "stop", "Trusted state sources conflict."),
  reasonCode("stop-active-work-conflict", "safety", "stop", "Multiple active work items conflict with current policy."),
  reasonCode("stop-active-review-conflict", "safety", "stop", "Multiple active reviews conflict with current policy."),
]);

export type AiuTrustedStateKind = (typeof AIU_TRUSTED_STATE_KINDS)[number];
export type AiuStateValueKind = (typeof AIU_STATE_VALUE_KINDS)[number];
export type AiuTrustLevel = (typeof AIU_TRUST_LEVELS)[number];
export type AiuStateFreshnessKind = (typeof AIU_STATE_FRESHNESS_KINDS)[number];
export type AiuStateCapabilitySupport = (typeof AIU_STATE_CAPABILITY_SUPPORT)[number];
export type AiuQualityTargetKind = (typeof AIU_QUALITY_TARGET_KINDS)[number];
export type AiuReasonCode = (typeof AIU_REASON_CODES)[number];
export type AiuReasonCodeCategory = "continuation" | "repair" | "wait" | "stop" | "input" | "safety";
export type AiuContinuationDecisionKind = "continue" | "repair" | "wait" | "stop";

export interface AiuReasonCodeDefinition {
  readonly code: AiuReasonCode;
  readonly category: AiuReasonCodeCategory;
  readonly decision: AiuContinuationDecisionKind;
  readonly description: string;
}

export interface AiuTrustedStateCommandRef {
  readonly id: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface AiuStateFreshness {
  readonly kind: AiuStateFreshnessKind;
  readonly observedAt: string;
  readonly ageMs?: number;
  readonly staleAfterMs?: number;
}

export interface AiuTrustedStateDiagnostic {
  readonly severity: "error" | "warning";
  readonly kind: AiuStateValueKind;
  readonly path: string;
  readonly message: string;
  readonly reasonCode?: AiuReasonCode;
}

export interface AiuTrustedStateEnvelope<TState extends AiuTrustedStatePayload = AiuTrustedStatePayload> {
  readonly schemaVersion: typeof AIU_TRUSTED_STATE_SCHEMA_VERSION;
  readonly sourceId: string;
  readonly stateKind: TState["kind"];
  readonly command: AiuTrustedStateCommandRef;
  readonly observedAt: string;
  readonly trustLevel: AiuTrustLevel;
  readonly capabilities: Readonly<Record<string, AiuStateCapabilitySupport>>;
  readonly freshness: AiuStateFreshness;
  readonly value: TState;
  readonly unknownFields: readonly string[];
  readonly diagnostics: readonly AiuTrustedStateDiagnostic[];
}

export type AiuTrustedStateEnvelopeInput<TState extends AiuTrustedStatePayload = AiuTrustedStatePayload> = Omit<
  AiuTrustedStateEnvelope<TState>,
  "schemaVersion" | "stateKind" | "unknownFields" | "diagnostics"
> & {
  readonly unknownFields?: readonly string[];
  readonly diagnostics?: readonly AiuTrustedStateDiagnostic[];
};

export interface AiuBaseState<TKind extends AiuTrustedStateKind> {
  readonly kind: TKind;
  readonly status: AiuStateValueKind;
  readonly summary?: string;
  readonly reasonCodes?: readonly AiuReasonCode[];
}

export interface AiuWorkQueueState extends AiuBaseState<"work-queue"> {
  readonly activeItems: readonly AiuWorkItemState[];
  readonly readyItems: readonly AiuWorkItemState[];
  readonly blockedItems: readonly AiuWorkItemState[];
  readonly unknownItems: readonly AiuWorkItemState[];
}

export interface AiuWorkItemState extends AiuBaseState<"work-item"> {
  readonly id: string;
  readonly title?: string;
  readonly lifecycle: "active" | "ready" | "blocked" | "closed" | "unknown" | "unsupported";
  readonly priority?: "low" | "normal" | "high" | "critical";
  readonly blockers: readonly string[];
}

export interface AiuReviewState extends AiuBaseState<"review"> {
  readonly targetId?: string;
  readonly reviewStatus: "none" | "active" | "approved" | "changes-requested" | "blocked" | "unknown" | "unsupported";
  readonly unresolvedFeedbackCount?: number;
}

export interface AiuRepositoryState extends AiuBaseState<"repository"> {
  readonly activeRef?: string;
  readonly baseRef?: string;
  readonly dirty: AiuStateValueKind;
  readonly baseFreshness: AiuStateValueKind;
  readonly syncStatus: "in-sync" | "behind" | "ahead" | "diverged" | "unknown" | "unsupported";
}

export interface AiuGateEvidenceState extends AiuBaseState<"gate-evidence"> {
  readonly gates: readonly AiuGateState[];
}

export interface AiuGateState {
  readonly id: string;
  readonly name: string;
  readonly status: AiuStateValueKind;
  readonly required: boolean;
  readonly reasonCodes: readonly AiuReasonCode[];
}

export interface AiuPlanningState extends AiuBaseState<"planning"> {
  readonly needsPlanning: boolean | "unknown" | "unsupported";
  readonly humanInputRequired: boolean | "unknown";
}

export interface AiuQualityState extends AiuBaseState<"quality"> {
  readonly ready: boolean | "unknown" | "unsupported";
  readonly lastRunStatus: AiuStateValueKind;
  readonly stages: readonly AiuQualityStage[];
  readonly findings: readonly AiuQualityFinding[];
  readonly failingChecks: readonly string[];
  readonly affectedPaths: readonly string[];
  readonly nextCommand?: AiuTrustedStateCommandRef;
  readonly rerunCommand?: AiuTrustedStateCommandRef;
  readonly selectedTarget?: AiuQualitySelectedTarget;
  readonly humanApprovalRequired?: boolean | "unknown";
  readonly supplyChainApprovalRequired?: boolean | "unknown";
}

export interface AiuQualityStage {
  readonly id: string;
  readonly title?: string;
  readonly status: AiuStateValueKind;
  readonly affectedPaths: readonly string[];
  readonly command?: AiuTrustedStateCommandRef;
  readonly rerunCommand?: AiuTrustedStateCommandRef;
}

export interface AiuQualityFinding {
  readonly id: string;
  readonly title?: string;
  readonly stageId?: string;
  readonly status: AiuStateValueKind;
  readonly severity?: "low" | "medium" | "high" | "critical" | "unknown";
  readonly affectedPaths: readonly string[];
  readonly command?: AiuTrustedStateCommandRef;
  readonly rerunCommand?: AiuTrustedStateCommandRef;
  readonly humanApprovalRequired?: boolean | "unknown";
  readonly supplyChainApprovalRequired?: boolean | "unknown";
}

export interface AiuQualitySelectedTarget {
  readonly kind: AiuQualityTargetKind;
  readonly id: string;
  readonly title?: string;
  readonly stageId?: string;
  readonly status: AiuStateValueKind;
  readonly affectedPaths: readonly string[];
  readonly command?: AiuTrustedStateCommandRef;
  readonly rerunCommand?: AiuTrustedStateCommandRef;
  readonly expectedEvidence?: string;
}

export interface AiuHostSessionState extends AiuBaseState<"host-session"> {
  readonly hostId: string;
  readonly sessionId?: string;
  readonly selectedSessionId?: string;
  readonly helperSession?: boolean | "unknown" | "unsupported";
  readonly userActive?: boolean | "unknown" | "unsupported";
  readonly todoActive?: boolean | "unknown" | "unsupported";
  readonly sessionStatus: "idle" | "busy" | "waiting" | "stopped" | "unknown" | "unsupported";
  readonly canPrompt: boolean | "unknown" | "unsupported";
}

export interface AiuContinuationPolicyState extends AiuBaseState<"continuation-policy"> {
  readonly allowedModes: readonly AiuContinuationDecisionKind[];
  readonly stopOnUnknownState: boolean | "unknown" | "unsupported";
  readonly stopOnStaleState: boolean | "unknown" | "unsupported";
  readonly stopOnSupplyChainApprovalBlock: boolean | "unknown" | "unsupported";
  readonly allowProviderMutation: boolean | "unknown" | "unsupported";
  readonly allowBackgroundScheduling: boolean | "unknown" | "unsupported";
}

export type AiuTrustedStatePayload =
  | AiuWorkQueueState
  | AiuWorkItemState
  | AiuReviewState
  | AiuRepositoryState
  | AiuGateEvidenceState
  | AiuPlanningState
  | AiuQualityState
  | AiuHostSessionState
  | AiuContinuationPolicyState;

export function createAiuTrustedStateEnvelope<TState extends AiuTrustedStatePayload>(
  input: AiuTrustedStateEnvelopeInput<TState>,
): AiuTrustedStateEnvelope<TState> {
  return Object.freeze({
    ...input,
    schemaVersion: AIU_TRUSTED_STATE_SCHEMA_VERSION,
    stateKind: input.value.kind,
    command: deepFreezeClone(input.command),
    capabilities: deepFreezeClone(input.capabilities),
    freshness: deepFreezeClone(input.freshness),
    value: deepFreezeClone(input.value),
    unknownFields: deepFreezeClone([...(input.unknownFields ?? [])]),
    diagnostics: deepFreezeClone([...(input.diagnostics ?? [])]),
  });
}

export function getAiuReasonCodeCatalog(): readonly AiuReasonCodeDefinition[] {
  return AIU_REASON_CODE_CATALOG;
}

export function isAiuStateSuccess(value: AiuStateValueKind): boolean {
  return value === "pass";
}

export function isAiuStateNonSuccess(value: AiuStateValueKind): boolean {
  return value !== "pass";
}

function reasonCode(
  code: AiuReasonCode,
  category: AiuReasonCodeCategory,
  decision: AiuContinuationDecisionKind,
  description: string,
): AiuReasonCodeDefinition {
  return Object.freeze({
    code,
    category,
    decision,
    description,
  });
}

function deepFreezeClone<TValue>(value: TValue, seen: WeakMap<object, unknown> = new WeakMap()): TValue {
  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) {
      return cached as TValue;
    }
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) {
      clone.push(deepFreezeClone(item, seen));
    }
    return Object.freeze(clone) as TValue;
  }
  if (isRecord(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) {
      return cached as TValue;
    }
    const clone: Record<string, unknown> = {};
    seen.set(value, clone);
    for (const [key, nested] of Object.entries(value)) {
      clone[key] = deepFreezeClone(nested, seen);
    }
    return Object.freeze(clone) as TValue;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
