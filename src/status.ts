import { AIU_REASON_CODE_CATALOG, createAiuTrustedStateEnvelope, type AiuReasonCodeDefinition, type AiuStateValueKind, type AiuTrustedStateEnvelope } from "./state.js";
import { type AiuConfigLoadResult, loadAiuConfig } from "./config.js";
import { readAiuContinuationState, resolveAiuContinuationPaths, type AiuContinuationState } from "./continuation_store.js";
import { decideAiuContinuation, type AiuContinuationDecision } from "./decision.js";
import { renderAiuContinuationPrompt, type AiuContinuationPrompt } from "./prompt.js";
import {
  runAiuTrustedStateAdapter,
  type AiuTrustedAdapterError,
  type AiuTrustedStateAdapterResult,
  type AiuTrustedCommandExecutionRecord,
  AIU_TRUSTED_ADAPTER_ERROR_CODES,
} from "./trusted_adapter.js";

export const AIU_STATUS_ERROR_CODES = [
  "status-config-invalid",
  "status-trusted-command-failed",
  ...AIU_TRUSTED_ADAPTER_ERROR_CODES,
] as const;

export type AiuStatusErrorCode = (typeof AIU_STATUS_ERROR_CODES)[number];

export interface AiuStatusOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly observedAt?: string;
}

export interface AiuStatusReport {
  readonly config: {
    readonly path: string;
    readonly found: boolean;
    readonly valid: boolean;
    readonly defaultsUsed: boolean;
  };
  readonly inputEnvelopes: readonly AiuTrustedStateEnvelope[];
  readonly adapterRuns: readonly AiuStatusAdapterRun[];
  readonly normalizedStateSummary: AiuStatusStateSummary;
  readonly decision: AiuContinuationDecision;
  readonly prompt: AiuContinuationPrompt;
  readonly paths: AiuStatusPaths;
  readonly continuationState?: AiuContinuationState;
  readonly reasonLabels: readonly AiuReasonCodeDefinition[];
  readonly staleSources: readonly AiuStatusSourceRef[];
  readonly unknownSources: readonly AiuStatusSourceRef[];
  readonly errors: readonly AiuStatusError[];
  readonly warnings: readonly AiuStatusWarning[];
}

export interface AiuStatusPaths {
  readonly stateDir: string;
  readonly lockDir: string;
  readonly logDir: string;
  readonly continuationState: string;
  readonly continuationLock: string;
  readonly continuationLog: string;
}

export interface AiuStatusAdapterRun {
  readonly sourceId: string;
  readonly ok: boolean;
  readonly record: AiuTrustedCommandExecutionRecord;
  readonly error?: AiuTrustedAdapterError;
}

export interface AiuStatusStateSummary {
  readonly sources: readonly AiuStatusSourceSummary[];
  readonly activeWork: readonly AiuStatusWorkSummary[];
  readonly readyWork: readonly AiuStatusWorkSummary[];
  readonly blockedWork: readonly AiuStatusWorkSummary[];
  readonly activeReviews: readonly AiuStatusReviewSummary[];
  readonly planning: readonly AiuStatusPlanningSummary[];
  readonly quality: readonly AiuStatusQualitySummary[];
}

export interface AiuStatusSourceSummary {
  readonly sourceId: string;
  readonly stateKind: string;
  readonly status: AiuStateValueKind;
  readonly freshness: string;
  readonly observedAt: string;
  readonly summary?: string;
}

export interface AiuStatusSourceRef {
  readonly sourceId: string;
  readonly stateKind: string;
  readonly status: AiuStateValueKind;
}

export interface AiuStatusWorkSummary {
  readonly id: string;
  readonly title?: string;
  readonly lifecycle: string;
  readonly status: AiuStateValueKind;
  readonly priority?: string;
}

export interface AiuStatusReviewSummary {
  readonly sourceId: string;
  readonly targetId?: string;
  readonly reviewStatus: string;
  readonly status: AiuStateValueKind;
  readonly unresolvedFeedbackCount?: number;
}

export interface AiuStatusPlanningSummary {
  readonly sourceId: string;
  readonly status: AiuStateValueKind;
  readonly needsPlanning: boolean | "unknown" | "unsupported";
  readonly humanInputRequired: boolean | "unknown";
}

export interface AiuStatusQualitySummary {
  readonly sourceId: string;
  readonly status: AiuStateValueKind;
  readonly ready: boolean | "unknown" | "unsupported";
  readonly lastRunStatus: AiuStateValueKind;
  readonly selectedTarget?: string;
  readonly failingChecks: readonly string[];
  readonly affectedPaths: readonly string[];
  readonly stageCount: number;
  readonly findingCount: number;
  readonly humanApprovalRequired?: boolean | "unknown";
  readonly supplyChainApprovalRequired?: boolean | "unknown";
}

export interface AiuStatusError {
  readonly code: AiuStatusErrorCode;
  readonly message: string;
  readonly sourceId?: string;
  readonly path?: string;
}

export interface AiuStatusWarning {
  readonly code: string;
  readonly message: string;
  readonly sourceId?: string;
  readonly path?: string;
}

export async function runAiuStatus(options: AiuStatusOptions = {}): Promise<AiuStatusReport> {
  const configLoad = loadAiuConfig(resolveConfigOptions(options));
  const adapterResults: AiuTrustedStateAdapterResult[] = [];

  for (const [sourceId, descriptor] of Object.entries(configLoad.config.trustedStateCommands)) {
    adapterResults.push(await runAiuTrustedStateAdapter(sourceId, descriptor, {
      cwd: configLoad.repoRoot,
      observedAt: options.observedAt,
    }));
  }

  return createAiuStatusReport(configLoad, adapterResults);
}

export function createAiuStatusReport(
  configLoad: AiuConfigLoadResult,
  adapterResults: readonly AiuTrustedStateAdapterResult[],
): AiuStatusReport {
  const inputEnvelopes = adapterResults.flatMap((result) => result.ok ? result.states : []);
  const errors = [
    ...configLoad.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => ({
        code: "status-config-invalid" as const,
        message: diagnostic.message,
        path: diagnostic.path,
      })),
    ...adapterResults
      .filter((result): result is Extract<AiuTrustedStateAdapterResult, { readonly ok: false }> => !result.ok)
      .flatMap((result) => [
        {
          code: "status-trusted-command-failed" as const,
          message: `Trusted command ${result.record.sourceId} failed: ${result.error.message}`,
          sourceId: result.record.sourceId,
          ...(result.error.path ? { path: result.error.path } : {}),
        },
        {
          code: result.error.code,
          message: result.error.message,
          sourceId: result.record.sourceId,
          ...(result.error.path ? { path: result.error.path } : {}),
        },
      ]),
  ];
  const adapterErrors = adapterResults.filter((result): result is Extract<AiuTrustedStateAdapterResult, { readonly ok: false }> => !result.ok);
  const warnings = configLoad.diagnostics
    .filter((diagnostic) => diagnostic.severity === "warning")
    .map((diagnostic) => ({
      code: diagnostic.kind,
      message: diagnostic.message,
      path: diagnostic.path,
    }));
  const decisionStates = [...inputEnvelopes, ...adapterErrors.map(adapterFailureEnvelope)];
  const continuationPaths = resolveAiuContinuationPaths(configLoad.repoRoot, configLoad.config);
  const continuationState = readAiuContinuationState(continuationPaths);
  const decision = decideAiuContinuation({
    states: decisionStates,
    policy: {
      modes: configLoad.config.continuation.modes,
      stopOnUnknownState: configLoad.config.continuation.stopOnUnknownState,
      stopOnUnsafeState: configLoad.config.continuation.stopOnUnsafeState,
      stopOnSupplyChainApprovalBlock: configLoad.config.continuation.stopOnSupplyChainApprovalBlock,
      qualityEnabled: configLoad.config.quality.enabled,
      supplyChainApprovalRequired: false,
    },
  });
  const prompt = renderAiuContinuationPrompt({ decision, config: configLoad.config });

  return Object.freeze({
    config: Object.freeze({
      path: configLoad.selectedPath,
      found: configLoad.found,
      valid: configLoad.ok,
      defaultsUsed: configLoad.defaultsUsed,
    }),
    inputEnvelopes: Object.freeze(inputEnvelopes),
    adapterRuns: Object.freeze(adapterResults.map(adapterRun)),
    normalizedStateSummary: summarizeStates(inputEnvelopes),
    decision,
    prompt,
    paths: Object.freeze({
      stateDir: continuationPaths.stateDir,
      lockDir: continuationPaths.lockDir,
      logDir: continuationPaths.logDir,
      continuationState: continuationPaths.statePath,
      continuationLock: continuationPaths.lockPath,
      continuationLog: continuationPaths.logPath,
    }),
    ...(continuationState ? { continuationState } : {}),
    reasonLabels: Object.freeze(decision.reasonCodes.map((code) => AIU_REASON_CODE_CATALOG.find((item) => item.code === code)).filter((item): item is AiuReasonCodeDefinition => item !== undefined)),
    staleSources: Object.freeze(inputEnvelopes.filter((state) => state.freshness.kind === "stale" || state.value.status === "stale").map(sourceRef)),
    unknownSources: Object.freeze(inputEnvelopes.filter((state) => state.value.status === "unknown" || state.unknownFields.length > 0).map(sourceRef)),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  });
}

export function formatAiuStatusReport(report: AiuStatusReport): string {
  const selected = report.decision.selectedItem ? ` ${formatSelectedItem(report.decision.selectedItem)}` : "";
  const sourceLines = report.normalizedStateSummary.sources.map((source) => `- ${source.sourceId}: ${source.stateKind} ${source.status}/${source.freshness} observed ${source.observedAt}`);
  const lines = [
    `decision: ${report.decision.kind}`,
    `mode: ${report.decision.selectedMode}`,
    `prompt: ${report.prompt.kind} ${report.prompt.fingerprint}`,
    `selected: ${selected.trim() || "none"}`,
    `stateDir: ${report.paths.stateDir}`,
    `lockDir: ${report.paths.lockDir}`,
    `logDir: ${report.paths.logDir}`,
    `owner: ${report.continuationState?.ownerSessionId ?? "none"}`,
    `pendingPrompt: ${report.continuationState?.pendingPromptFingerprint ?? "none"}`,
    `reasons: ${report.reasonLabels.map((reason) => `${reason.code} (${reason.description})`).join(", ") || "none"}`,
    `next: ${report.decision.recommendedNextAction}`,
    "",
    "Trusted sources:",
    ...(sourceLines.length > 0 ? sourceLines : ["- none"]),
    "",
    `activeWork: ${report.normalizedStateSummary.activeWork.length}`,
    `activeReviews: ${report.normalizedStateSummary.activeReviews.length}`,
    `planning: ${report.normalizedStateSummary.planning.map((item) => `${item.sourceId} needs=${String(item.needsPlanning)} human=${String(item.humanInputRequired)}`).join(", ") || "none"}`,
    `quality: ${report.normalizedStateSummary.quality.map((item) => `${item.sourceId} ready=${String(item.ready)} last=${item.lastRunStatus} target=${item.selectedTarget ?? "none"}`).join(", ") || "none"}`,
    `errors: ${report.errors.length}`,
    `warnings: ${report.warnings.length}`,
  ];
  return `${lines.join("\n")}\n`;
}

function summarizeStates(states: readonly AiuTrustedStateEnvelope[]): AiuStatusStateSummary {
  return Object.freeze({
    sources: Object.freeze(states.map((state) => ({
      sourceId: state.sourceId,
      stateKind: state.stateKind,
      status: state.value.status,
      freshness: state.freshness.kind,
      observedAt: state.observedAt,
      ...(state.value.summary ? { summary: state.value.summary } : {}),
    }))),
    activeWork: Object.freeze(states.flatMap((state) => state.value.kind === "work-queue" ? state.value.activeItems : state.value.kind === "work-item" && state.value.lifecycle === "active" ? [state.value] : []).map(workSummary)),
    readyWork: Object.freeze(states.flatMap((state) => state.value.kind === "work-queue" ? state.value.readyItems : state.value.kind === "work-item" && state.value.lifecycle === "ready" ? [state.value] : []).map(workSummary)),
    blockedWork: Object.freeze(states.flatMap((state) => state.value.kind === "work-queue" ? state.value.blockedItems : state.value.kind === "work-item" && state.value.lifecycle === "blocked" ? [state.value] : []).map(workSummary)),
    activeReviews: Object.freeze(states.flatMap((state) => {
      const value = state.value;
      if (value.kind !== "review" || (value.reviewStatus !== "active" && value.reviewStatus !== "changes-requested")) return [];
      return [{
        sourceId: state.sourceId,
        ...(value.targetId ? { targetId: value.targetId } : {}),
        reviewStatus: value.reviewStatus,
        status: value.status,
        ...(value.unresolvedFeedbackCount !== undefined ? { unresolvedFeedbackCount: value.unresolvedFeedbackCount } : {}),
      }];
    })),
    planning: Object.freeze(states.flatMap((state) => {
      const value = state.value;
      if (value.kind !== "planning") return [];
      return [{
        sourceId: state.sourceId,
        status: value.status,
        needsPlanning: value.needsPlanning,
        humanInputRequired: value.humanInputRequired,
      }];
    })),
    quality: Object.freeze(states.flatMap((state) => {
      const value = state.value;
      if (value.kind !== "quality") return [];
      return [{
        sourceId: state.sourceId,
        status: value.status,
        ready: value.ready,
        lastRunStatus: value.lastRunStatus,
        ...(value.selectedTarget ? { selectedTarget: `${value.selectedTarget.kind}:${value.selectedTarget.id}` } : {}),
        failingChecks: Object.freeze([...value.failingChecks]),
        affectedPaths: Object.freeze([...value.affectedPaths]),
        stageCount: value.stages.length,
        findingCount: value.findings.length,
        ...(value.humanApprovalRequired !== undefined ? { humanApprovalRequired: value.humanApprovalRequired } : {}),
        ...(value.supplyChainApprovalRequired !== undefined ? { supplyChainApprovalRequired: value.supplyChainApprovalRequired } : {}),
      }];
    })),
  });
}

function adapterRun(result: AiuTrustedStateAdapterResult): AiuStatusAdapterRun {
  return Object.freeze({
    sourceId: result.record.sourceId,
    ok: result.ok,
    record: result.record,
    ...(!result.ok ? { error: result.error } : {}),
  });
}

function adapterFailureEnvelope(result: Extract<AiuTrustedStateAdapterResult, { readonly ok: false }>): AiuTrustedStateEnvelope {
  return createAiuTrustedStateEnvelope({
    sourceId: result.record.sourceId,
    command: result.record.command,
    observedAt: new Date(0).toISOString(),
    trustLevel: "trusted",
    capabilities: {},
    freshness: {
      kind: "fresh",
      observedAt: new Date(0).toISOString(),
    },
    value: {
      kind: "continuation-policy",
      status: "malformed",
      summary: result.error.message,
      allowedModes: ["continue", "repair", "wait", "stop"],
      stopOnUnknownState: true,
      stopOnStaleState: true,
      stopOnSupplyChainApprovalBlock: true,
      allowProviderMutation: false,
      allowBackgroundScheduling: false,
    },
    diagnostics: [{
      severity: "error",
      kind: "malformed",
      path: result.error.path ?? "$",
      message: result.error.message,
      reasonCode: "stop-malformed-input",
    }],
  });
}

function workSummary(item: { readonly id: string; readonly title?: string; readonly lifecycle: string; readonly status: AiuStateValueKind; readonly priority?: string }): AiuStatusWorkSummary {
  return Object.freeze({
    id: item.id,
    ...(item.title ? { title: item.title } : {}),
    lifecycle: item.lifecycle,
    status: item.status,
    ...(item.priority ? { priority: item.priority } : {}),
  });
}

function sourceRef(state: AiuTrustedStateEnvelope): AiuStatusSourceRef {
  return Object.freeze({
    sourceId: state.sourceId,
    stateKind: state.stateKind,
    status: state.value.status,
  });
}

function formatSelectedItem(item: AiuContinuationDecision["selectedItem"]): string {
  if (!item) return "none";
  return [item.kind, item.id ?? item.sourceId, item.status].filter(Boolean).join(":");
}

function resolveConfigOptions(options: AiuStatusOptions) {
  return options.configPath ? { cwd: options.cwd, configPath: options.configPath } : { cwd: options.cwd };
}
