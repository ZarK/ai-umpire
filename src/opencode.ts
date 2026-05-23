import { loadAiuConfig, type AiuConfig } from "./config.js";
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
  const { states, adapterErrors } = await collectTrustedStates(event, normalizedContext, host.state);
  const decision = decideAiuContinuation({
    states,
    policy: {
      modes: normalizedContext.config?.continuation.modes,
      stopOnUnknownState: normalizedContext.config?.continuation.stopOnUnknownState,
      stopOnUnsafeState: normalizedContext.config?.continuation.stopOnUnsafeState,
      stopOnSupplyChainApprovalBlock: normalizedContext.config?.continuation.stopOnSupplyChainApprovalBlock,
      cooldownActive: isCooldownActive(normalizedContext),
    },
  });
  const suppressions = [...host.suppressions, ...decisionSuppressions(decision), ...hostPolicySuppressions(normalizedContext.config, decision.kind)];
  if (suppressions.length > 0 || (decision.kind !== "continue" && decision.kind !== "repair")) {
    return Object.freeze({
      handled: true,
      decision,
      metadata: resultMetadata(event, host, states.length, adapterErrors, suppressions),
    });
  }

  const prompt = renderAiuContinuationPrompt({ decision, config: normalizedContext.config });
  const delivery = await deliverAiuOpenCodePrompt(prompt, event, normalizedContext);
  return Object.freeze({
    handled: true,
    decision,
    prompt,
    delivery,
    metadata: resultMetadata(event, host, states.length, adapterErrors, delivery.delivered ? suppressions : [...suppressions, delivery.reason ?? "prompt-delivery-failed"]),
  });
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

function withDefaultContext(context: AiuOpenCodeContext): AiuOpenCodeContext {
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
  context: AiuOpenCodeContext,
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

function isCooldownActive(context: AiuOpenCodeContext): boolean {
  if (!context.lastPromptAt || !context.config) {
    return false;
  }
  const lastPrompt = Date.parse(context.lastPromptAt);
  const observedAt = Date.parse(context.observedAt ?? new Date().toISOString());
  return Number.isFinite(lastPrompt) && Number.isFinite(observedAt) && observedAt - lastPrompt < context.config.cooldowns.promptMs;
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
): AiuOpenCodeResultMetadata {
  return Object.freeze({
    eventType: event.type,
    ...(host.state.sessionId ? { sessionId: host.state.sessionId } : {}),
    ...(host.state.selectedSessionId ? { selectedSessionId: host.state.selectedSessionId } : {}),
    suppressions: Object.freeze([...new Set(suppressions)]),
    trustedStateCount,
    adapterErrors: Object.freeze([...adapterErrors]),
  });
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
