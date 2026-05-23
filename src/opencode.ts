import { loadAiuConfig, type AiuConfig } from "./config.js";
import {
  acquireAiuContinuationLock,
  appendAiuContinuationLog,
  buildAiuContinuationState,
  continuationPromptIsDuplicate,
  continuationPromptOwnedByOtherSession,
  continuationPromptTargetsSameItem,
  createAiuDecisionId,
  persistedLastPromptAt,
  readAiuContinuationState,
  releaseAiuContinuationLock,
  resolveAiuContinuationPaths,
  writeAiuContinuationState,
  type AiuContinuationPaths,
  type AiuContinuationState,
} from "./continuation_store.js";
import { decideAiuContinuation, type AiuContinuationDecision } from "./decision.js";
import { renderAiuContinuationPrompt, type AiuContinuationPrompt } from "./prompt.js";
import {
  createAiuTrustedStateEnvelope,
  type AiuHostSessionState,
  type AiuTrustedStateEnvelope,
  type AiuWorkQueueState,
} from "./state.js";
import { runAiuTrustedStateAdapter } from "./trusted_adapter.js";

export interface AiuOpenCodeEvent {
  readonly type: string;
  readonly payload?: unknown;
}

export interface AiuOpenCodeContext {
  readonly cwd?: string;
  readonly config?: AiuConfig;
  readonly observedAt?: string;
  readonly lastPromptAt?: string;
  readonly trustedStates?: readonly AiuTrustedStateEnvelope[];
  readonly loadTrustedStates?: AiuOpenCodeTrustedStateLoader;
  readonly deliverPrompt?: AiuOpenCodePromptDeliverer;
  readonly previousResult?: AiuOpenCodeHandlerResult;
}

export interface AiuOpenCodeHandlerResult {
  readonly handled: boolean;
  readonly decision?: AiuContinuationDecision;
  readonly prompt?: AiuContinuationPrompt;
  readonly delivery?: AiuOpenCodePromptDelivery;
  readonly metadata?: AiuOpenCodeResultMetadata;
}

export interface AiuOpenCodeResultMetadata extends Readonly<Record<string, unknown>> {
  readonly eventType?: string;
  readonly sessionId?: string;
  readonly selectedSessionId?: string;
  readonly suppressions?: readonly string[];
  readonly trustedStateCount?: number;
  readonly adapterErrors?: readonly string[];
  readonly decisionId?: string;
  readonly promptFingerprint?: string;
  readonly statePath?: string;
  readonly lockPath?: string;
  readonly logPath?: string;
  readonly staleLockRecovered?: boolean;
}

export interface AiuOpenCodePromptDelivery {
  readonly delivered: boolean;
  readonly reason?: string;
  readonly targetSessionId?: string;
}

export type AiuOpenCodePromptDeliverer = (
  prompt: AiuContinuationPrompt,
  event: AiuOpenCodeEvent,
  context: AiuOpenCodeContext,
) => AiuOpenCodePromptDelivery | Promise<AiuOpenCodePromptDelivery>;

export type AiuOpenCodeTrustedStateLoader = (
  event: AiuOpenCodeEvent,
  context: AiuOpenCodeContext,
) => readonly AiuTrustedStateEnvelope[] | Promise<readonly AiuTrustedStateEnvelope[]>;

export interface AiuOpenCodeHostSessionSnapshot {
  readonly state: AiuHostSessionState;
  readonly suppressions: readonly string[];
}

export type AiuOpenCodeNext = () => Promise<AiuOpenCodeHandlerResult>;
export type AiuOpenCodeHandler = (event: AiuOpenCodeEvent, context: AiuOpenCodeContext, next: AiuOpenCodeNext) => AiuOpenCodeHandlerResult | Promise<AiuOpenCodeHandlerResult>;
type AiuOpenCodeResolvedContext = AiuOpenCodeContext & { readonly config: AiuConfig };

export interface AiuOpenCodePlugin {
  readonly name: "@tjalve/aiu/opencode";
  readonly handle: (event: AiuOpenCodeEvent, context?: AiuOpenCodeContext) => Promise<AiuOpenCodeHandlerResult>;
}

export interface AiuOpenCodePluginOptions {
  readonly before?: readonly AiuOpenCodeHandler[];
  readonly after?: readonly AiuOpenCodeHandler[];
  readonly loadTrustedStates?: AiuOpenCodeTrustedStateLoader;
  readonly deliverPrompt?: AiuOpenCodePromptDeliverer;
}

const AIU_OPENCODE_RELEVANT_EVENTS = new Set([
  "idle",
  "session-idle",
  "session-status",
  "todo-update",
  "message-update",
  "tui-prompt-activity",
  "selected-session",
]);

export function createAiuOpenCodePlugin(options: AiuOpenCodePluginOptions = {}): AiuOpenCodePlugin {
  const before = composeAiuOpenCodeHandlers(options.before ?? []);
  const after = composeAiuOpenCodeHandlers(options.after ?? []);
  return Object.freeze({
    name: "@tjalve/aiu/opencode" as const,
    handle: async (event: AiuOpenCodeEvent, context: AiuOpenCodeContext = {}) => {
      const normalizedContext = withDefaultContext({
        ...context,
        ...(options.loadTrustedStates && !context.loadTrustedStates ? { loadTrustedStates: options.loadTrustedStates } : {}),
        ...(options.deliverPrompt && !context.deliverPrompt ? { deliverPrompt: options.deliverPrompt } : {}),
      });
      const result = await before(event, normalizedContext, async () => runAiuOpenCodeContinuation(event, normalizedContext));
      return after(event, Object.freeze({ ...normalizedContext, previousResult: result }), async () => result);
    },
  });
}

export async function runAiuOpenCodeContinuation(event: AiuOpenCodeEvent, context: AiuOpenCodeContext = {}): Promise<AiuOpenCodeHandlerResult> {
  const normalizedContext = withDefaultContext(context);
  const observedAt = normalizedContext.observedAt ?? new Date().toISOString();
  if (!isRelevantOpenCodeEvent(event.type)) {
    return Object.freeze({
      handled: false,
      metadata: Object.freeze({
        eventType: event.type,
        suppressions: Object.freeze(["unsupported-event"]),
        trustedStateCount: 0,
      }),
    });
  }

  const host = buildAiuOpenCodeHostSession(event);
  const paths = resolveAiuContinuationPaths(normalizedContext.cwd ?? process.cwd(), normalizedContext.config);
  let lock;
  try {
    lock = acquireAiuContinuationLock({
      paths,
      observedAt,
      eventType: event.type,
      ...(host.state.sessionId ? { sessionId: host.state.sessionId } : {}),
      staleAfterMs: lockStaleAfterMs(normalizedContext.config),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      handled: true,
      metadata: resultMetadata(event, host, 0, [`continuation-lock: ${message}`], ["continuation-lock-unavailable"], paths),
    });
  }
  if (!lock.acquired) {
    safeAppendContinuationLog(paths, {
      event: "lock-contended",
      observedAt,
      eventType: event.type,
      hostId: "opencode",
      ...(host.state.sessionId ? { sessionId: host.state.sessionId } : {}),
      ...(host.state.selectedSessionId ? { selectedSessionId: host.state.selectedSessionId } : {}),
      suppressions: ["lock-held"],
      message: lock.lock ? `Lock held since ${lock.lock.acquiredAt}.` : "Lock held.",
    });
    return Object.freeze({
      handled: true,
      metadata: resultMetadata(event, host, 0, [], ["lock-held"], paths),
    });
  }

  const start = Date.now();
  try {
    const persisted = readAiuContinuationState(paths);
    if (lock.staleRecovered) {
      safeAppendContinuationLog(paths, {
        event: "stale-lock-recovered",
        observedAt,
        eventType: event.type,
        hostId: "opencode",
        ...(host.state.sessionId ? { sessionId: host.state.sessionId } : {}),
        ...(lock.staleLock ? { message: `Recovered stale lock ${lock.staleLock.ownerId} acquired at ${lock.staleLock.acquiredAt}.` } : {}),
      });
    }
    const { states, adapterErrors } = await collectTrustedStates(event, normalizedContext, host.state);
    const decision = decideAiuContinuation({
      states,
      policy: {
        modes: normalizedContext.config.continuation.modes,
        stopOnUnknownState: normalizedContext.config.continuation.stopOnUnknownState,
        stopOnUnsafeState: normalizedContext.config.continuation.stopOnUnsafeState,
        stopOnSupplyChainApprovalBlock: normalizedContext.config.continuation.stopOnSupplyChainApprovalBlock,
        planningEnabled: normalizedContext.config.planning.enabled,
        qualityEnabled: normalizedContext.config.quality.enabled,
        cooldownActive: isCooldownActive(normalizedContext, persisted),
      },
    });
    const baseSuppressions = [...host.suppressions, ...decisionSuppressions(decision), ...hostPolicySuppressions(normalizedContext.config, decision.kind)];
    if (baseSuppressions.length > 0 || (decision.kind !== "continue" && decision.kind !== "repair")) {
      const logged = safeLogDecision(paths, {
        event,
        host,
        decision,
        observedAt,
        adapterErrors,
        suppressions: baseSuppressions,
        elapsedMs: Date.now() - start,
      });
      const metadataSuppressions = logged ? baseSuppressions : [...baseSuppressions, "continuation-log-write-failed"];
      return Object.freeze({
        handled: true,
        decision,
        metadata: resultMetadata(event, host, states.length, adapterErrors, metadataSuppressions, paths, persisted, {
          decisionId: createAiuDecisionId({ observedAt, eventType: event.type, sessionId: host.state.sessionId, reasonCodes: decision.reasonCodes }),
          staleLockRecovered: lock.staleRecovered,
        }),
      });
    }

    const prompt = renderAiuContinuationPrompt({ decision, config: normalizedContext.config });
    const promptSuppressions = promptPersistenceSuppressions(persisted, prompt, host.state.sessionId);
    if (promptSuppressions.length > 0) {
      const logged = safeLogDecision(paths, {
        event,
        host,
        decision,
        prompt,
        observedAt,
        adapterErrors,
        suppressions: promptSuppressions,
        elapsedMs: Date.now() - start,
      });
      const metadataSuppressions = logged ? promptSuppressions : [...promptSuppressions, "continuation-log-write-failed"];
      return Object.freeze({
        handled: true,
        decision,
        prompt,
        metadata: resultMetadata(event, host, states.length, adapterErrors, metadataSuppressions, paths, persisted, {
          decisionId: createAiuDecisionId({ observedAt, eventType: event.type, sessionId: host.state.sessionId, promptFingerprint: prompt.fingerprint, reasonCodes: decision.reasonCodes }),
          promptFingerprint: prompt.fingerprint,
          staleLockRecovered: lock.staleRecovered,
        }),
      });
    }

    const delivery = await deliverAiuOpenCodePrompt(prompt, event, normalizedContext);
    const suppressions = delivery.delivered ? [...baseSuppressions] : [...baseSuppressions, delivery.reason ?? "prompt-delivery-failed"];
    if (delivery.delivered) {
      try {
        writeAiuContinuationState(paths, buildAiuContinuationState({
          observedAt,
          ...(host.state.sessionId ? { ownerSessionId: host.state.sessionId } : {}),
          ...(delivery.targetSessionId ?? host.state.selectedSessionId ? { targetSessionId: delivery.targetSessionId ?? host.state.selectedSessionId } : {}),
          decision,
          prompt,
        }));
      } catch {
        suppressions.push("continuation-state-write-failed");
      }
    }
    const logged = safeLogDecision(paths, {
      event,
      host,
      decision,
      prompt,
      delivery,
      observedAt,
      adapterErrors,
      suppressions,
      elapsedMs: Date.now() - start,
    });
    if (!logged) {
      suppressions.push("continuation-log-write-failed");
    }
    return Object.freeze({
      handled: true,
      decision,
      prompt,
      delivery,
      metadata: resultMetadata(event, host, states.length, adapterErrors, suppressions, paths, persisted, {
        decisionId: createAiuDecisionId({ observedAt, eventType: event.type, sessionId: host.state.sessionId, promptFingerprint: prompt.fingerprint, reasonCodes: decision.reasonCodes }),
        promptFingerprint: prompt.fingerprint,
        staleLockRecovered: lock.staleRecovered,
      }),
    });
  } finally {
    releaseAiuContinuationLock(paths, lock);
  }
}

export function composeAiuOpenCodeHandlers(handlers: readonly AiuOpenCodeHandler[]): AiuOpenCodeHandler {
  return async (event, context, next) => {
    let index = -1;
    async function dispatch(position: number): Promise<AiuOpenCodeHandlerResult> {
      if (position <= index) {
        throw new Error("OpenCode handler next() was called more than once.");
      }
      index = position;
      const handler = handlers[position];
      return handler === undefined ? next() : handler(event, context, () => dispatch(position + 1));
    }
    return dispatch(0);
  };
}

function withDefaultContext(context: AiuOpenCodeContext): AiuOpenCodeResolvedContext {
  const config = context.config ?? loadAiuConfig({ cwd: context.cwd }).config;
  return Object.freeze({
    ...context,
    config,
  });
}

function isRelevantOpenCodeEvent(type: string): boolean {
  const normalized = normalizeEventToken(type);
  return AIU_OPENCODE_RELEVANT_EVENTS.has(normalized)
    || normalized.includes("idle")
    || normalized.includes("todo")
    || normalized.includes("message")
    || normalized.includes("status")
    || normalized.includes("selected")
    || normalized.includes("tui");
}

function buildAiuOpenCodeHostSession(event: AiuOpenCodeEvent): AiuOpenCodeHostSessionSnapshot {
  const payload = isRecord(event.payload) ? event.payload : {};
  const session = isRecord(payload.session) ? payload.session : {};
  const selectedSession = isRecord(payload.selectedSession) ? payload.selectedSession : {};
  const sessionId = readString(payload.sessionId) ?? readString(session.id) ?? readString(payload.id);
  const selectedSessionId = readString(payload.selectedSessionId) ?? readString(selectedSession.id) ?? readString(payload.currentSessionId);
  const suppressions: string[] = [];
  const eventType = normalizeEventToken(event.type);
  const helperRole = readString(session.role);
  const helperSession = readBoolean(payload.helperSession) ?? readBoolean(payload.isHelperSession) ?? readBoolean(session.helper) ?? (helperRole ? helperRole === "helper" : undefined);
  const userActive = readBoolean(payload.userActive) ?? readBoolean(payload.typing) ?? readBoolean(payload.tuiActive) ?? (eventType.includes("tui") ? true : undefined);
  const todoActive = readBoolean(payload.todoActive) ?? (eventType.includes("todo") ? readBoolean(payload.active) ?? true : undefined);
  const busy = readBoolean(payload.busy) ?? readBoolean(payload.isBusy) ?? statusIsBusy(readString(payload.status) ?? readString(session.status)) ?? (eventType.includes("message") ? true : undefined);
  const selectedConflict = sessionId !== undefined && selectedSessionId !== undefined && sessionId !== selectedSessionId;

  if (helperSession) suppressions.push("helper-session");
  if (busy) suppressions.push("session-busy");
  if (selectedConflict) suppressions.push("selected-session-conflict");
  if (userActive) suppressions.push("user-active");
  if (todoActive) suppressions.push("todo-active");

  const canPrompt = suppressions.length === 0;
  const state: AiuHostSessionState = Object.freeze({
    kind: "host-session",
    status: "pass",
    hostId: "opencode",
    ...(sessionId ? { sessionId } : {}),
    ...(selectedSessionId ? { selectedSessionId } : {}),
    helperSession,
    userActive,
    todoActive,
    sessionStatus: canPrompt ? "idle" : "busy",
    canPrompt,
  });

  return Object.freeze({
    state,
    suppressions: Object.freeze(suppressions),
  });
}

async function collectTrustedStates(
  event: AiuOpenCodeEvent,
  context: AiuOpenCodeResolvedContext,
  hostState: AiuHostSessionState,
): Promise<{ readonly states: readonly AiuTrustedStateEnvelope[]; readonly adapterErrors: readonly string[] }> {
  const observedAt = context.observedAt ?? new Date().toISOString();
  const states: AiuTrustedStateEnvelope[] = [
    createAiuTrustedStateEnvelope({
      sourceId: "opencode",
      command: { id: "opencode", argv: ["opencode"] },
      observedAt,
      trustLevel: "trusted",
      capabilities: {
        sessionState: "supported",
        selectedSession: hostState.selectedSessionId ? "supported" : "unknown",
        userActivity: hostState.userActive === undefined ? "unknown" : "supported",
        todoRead: hostState.todoActive === undefined ? "unknown" : "supported",
      },
      freshness: { kind: "fresh", observedAt },
      value: hostState,
    }),
  ];
  const adapterErrors: string[] = [];

  if (context.trustedStates) {
    states.push(...context.trustedStates);
  }
  if (context.loadTrustedStates) {
    try {
      states.push(...await context.loadTrustedStates(event, context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      adapterErrors.push(`opencode-loader: ${message}`);
      states.push(adapterErrorEnvelope("opencode-loader", message, observedAt));
    }
  }

  for (const [sourceId, descriptor] of Object.entries(context.config?.trustedStateCommands ?? {})) {
    const result = await runAiuTrustedStateAdapter(sourceId, descriptor, {
      cwd: context.cwd,
      timeoutMs: context.config?.timeouts.commandMs,
      observedAt,
    });
    if (result.ok) {
      states.push(...result.states);
    } else {
      adapterErrors.push(`${sourceId}: ${result.error.message}`);
      states.push(adapterErrorEnvelope(sourceId, result.error.message, observedAt));
    }
  }

  return Object.freeze({ states: Object.freeze(states), adapterErrors: Object.freeze(adapterErrors) });
}

function decisionSuppressions(decision: AiuContinuationDecision): readonly string[] {
  return decision.kind === "wait" || decision.kind === "stop" ? decision.reasonCodes : [];
}

function adapterErrorEnvelope(sourceId: string, message: string, observedAt: string): AiuTrustedStateEnvelope<AiuWorkQueueState> {
  return createAiuTrustedStateEnvelope({
    sourceId,
    command: { id: sourceId, argv: ["trusted-state-adapter"] },
    observedAt,
    trustLevel: "trusted",
    capabilities: {},
    freshness: { kind: "fresh", observedAt },
    value: {
      kind: "work-queue",
      status: "malformed",
      summary: message,
      activeItems: [],
      readyItems: [],
      blockedItems: [],
      unknownItems: [],
    },
    diagnostics: [
      {
        severity: "error",
        kind: "malformed",
        path: "$",
        message,
        reasonCode: "stop-malformed-input",
      },
    ],
  });
}

function hostPolicySuppressions(config: AiuConfig | undefined, decisionKind: AiuContinuationDecision["kind"]): readonly string[] {
  if (!config?.hosts.enabled.includes("opencode")) {
    return Object.freeze(["host-disabled"]);
  }
  const allowedModes = config.hosts.modes.opencode ?? config.continuation.modes;
  if (!allowedModes.includes(decisionKind)) {
    return Object.freeze(["host-mode-disabled"]);
  }
  const promptDelivery = config.hosts.capabilities.opencode?.promptDelivery;
  if (promptDelivery === false || promptDelivery === "none") {
    return Object.freeze(["prompt-delivery-disabled"]);
  }
  return Object.freeze([]);
}

function isCooldownActive(context: AiuOpenCodeResolvedContext, persisted: AiuContinuationState | undefined): boolean {
  const lastPromptAt = context.lastPromptAt ?? persistedLastPromptAt(persisted);
  if (!lastPromptAt) {
    return false;
  }
  const lastPrompt = Date.parse(lastPromptAt);
  const observedAt = Date.parse(context.observedAt ?? new Date().toISOString());
  return Number.isFinite(lastPrompt) && Number.isFinite(observedAt) && observedAt - lastPrompt < context.config.cooldowns.promptMs;
}

function lockStaleAfterMs(config: AiuConfig): number {
  return Math.max(config.timeouts.hostMs, 60_000);
}

async function deliverAiuOpenCodePrompt(
  prompt: AiuContinuationPrompt,
  event: AiuOpenCodeEvent,
  context: AiuOpenCodeContext,
): Promise<AiuOpenCodePromptDelivery> {
  if (!context.deliverPrompt) {
    return Object.freeze({ delivered: false, reason: "no-prompt-deliverer" });
  }
  try {
    const result = await context.deliverPrompt(prompt, event, context);
    return normalizeDeliveryResult(result);
  } catch (error) {
    return Object.freeze({
      delivered: false,
      reason: `prompt-delivery-error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function normalizeDeliveryResult(result: unknown): AiuOpenCodePromptDelivery {
  const value = isRecord(result) ? result : {};
  return Object.freeze({
    delivered: value.delivered === true,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.targetSessionId === "string" ? { targetSessionId: value.targetSessionId } : {}),
  });
}

function resultMetadata(
  event: AiuOpenCodeEvent,
  host: AiuOpenCodeHostSessionSnapshot,
  trustedStateCount: number,
  adapterErrors: readonly string[],
  suppressions: readonly string[],
  paths?: AiuContinuationPaths,
  _persisted?: AiuContinuationState,
  extras: Partial<AiuOpenCodeResultMetadata> = {},
): AiuOpenCodeResultMetadata {
  return Object.freeze({
    eventType: event.type,
    ...(host.state.sessionId ? { sessionId: host.state.sessionId } : {}),
    ...(host.state.selectedSessionId ? { selectedSessionId: host.state.selectedSessionId } : {}),
    suppressions: Object.freeze([...new Set(suppressions)]),
    trustedStateCount,
    adapterErrors: Object.freeze([...adapterErrors]),
    ...(paths ? { statePath: paths.statePath, lockPath: paths.lockPath, logPath: paths.logPath } : {}),
    ...extras,
  });
}

function promptPersistenceSuppressions(
  persisted: AiuContinuationState | undefined,
  prompt: AiuContinuationPrompt,
  sessionId: string | undefined,
): readonly string[] {
  const suppressions: string[] = [];
  if (continuationPromptOwnedByOtherSession(persisted, sessionId)) {
    suppressions.push("prompt-owned-by-other-session");
  }
  if (continuationPromptIsDuplicate(persisted, prompt)) {
    suppressions.push("duplicate-prompt-fingerprint");
  }
  if (continuationPromptTargetsSameItem(persisted, prompt)) {
    suppressions.push("duplicate-prompt-target");
  }
  return Object.freeze(suppressions);
}

function safeLogDecision(paths: AiuContinuationPaths, input: {
  readonly event: AiuOpenCodeEvent;
  readonly host: AiuOpenCodeHostSessionSnapshot;
  readonly decision: AiuContinuationDecision;
  readonly prompt?: AiuContinuationPrompt;
  readonly delivery?: AiuOpenCodePromptDelivery;
  readonly observedAt: string;
  readonly adapterErrors: readonly string[];
  readonly suppressions: readonly string[];
  readonly elapsedMs: number;
}): boolean {
  return safeAppendContinuationLog(paths, {
    event: "decision",
    observedAt: input.observedAt,
    eventType: input.event.type,
    hostId: "opencode",
    ...(input.host.state.sessionId ? { sessionId: input.host.state.sessionId } : {}),
    ...(input.host.state.selectedSessionId ? { selectedSessionId: input.host.state.selectedSessionId } : {}),
    decisionId: createAiuDecisionId({
      observedAt: input.observedAt,
      eventType: input.event.type,
      sessionId: input.host.state.sessionId,
      promptFingerprint: input.prompt?.fingerprint,
      reasonCodes: input.decision.reasonCodes,
    }),
    decisionKind: input.decision.kind,
    mode: input.decision.selectedMode,
    reasonCodes: input.decision.reasonCodes,
    ...(input.prompt ? { promptFingerprint: input.prompt.fingerprint } : {}),
    ...(input.delivery?.targetSessionId ? { targetSessionId: input.delivery.targetSessionId } : {}),
    sourceSummaries: input.decision.sourceSummaries,
    adapterErrors: input.adapterErrors,
    suppressions: input.suppressions,
    elapsedMs: input.elapsedMs,
  });
}

function safeAppendContinuationLog(paths: AiuContinuationPaths, entry: Parameters<typeof appendAiuContinuationLog>[1]): boolean {
  try {
    appendAiuContinuationLog(paths, entry);
    return true;
  } catch {
    return false;
  }
}

function statusIsBusy(status: string | undefined): boolean | undefined {
  if (!status) return undefined;
  const normalized = normalizeEventToken(status);
  if (["busy", "running", "working", "typing"].includes(normalized)) return true;
  if (["idle", "waiting", "stopped"].includes(normalized)) return false;
  return undefined;
}

function normalizeEventToken(value: string): string {
  return value.trim().replace(/([a-z])([A-Z])/g, "$1-$2").replace(/[_\s:]+/g, "-").toLowerCase();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
