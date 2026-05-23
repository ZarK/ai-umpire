import { createHash } from "node:crypto";
import { constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from "node:fs";
import path from "node:path";

import type { AiuConfig } from "./config.js";
import type { AiuContinuationDecision, AiuDecisionSelectedItem, AiuDecisionSourceSummary } from "./decision.js";
import type { AiuContinuationPrompt } from "./prompt.js";

export interface AiuContinuationPaths {
  readonly stateDir: string;
  readonly lockDir: string;
  readonly logDir: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly logPath: string;
}

export interface AiuContinuationState {
  readonly schemaVersion: 1;
  readonly ownerSessionId?: string;
  readonly targetSessionId?: string;
  readonly selectedItem?: AiuDecisionSelectedItem;
  readonly mode: AiuContinuationDecision["selectedMode"];
  readonly decisionKind: AiuContinuationDecision["kind"];
  readonly reasonCodes: readonly string[];
  readonly lastPromptFingerprint?: string;
  readonly pendingPromptFingerprint?: string;
  readonly lastPromptAt?: string;
  readonly pendingPromptAt?: string;
  readonly updatedAt: string;
  readonly sourceSummaries: readonly AiuDecisionSourceSummary[];
}

export interface AiuContinuationLock {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly eventType: string;
  readonly sessionId?: string;
  readonly acquiredAt: string;
}

export interface AiuContinuationLockHandle {
  readonly acquired: true;
  readonly ownerId: string;
  readonly staleRecovered: boolean;
  readonly staleLock?: AiuContinuationLock;
}

export interface AiuContinuationLockBlocked {
  readonly acquired: false;
  readonly reason: "lock-held";
  readonly lock?: AiuContinuationLock;
}

export type AiuContinuationLockResult = AiuContinuationLockHandle | AiuContinuationLockBlocked;

export interface AiuContinuationLogEntry {
  readonly event: string;
  readonly observedAt: string;
  readonly eventType?: string;
  readonly hostId?: string;
  readonly sessionId?: string;
  readonly selectedSessionId?: string;
  readonly decisionId?: string;
  readonly decisionKind?: string;
  readonly mode?: string;
  readonly reasonCodes?: readonly string[];
  readonly promptFingerprint?: string;
  readonly targetSessionId?: string;
  readonly sourceSummaries?: readonly AiuDecisionSourceSummary[];
  readonly adapterErrors?: readonly string[];
  readonly suppressions?: readonly string[];
  readonly elapsedMs?: number;
  readonly message?: string;
}

const STATE_FILENAME = "continuation.json";
const LOCK_FILENAME = "continuation.lock";
const LOG_FILENAME = "continuation.jsonl";
const MAX_LOG_BYTES = 64 * 1024;
const MAX_LOG_ENTRY_BYTES = 8 * 1024;

export function resolveAiuContinuationPaths(repoRoot: string, config: Pick<AiuConfig, "paths">): AiuContinuationPaths {
  const stateDir = path.resolve(repoRoot, config.paths.stateDir);
  const lockDir = path.resolve(repoRoot, config.paths.lockDir);
  const logDir = path.resolve(repoRoot, config.paths.logDir);
  return Object.freeze({
    stateDir,
    lockDir,
    logDir,
    statePath: path.join(stateDir, STATE_FILENAME),
    lockPath: path.join(lockDir, LOCK_FILENAME),
    logPath: path.join(logDir, LOG_FILENAME),
  });
}

export function readAiuContinuationState(paths: Pick<AiuContinuationPaths, "statePath">): AiuContinuationState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(paths.statePath, "utf8")) as unknown;
    return normalizeContinuationState(parsed);
  } catch {
    return undefined;
  }
}

export function writeAiuContinuationState(paths: Pick<AiuContinuationPaths, "stateDir" | "statePath">, state: AiuContinuationState): void {
  mkdirSync(paths.stateDir, { recursive: true });
  const tempPath = `${paths.statePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, paths.statePath);
}

export function buildAiuContinuationState(input: {
  readonly observedAt: string;
  readonly ownerSessionId?: string;
  readonly targetSessionId?: string;
  readonly decision: AiuContinuationDecision;
  readonly prompt: AiuContinuationPrompt;
}): AiuContinuationState {
  return Object.freeze({
    schemaVersion: 1 as const,
    ...(input.ownerSessionId ? { ownerSessionId: input.ownerSessionId } : {}),
    ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
    ...(input.decision.selectedItem ? { selectedItem: Object.freeze({ ...input.decision.selectedItem }) } : {}),
    mode: input.decision.selectedMode,
    decisionKind: input.decision.kind,
    reasonCodes: Object.freeze([...input.decision.reasonCodes]),
    lastPromptFingerprint: input.prompt.fingerprint,
    pendingPromptFingerprint: input.prompt.fingerprint,
    lastPromptAt: input.observedAt,
    pendingPromptAt: input.observedAt,
    updatedAt: input.observedAt,
    sourceSummaries: Object.freeze(input.decision.sourceSummaries.map((source) => Object.freeze({ ...source }))),
  });
}

export function acquireAiuContinuationLock(input: {
  readonly paths: Pick<AiuContinuationPaths, "lockDir" | "lockPath">;
  readonly observedAt: string;
  readonly eventType: string;
  readonly sessionId?: string;
  readonly staleAfterMs: number;
}): AiuContinuationLockResult {
  mkdirSync(input.paths.lockDir, { recursive: true });
  const ownerId = decisionId([input.eventType, input.sessionId ?? "", input.observedAt]);
  const lock: AiuContinuationLock = Object.freeze({
    schemaVersion: 1 as const,
    ownerId,
    eventType: input.eventType,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    acquiredAt: input.observedAt,
  });

  const first = tryCreateLock(input.paths.lockPath, lock);
  if (first.created) {
    return Object.freeze({ acquired: true as const, ownerId, staleRecovered: false });
  }

  const existing = readAiuContinuationLock(input.paths.lockPath);
  if (existing && isLockStale(existing, input.observedAt, input.staleAfterMs)) {
    const recoveredLock = recoverStaleLock(input.paths.lockPath, existing);
    if (!recoveredLock.recovered) {
      return Object.freeze({ acquired: false as const, reason: "lock-held" as const, ...(recoveredLock.lock ? { lock: recoveredLock.lock } : {}) });
    }
    const recovered = tryCreateLock(input.paths.lockPath, lock);
    if (recovered.created) {
      return Object.freeze({ acquired: true as const, ownerId, staleRecovered: true, staleLock: existing });
    }
  }

  return Object.freeze({ acquired: false as const, reason: "lock-held" as const, ...(existing ? { lock: existing } : {}) });
}

export function releaseAiuContinuationLock(paths: Pick<AiuContinuationPaths, "lockPath">, handle: AiuContinuationLockHandle): void {
  const existing = readAiuContinuationLock(paths.lockPath);
  if (existing?.ownerId === handle.ownerId) {
    rmSync(paths.lockPath, { force: true });
  }
}

export function appendAiuContinuationLog(paths: Pick<AiuContinuationPaths, "logDir" | "logPath">, entry: AiuContinuationLogEntry): void {
  mkdirSync(paths.logDir, { recursive: true });
  const line = `${boundLogEntry(entry)}\n`;
  rotateLogIfNeeded(paths.logPath, Buffer.byteLength(line, "utf8"));
  writeFileSync(paths.logPath, line, { encoding: "utf8", flag: "a", mode: 0o600 });
}

export function continuationPromptIsDuplicate(state: AiuContinuationState | undefined, prompt: AiuContinuationPrompt): boolean {
  return state?.pendingPromptFingerprint === prompt.fingerprint || state?.lastPromptFingerprint === prompt.fingerprint;
}

export function continuationPromptOwnedByOtherSession(state: AiuContinuationState | undefined, sessionId: string | undefined): boolean {
  return Boolean(state?.pendingPromptFingerprint && state.ownerSessionId && sessionId && state.ownerSessionId !== sessionId);
}

export function continuationPromptTargetsSameItem(state: AiuContinuationState | undefined, prompt: AiuContinuationPrompt): boolean {
  if (!state?.pendingPromptFingerprint || !state.selectedItem || !prompt.selectedItem) {
    return false;
  }
  return state.mode === prompt.decisionKind
    && state.selectedItem.kind === prompt.selectedItem.kind
    && state.selectedItem.id === prompt.selectedItem.id
    && state.selectedItem.sourceId === prompt.selectedItem.sourceId;
}

export function persistedLastPromptAt(state: AiuContinuationState | undefined): string | undefined {
  return state?.lastPromptAt ?? state?.pendingPromptAt;
}

export function createAiuDecisionId(input: {
  readonly observedAt: string;
  readonly eventType: string;
  readonly sessionId?: string;
  readonly promptFingerprint?: string;
  readonly reasonCodes?: readonly string[];
}): string {
  return decisionId([input.observedAt, input.eventType, input.sessionId ?? "", input.promptFingerprint ?? "", ...(input.reasonCodes ?? [])]);
}

function tryCreateLock(lockPath: string, lock: AiuContinuationLock): { readonly created: true } | { readonly created: false; readonly reason: "exists" } {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    return { created: true };
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return { created: false, reason: "exists" };
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function recoverStaleLock(lockPath: string, expected: AiuContinuationLock): { readonly recovered: true } | { readonly recovered: false; readonly lock?: AiuContinuationLock } {
  const latest = readAiuContinuationLock(lockPath);
  if (!sameLock(latest, expected)) {
    return Object.freeze({ recovered: false as const, ...(latest ? { lock: latest } : {}) });
  }

  const stalePath = `${lockPath}.${expected.ownerId}.stale`;
  rmSync(stalePath, { force: true });
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return Object.freeze({ recovered: false as const });
    }
    throw error;
  }

  const moved = readAiuContinuationLock(stalePath);
  if (!sameLock(moved, expected)) {
    try {
      renameSync(stalePath, lockPath);
    } catch {
      // Best effort: if restore fails, acquisition below will still use exclusive create.
    }
    return Object.freeze({ recovered: false as const, ...(moved ? { lock: moved } : {}) });
  }
  rmSync(stalePath, { force: true });
  return Object.freeze({ recovered: true as const });
}

function readAiuContinuationLock(lockPath: string): AiuContinuationLock | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    return normalizeContinuationLock(parsed);
  } catch {
    return undefined;
  }
}

function isLockStale(lock: AiuContinuationLock, observedAt: string, staleAfterMs: number): boolean {
  const acquired = Date.parse(lock.acquiredAt);
  const now = Date.parse(observedAt);
  return Number.isFinite(acquired) && Number.isFinite(now) && now - acquired >= staleAfterMs;
}

function sameLock(left: AiuContinuationLock | undefined, right: AiuContinuationLock | undefined): boolean {
  return Boolean(left && right
    && left.ownerId === right.ownerId
    && left.eventType === right.eventType
    && left.sessionId === right.sessionId
    && left.acquiredAt === right.acquiredAt);
}

function rotateLogIfNeeded(logPath: string, incomingBytes: number): void {
  if (!existsSync(logPath)) return;
  const size = statSync(logPath).size;
  if (size + incomingBytes <= MAX_LOG_BYTES) return;
  rmSync(`${logPath}.1`, { force: true });
  renameSync(logPath, `${logPath}.1`);
}

function boundLogEntry(entry: AiuContinuationLogEntry): string {
  const line = JSON.stringify(redactJson(entry));
  if (Buffer.byteLength(line, "utf8") <= MAX_LOG_ENTRY_BYTES) {
    return line;
  }
  return JSON.stringify({
    event: entry.event,
    observedAt: entry.observedAt,
    truncated: true,
    originalBytes: Buffer.byteLength(line, "utf8"),
    message: "Log entry exceeded the per-entry byte cap.",
  });
}

function normalizeContinuationState(value: unknown): AiuContinuationState | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.updatedAt !== "string") return undefined;
  return Object.freeze({
    schemaVersion: 1 as const,
    ...(typeof value.ownerSessionId === "string" ? { ownerSessionId: value.ownerSessionId } : {}),
    ...(typeof value.targetSessionId === "string" ? { targetSessionId: value.targetSessionId } : {}),
    ...(isRecord(value.selectedItem) ? { selectedItem: Object.freeze({ ...value.selectedItem }) as unknown as AiuDecisionSelectedItem } : {}),
    mode: typeof value.mode === "string" ? value.mode as AiuContinuationDecision["selectedMode"] : "stop",
    decisionKind: typeof value.decisionKind === "string" ? value.decisionKind as AiuContinuationDecision["kind"] : "stop",
    reasonCodes: Object.freeze(Array.isArray(value.reasonCodes) ? value.reasonCodes.filter((item): item is string => typeof item === "string") : []),
    ...(typeof value.lastPromptFingerprint === "string" ? { lastPromptFingerprint: value.lastPromptFingerprint } : {}),
    ...(typeof value.pendingPromptFingerprint === "string" ? { pendingPromptFingerprint: value.pendingPromptFingerprint } : {}),
    ...(typeof value.lastPromptAt === "string" ? { lastPromptAt: value.lastPromptAt } : {}),
    ...(typeof value.pendingPromptAt === "string" ? { pendingPromptAt: value.pendingPromptAt } : {}),
    updatedAt: value.updatedAt,
    sourceSummaries: Object.freeze(Array.isArray(value.sourceSummaries) ? value.sourceSummaries.filter(isRecord).map((item) => Object.freeze({ ...item }) as unknown as AiuDecisionSourceSummary) : []),
  });
}

function normalizeContinuationLock(value: unknown): AiuContinuationLock | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.ownerId !== "string" || typeof value.eventType !== "string" || typeof value.acquiredAt !== "string") return undefined;
  return Object.freeze({
    schemaVersion: 1 as const,
    ownerId: value.ownerId,
    eventType: value.eventType,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    acquiredAt: value.acquiredAt,
  });
}

function redactJson(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactJson(nested)]));
  }
  return value;
}

function redactText(value: string): string {
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{16,}@/g, "[redacted-credential]@")
    .replace(/\b(token|api[_-]?key|secret|password)=([^\s"'`]+)/gi, "$1=[redacted]");
}

function decisionId(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
