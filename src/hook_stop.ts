import type { AiuConfig, AiuHost } from "./config.js";
import { loadAiuConfig } from "./config.js";
import { decideAiuContinuation, type AiuContinuationDecision } from "./decision.js";
import { renderAiuContinuationPrompt, type AiuContinuationPrompt } from "./prompt.js";
import { createAiuTrustedStateEnvelope, type AiuHostSessionState, type AiuTrustedStateEnvelope } from "./state.js";
import { runAiuTrustedStateAdapter, type AiuTrustedStateAdapterResult } from "./trusted_adapter.js";
import { decideAiuWhipContinuation, readAiuWhipState } from "./whip.js";

export interface AiuHookStopOptions {
  readonly tool: Extract<AiuHost, "codex" | "claude-code">;
  readonly stdin?: string;
  readonly cwd?: string;
  readonly configPath?: string;
  readonly observedAt?: string;
}

export interface AiuHookStopResult {
  readonly tool: AiuHookStopOptions["tool"];
  readonly decision: "allow" | "block";
  readonly reason: string;
  readonly inputBytes: number;
  readonly stdoutJson: AiuHookStopStdoutJson;
  readonly stderr: string;
  readonly diagnostics: readonly AiuHookStopDiagnostic[];
  readonly continuationDecision?: AiuContinuationDecision;
  readonly prompt?: AiuContinuationPrompt;
}

export type AiuHookStopStdoutJson = Readonly<Record<string, never>> | Readonly<{ decision: "block"; reason: string }>;

export interface AiuHookStopDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
}

interface HookPayload {
  readonly cwd?: string;
  readonly hook_event_name?: string;
  readonly session_id?: string;
  readonly stop_hook_active?: boolean;
  readonly transcript_path?: string | null;
  readonly turn_id?: string;
  readonly permission_mode?: string;
  readonly model?: string;
  readonly last_assistant_message?: string | null;
}

const MAX_DIAGNOSTIC_LENGTH = 240;
const MAX_DIAGNOSTIC_LINES = 8;

export async function runAiuHookStop(options: AiuHookStopOptions): Promise<AiuHookStopResult> {
  const stdin = options.stdin ?? "";
  const inputBytes = Buffer.byteLength(stdin, "utf8");
  const observedAt = options.observedAt ?? new Date().toISOString();
  const parsed = parseHookPayload(stdin);
  if (!parsed.ok) {
    return allow(options, inputBytes, parsed.code, [
      diagnostic("warning", parsed.code, parsed.error),
    ]);
  }

  if (parsed.payload.stop_hook_active === true) {
    return allow(options, inputBytes, "stop-hook-already-active", [
      diagnostic("info", "stop-hook-already-active", "Host reported that a stop hook continuation is already active."),
    ]);
  }

  const cwd = parsed.payload.cwd ?? options.cwd;
  const configLoad = loadAiuConfig(options.configPath ? { cwd, configPath: options.configPath } : { cwd });
  const policyBlocker = stopHookPolicyBlocker(configLoad.config, options.tool);
  const configDiagnostics = configLoad.diagnostics.map((item) => diagnostic(item.severity, item.kind, item.message));
  if (!configLoad.ok) {
    return allow(options, inputBytes, "config-invalid", configDiagnostics);
  }
  if (policyBlocker) {
    return allow(options, inputBytes, policyBlocker, [diagnostic("info", policyBlocker, policyBlockerMessage(policyBlocker, options.tool))]);
  }

  const adapterResults = await Promise.all(Object.entries(configLoad.config.trustedStateCommands).map(([sourceId, descriptor]) => runAiuTrustedStateAdapter(sourceId, descriptor, {
      cwd: configLoad.repoRoot,
      timeoutMs: configLoad.config.timeouts.commandMs,
      observedAt,
    })));
  const warningDiagnostics = [
    ...configDiagnostics.filter((item) => item.severity !== "error"),
    ...adapterResults.flatMap(adapterDiagnostics),
  ];
  if (adapterResults.length === 0) {
    return allow(options, inputBytes, "trusted-state-unavailable", [
      ...warningDiagnostics,
      diagnostic("warning", "trusted-state-unavailable", "No trusted state commands are configured for stop-hook decisions."),
    ]);
  }

  const adapterFailures = adapterResults.filter((result): result is Extract<AiuTrustedStateAdapterResult, { readonly ok: false }> => !result.ok);
  if (adapterFailures.length > 0) {
    return allow(
      options,
      inputBytes,
      "trusted-state-load-failed",
      [
        ...warningDiagnostics,
        ...adapterFailures.map((result) => diagnostic("error", result.error.code, `Trusted command ${result.record.sourceId} failed: ${result.error.message}`)),
      ],
    );
  }

  const states = [
    ...adapterResults.flatMap((result) => result.ok ? result.states : []),
    hostSessionEnvelope(options.tool, parsed.payload, observedAt),
  ];
  const diagnostics = [
    ...warningDiagnostics,
    ...states.flatMap(stateDiagnostics),
  ];
  const whipRead = readAiuWhipState(configLoad.repoRoot, configLoad.config);
  const whipDecision = decideAiuWhipContinuation({
    config: configLoad.config,
    state: whipRead.state,
  });
  const decision = decideAiuContinuation({
    states,
    policy: {
      modes: configLoad.config.continuation.modes,
      stopOnUnknownState: configLoad.config.continuation.stopOnUnknownState,
      stopOnUnsafeState: configLoad.config.continuation.stopOnUnsafeState,
      stopOnSupplyChainApprovalBlock: configLoad.config.continuation.stopOnSupplyChainApprovalBlock,
      planningEnabled: configLoad.config.planning.enabled,
      qualityEnabled: configLoad.config.quality.enabled,
      supplyChainApprovalRequired: configLoad.config.supplyChain.stopOnApprovalRequired === true && hasSupplyChainApprovalBlock(states),
    },
    ...(whipDecision.enqueuesPrompt && whipDecision.task ? { whipTask: whipDecision.task } : {}),
    ...(configLoad.config.whip.enabled && whipRead.errors.length > 0 ? { whipStateError: { kind: "whip", sourceId: whipRead.path, status: "malformed" } } : {}),
  });
  const prompt = renderAiuContinuationPrompt({ decision, config: configLoad.config });
  if (!isBlockingDecision(decision, prompt)) {
    return allow(options, inputBytes, decision.reasonCodes[0] ?? decision.kind, diagnostics, decision, prompt);
  }

  return Object.freeze({
    tool: options.tool,
    decision: "block" as const,
    reason: decision.reasonCodes[0] ?? decision.kind,
    inputBytes,
    stdoutJson: Object.freeze({
      decision: "block" as const,
      reason: prompt.body,
    }),
    stderr: formatDiagnostics(diagnostics),
    diagnostics: Object.freeze(diagnostics),
    continuationDecision: decision,
    prompt,
  });
}

export function formatHookStopJson(result: AiuHookStopResult): string {
  return `${JSON.stringify(result.stdoutJson)}\n`;
}

export async function readHookStopStdin(timeoutMs = 250): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);
      clearTimeout(timer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      clearTimeout(timer);
      timer = setTimeout(finish, timeoutMs);
    };
    const onEnd = () => finish();
    timer = setTimeout(finish, timeoutMs);

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onEnd);
    process.stdin.resume();
  });
}

function parseHookPayload(stdin: string): { readonly ok: true; readonly payload: HookPayload } | { readonly ok: false; readonly code: "empty-hook-input" | "malformed-hook-input"; readonly error: string } {
  const trimmed = stdin.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "empty-hook-input", error: "Stop hook input is empty." };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, code: "malformed-hook-input", error: "Stop hook input must be a JSON object." };
    }
    const validationError = validateHookPayloadShape(parsed);
    if (validationError) {
      return { ok: false, code: "malformed-hook-input", error: validationError };
    }
    return {
      ok: true,
      payload: Object.freeze({
        cwd: readString(parsed.cwd),
        hook_event_name: readString(parsed.hook_event_name),
        session_id: readString(parsed.session_id),
        stop_hook_active: readBoolean(parsed.stop_hook_active),
        transcript_path: readNullableString(parsed.transcript_path),
        turn_id: readString(parsed.turn_id),
        permission_mode: readString(parsed.permission_mode),
        model: readString(parsed.model),
        last_assistant_message: readNullableString(parsed.last_assistant_message),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      code: "malformed-hook-input",
      error: `Stop hook input was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function validateHookPayloadShape(parsed: Record<string, unknown>): string | undefined {
  const requiredStrings = ["cwd", "hook_event_name", "session_id", "turn_id", "permission_mode", "model"] as const;
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
      return `${key} must be a non-empty string.`;
    }
  }
  if (parsed.hook_event_name !== "Stop") {
    return "Unsupported hook event; expected Stop.";
  }
  if (typeof parsed.stop_hook_active !== "boolean") {
    return "stop_hook_active must be a boolean.";
  }
  if (!isOptionalNullableString(parsed.transcript_path)) {
    return "transcript_path must be a string or null.";
  }
  if (!isOptionalNullableString(parsed.last_assistant_message)) {
    return "last_assistant_message must be a string or null.";
  }
  return undefined;
}

function stopHookPolicyBlocker(config: AiuConfig, tool: AiuHookStopOptions["tool"]): string | undefined {
  const capabilities = config.hosts.capabilities[tool] ?? {};
  if (!config.hosts.enabled.includes(tool)) {
    return "host-not-enabled";
  }
  if (config.hosts.stopHookBlocking[tool] !== true) {
    return "stop-hook-blocking-disabled";
  }
  if (capabilities.stopHook === false || capabilities.stopHook === "none") {
    return "stop-hook-capability-disabled";
  }
  if (capabilities.promptDelivery === false || capabilities.promptDelivery === "none") {
    return "prompt-delivery-disabled";
  }
  return undefined;
}

function policyBlockerMessage(code: string, tool: AiuHookStopOptions["tool"]): string {
  if (code === "host-not-enabled") {
    return `${tool} is not enabled in hosts.enabled.`;
  }
  if (code === "stop-hook-blocking-disabled") {
    return `${tool} stop-hook blocking is disabled by hosts.stopHookBlocking.`;
  }
  if (code === "stop-hook-capability-disabled") {
    return `${tool} stopHook capability is disabled.`;
  }
  if (code === "prompt-delivery-disabled") {
    return `${tool} promptDelivery capability is disabled.`;
  }
  return code;
}

function hostSessionEnvelope(tool: AiuHookStopOptions["tool"], payload: HookPayload, observedAt: string): AiuTrustedStateEnvelope<AiuHostSessionState> {
  const active = payload.stop_hook_active === true;
  return createAiuTrustedStateEnvelope({
    sourceId: `${tool}-hook`,
    command: {
      id: `${tool}-hook`,
      argv: ["aiu", "hook-stop", "--tool", tool],
    },
    observedAt,
    trustLevel: "advisory",
    capabilities: {
      sessionState: payload.session_id ? "supported" : "unknown",
      promptDelivery: "supported",
    },
    freshness: {
      kind: "fresh",
      observedAt,
    },
    value: {
      kind: "host-session",
      status: active ? "fail" : "pass",
      hostId: tool,
      ...(payload.session_id ? { sessionId: payload.session_id } : {}),
      sessionStatus: active ? "busy" : "idle",
      canPrompt: active ? false : true,
      summary: `${tool} stop hook payload`,
    },
  });
}

function isBlockingDecision(decision: AiuContinuationDecision, prompt: AiuContinuationPrompt): boolean {
  return (decision.kind === "continue" || decision.kind === "repair") && prompt.body.trim().length > 0;
}

function allow(
  options: AiuHookStopOptions,
  inputBytes: number,
  reason: string,
  diagnostics: readonly AiuHookStopDiagnostic[] = [],
  continuationDecision?: AiuContinuationDecision,
  prompt?: AiuContinuationPrompt,
): AiuHookStopResult {
  return Object.freeze({
    tool: options.tool,
    decision: "allow" as const,
    reason,
    inputBytes,
    stdoutJson: Object.freeze({}),
    stderr: formatDiagnostics(diagnostics),
    diagnostics: Object.freeze(diagnostics),
    ...(continuationDecision ? { continuationDecision } : {}),
    ...(prompt ? { prompt } : {}),
  });
}

function diagnostic(severity: AiuHookStopDiagnostic["severity"], code: string, message: string): AiuHookStopDiagnostic {
  return Object.freeze({
    severity,
    code,
    message: boundDiagnostic(redactDiagnostic(message)),
  });
}

function formatDiagnostics(diagnostics: readonly AiuHookStopDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }
  const showTruncationSummary = diagnostics.length > MAX_DIAGNOSTIC_LINES;
  const shown = diagnostics.slice(0, showTruncationSummary ? MAX_DIAGNOSTIC_LINES - 1 : MAX_DIAGNOSTIC_LINES);
  const lines = shown.map((item) => `${item.severity.toUpperCase()} ${item.code}: ${item.message}`);
  if (showTruncationSummary) {
    lines.push(`INFO diagnostics-truncated: omitted ${diagnostics.length - shown.length} additional diagnostic(s).`);
  }
  return `${lines.join("\n")}\n`;
}

function boundDiagnostic(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_DIAGNOSTIC_LENGTH ? compact : `${compact.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{16,}@/g, "[redacted-credential]@")
    .replace(/\b(token|api[_-]?key|secret|password)=([^\s"'`]+)/gi, "$1=[redacted]");
}

function hasSupplyChainApprovalBlock(states: readonly AiuTrustedStateEnvelope[]): boolean {
  return states.some((state) => state.value.reasonCodes?.includes("stop-supply-chain-approval"));
}

function adapterDiagnostics(result: AiuTrustedStateAdapterResult): readonly AiuHookStopDiagnostic[] {
  const stderr = result.record.stderrSummary.trim();
  return stderr.length > 0 ? [diagnostic("warning", "trusted-command-stderr", `Trusted command ${result.record.sourceId} wrote stderr: ${stderr}`)] : [];
}

function stateDiagnostics(state: AiuTrustedStateEnvelope): readonly AiuHookStopDiagnostic[] {
  return state.diagnostics.map((item) => diagnostic(item.severity, `trusted-state-${item.kind}`, `${state.sourceId}: ${item.message}`));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || isNullableString(value);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
