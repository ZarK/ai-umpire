import { spawn } from "node:child_process";
import { redactText } from "@tjalve/qube-cli/redaction";

import type { AiuTrustedStateCommandDescriptor } from "./config.js";
import {
  AIU_STATE_CAPABILITY_SUPPORT,
  AIU_STATE_FRESHNESS_KINDS,
  AIU_STATE_VALUE_KINDS,
  AIU_TRUSTED_STATE_KINDS,
  AIU_TRUSTED_STATE_SCHEMA_VERSION,
  AIU_TRUST_LEVELS,
  createAiuTrustedStateEnvelope,
  type AiuStateCapabilitySupport,
  type AiuStateFreshness,
  type AiuStateFreshnessKind,
  type AiuStateValueKind,
  type AiuTrustLevel,
  type AiuTrustedStateCommandRef,
  type AiuTrustedStateEnvelope,
  type AiuTrustedStatePayload,
} from "./state.js";

export const AIU_TRUSTED_COMMAND_DEFAULT_TIMEOUT_MS = 30_000;
export const AIU_TRUSTED_COMMAND_DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export const AIU_TRUSTED_ADAPTER_ERROR_CODES = [
  "trusted-command-spawn-failed",
  "trusted-command-timeout",
  "trusted-command-non-zero-exit",
  "trusted-command-output-limit",
  "trusted-command-malformed-json",
  "trusted-command-unknown-schema",
  "trusted-command-unsupported-capability",
  "trusted-command-stale-state",
  "trusted-command-invalid-state",
] as const;

export type AiuTrustedAdapterErrorCode = (typeof AIU_TRUSTED_ADAPTER_ERROR_CODES)[number];

export interface AiuTrustedCommandExecutionRecord {
  readonly sourceId: string;
  readonly command: AiuTrustedStateCommandRef;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stderrSummary: string;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly parsedSchemaVersion?: number;
}

export interface AiuTrustedAdapterError {
  readonly code: AiuTrustedAdapterErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type AiuTrustedCommandExecutionResult =
  | {
      readonly ok: true;
      readonly record: AiuTrustedCommandExecutionRecord;
      readonly stdout: string;
    }
  | {
      readonly ok: false;
      readonly record: AiuTrustedCommandExecutionRecord;
      readonly error: AiuTrustedAdapterError;
    };

export type AiuTrustedStateAdapterResult =
  | {
      readonly ok: true;
      readonly record: AiuTrustedCommandExecutionRecord;
      readonly states: readonly AiuTrustedStateEnvelope[];
    }
  | {
      readonly ok: false;
      readonly record: AiuTrustedCommandExecutionRecord;
      readonly error: AiuTrustedAdapterError;
    };

export interface AiuTrustedCommandExecutionOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly observedAt?: string;
}

export interface AiuTrustedStateParseInput {
  readonly sourceId: string;
  readonly command: AiuTrustedStateCommandRef;
  readonly stdout: string;
  readonly observedAt?: string;
  readonly record?: AiuTrustedCommandExecutionRecord;
}

export async function runAiuTrustedStateAdapter(
  sourceId: string,
  descriptor: AiuTrustedStateCommandDescriptor,
  options: AiuTrustedCommandExecutionOptions = {},
): Promise<AiuTrustedStateAdapterResult> {
  const execution = await executeAiuTrustedCommand(sourceId, descriptor, options);
  if (!execution.ok) {
    return execution;
  }

  return parseAiuTrustedStateJson({
    sourceId,
    command: execution.record.command,
    stdout: execution.stdout,
    observedAt: options.observedAt,
    record: execution.record,
  });
}

export function toAiuTrustedStateCommandRef(sourceId: string, descriptor: AiuTrustedStateCommandDescriptor): AiuTrustedStateCommandRef {
  return Object.freeze({
    id: sourceId,
    argv: Object.freeze([...descriptor.argv]) as readonly [string, ...string[]],
    ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
    ...(descriptor.timeoutMs ? { timeoutMs: descriptor.timeoutMs } : {}),
    ...(descriptor.maxOutputBytes ? { maxOutputBytes: descriptor.maxOutputBytes } : {}),
  });
}

export function executeAiuTrustedCommand(
  sourceId: string,
  descriptor: AiuTrustedStateCommandDescriptor,
  options: AiuTrustedCommandExecutionOptions = {},
): Promise<AiuTrustedCommandExecutionResult> {
  const command = toAiuTrustedStateCommandRef(sourceId, descriptor);
  const timeoutMs = options.timeoutMs ?? descriptor.timeoutMs ?? AIU_TRUSTED_COMMAND_DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? descriptor.maxOutputBytes ?? AIU_TRUSTED_COMMAND_DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let settled = false;

  return new Promise((resolve) => {
    const [executable, ...args] = descriptor.argv;
    const child = spawn(executable, args, {
      cwd: descriptor.cwd ?? options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      collectBoundedChunk(stdoutChunks, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      collectBoundedChunk(stderrChunks, chunk);
    });
    child.on("error", (error) => {
      finish({
        code: "trusted-command-spawn-failed",
        message: redactText(error.message),
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const record = buildRecord(exitCode, signal);
      if (timedOut) {
        finishWithRecord(record, {
          code: "trusted-command-timeout",
          message: `Trusted command ${sourceId} timed out after ${timeoutMs}ms.`,
        });
        return;
      }
      if (outputLimitExceeded) {
        finishWithRecord(record, {
          code: "trusted-command-output-limit",
          message: `Trusted command ${sourceId} exceeded ${maxOutputBytes} output bytes.`,
        });
        return;
      }
      if (exitCode !== 0) {
        finishWithRecord(record, {
          code: "trusted-command-non-zero-exit",
          message: `Trusted command ${sourceId} exited with code ${String(exitCode)}.`,
        });
        return;
      }
      settled = true;
      resolve(Object.freeze({
        ok: true as const,
        record,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      }));
    });

    function collectBoundedChunk(target: Buffer[], chunk: Buffer): void {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        const remaining = Math.max(0, maxOutputBytes - (outputBytes - chunk.length));
        if (remaining > 0) {
          target.push(chunk.subarray(0, remaining));
        }
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    }

    function finish(error: AiuTrustedAdapterError): void {
      clearTimeout(timeout);
      finishWithRecord(buildRecord(null, null), error);
    }

    function finishWithRecord(record: AiuTrustedCommandExecutionRecord, error: AiuTrustedAdapterError): void {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({
        ok: false as const,
        record,
        error: Object.freeze(error),
      }));
    }

    function buildRecord(exitCode: number | null, signal: NodeJS.Signals | null): AiuTrustedCommandExecutionRecord {
      return Object.freeze({
        sourceId,
        command,
        ...(descriptor.cwd ?? options.cwd ? { cwd: descriptor.cwd ?? options.cwd } : {}),
        timeoutMs,
        maxOutputBytes,
        exitCode,
        signal,
        stdoutBytes,
        stderrBytes,
        stderrSummary: summarizeStderr(stderrChunks),
        elapsedMs: Math.max(0, Date.now() - startedAt),
        timedOut,
        outputLimitExceeded,
      });
    }
  });
}

export function parseAiuTrustedStateJson(input: AiuTrustedStateParseInput): AiuTrustedStateAdapterResult {
  let raw: unknown;
  try {
    raw = JSON.parse(input.stdout) as unknown;
  } catch (error) {
    return parseFailure(input, "trusted-command-malformed-json", `Trusted command ${input.sourceId} did not emit valid JSON: ${redactText(error instanceof Error ? error.message : String(error))}`);
  }
  const parsedSchemaVersion = readSchemaVersion(raw);
  if (parsedSchemaVersion !== AIU_TRUSTED_STATE_SCHEMA_VERSION) {
    return parseFailure(input, "trusted-command-unknown-schema", `Trusted command ${input.sourceId} emitted unsupported schema version ${String(parsedSchemaVersion)}.`, "$.schemaVersion", parsedSchemaVersion);
  }

  const entries = isRecord(raw) && Array.isArray(raw.states) ? raw.states : [raw];
  const states: AiuTrustedStateEnvelope[] = [];
  for (const [index, entry] of entries.entries()) {
    const normalized = normalizeTrustedStateEntry(entry, input, `$.states[${index}]`);
    if (!normalized.ok) {
      return { ...normalized, record: attachParsedSchema(input.record, parsedSchemaVersion) };
    }
    states.push(normalized.state);
  }

  return Object.freeze({
    ok: true as const,
    record: attachParsedSchema(input.record, parsedSchemaVersion),
    states: Object.freeze(states),
  });
}

function normalizeTrustedStateEntry(
  entry: unknown,
  input: AiuTrustedStateParseInput,
  path: string,
): { readonly ok: true; readonly state: AiuTrustedStateEnvelope } | { readonly ok: false; readonly error: AiuTrustedAdapterError; readonly record: AiuTrustedCommandExecutionRecord } {
  if (!isRecord(entry)) {
    return parseFailure(input, "trusted-command-invalid-state", "Trusted state entry must be an object.", path);
  }

  const envelopeInput = isRecord(entry.value) ? entry : { ...entry, value: withoutEnvelopeFields(entry) };
  const value = envelopeInput.value;
  if (!isRecord(value) || !isTrustedStateKind(value.kind) || !isStateValueKind(value.status)) {
    return parseFailure(input, "trusted-command-invalid-state", "Trusted state value must include a supported kind and status.", `${path}.value`);
  }
  const capabilities = normalizeCapabilities(envelopeInput.capabilities);
  if (Object.values(capabilities).some((support) => support === "unsupported")) {
    return parseFailure(input, "trusted-command-unsupported-capability", "Trusted state reports an unsupported required capability.", `${path}.capabilities`);
  }
  const freshness = normalizeFreshness(envelopeInput.freshness, readString(envelopeInput.observedAt) ?? input.observedAt);
  if (freshness.kind === "stale" || value.status === "stale") {
    return parseFailure(input, "trusted-command-stale-state", "Trusted state is stale and cannot be treated as success.", path);
  }

  return {
    ok: true as const,
    state: createAiuTrustedStateEnvelope({
      sourceId: readString(envelopeInput.sourceId) ?? input.sourceId,
      command: input.command,
      observedAt: readString(envelopeInput.observedAt) ?? input.observedAt ?? new Date(0).toISOString(),
      trustLevel: readTrustLevel(envelopeInput.trustLevel),
      capabilities,
      freshness,
      value: value as unknown as AiuTrustedStatePayload,
      unknownFields: readStringArray(envelopeInput.unknownFields),
      diagnostics: [],
    }),
  };
}

function parseFailure(
  input: AiuTrustedStateParseInput,
  code: AiuTrustedAdapterErrorCode,
  message: string,
  path?: string,
  parsedSchemaVersion?: number,
): { readonly ok: false; readonly record: AiuTrustedCommandExecutionRecord; readonly error: AiuTrustedAdapterError } {
  return Object.freeze({
    ok: false as const,
    record: attachParsedSchema(input.record, parsedSchemaVersion),
    error: Object.freeze({
      code,
      message: redactText(message),
      ...(path ? { path } : {}),
    }),
  });
}

function attachParsedSchema(record: AiuTrustedCommandExecutionRecord | undefined, parsedSchemaVersion: number | undefined): AiuTrustedCommandExecutionRecord {
  const base = record ?? {
    sourceId: "parse",
    command: Object.freeze({ id: "parse", argv: Object.freeze(["parse"]) as readonly [string, ...string[]] }),
    timeoutMs: 0,
    maxOutputBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stderrSummary: "",
    elapsedMs: 0,
    timedOut: false,
    outputLimitExceeded: false,
  };
  return Object.freeze({
    ...base,
    ...(parsedSchemaVersion !== undefined ? { parsedSchemaVersion } : {}),
  });
}

function readSchemaVersion(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.schemaVersion === "number" ? value.schemaVersion : undefined;
}

function normalizeCapabilities(value: unknown): Readonly<Record<string, AiuStateCapabilitySupport>> {
  if (!isRecord(value)) return Object.freeze({});
  const capabilities: Record<string, AiuStateCapabilitySupport> = {};
  for (const [key, support] of Object.entries(value)) {
    if (isCapabilitySupport(support)) {
      capabilities[key] = support;
    }
  }
  return Object.freeze(capabilities);
}

function normalizeFreshness(value: unknown, observedAt: string | undefined): AiuStateFreshness {
  if (!isRecord(value) || !isFreshnessKind(value.kind)) {
    return Object.freeze({
      kind: "fresh",
      observedAt: observedAt ?? new Date(0).toISOString(),
    });
  }
  return Object.freeze({
    kind: value.kind,
    observedAt: readString(value.observedAt) ?? observedAt ?? new Date(0).toISOString(),
    ...(typeof value.ageMs === "number" ? { ageMs: value.ageMs } : {}),
    ...(typeof value.staleAfterMs === "number" ? { staleAfterMs: value.staleAfterMs } : {}),
  });
}

function withoutEnvelopeFields(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!["schemaVersion", "sourceId", "command", "observedAt", "trustLevel", "capabilities", "freshness", "unknownFields", "diagnostics"].includes(key)) {
      output[key] = item;
    }
  }
  return Object.freeze(output);
}

function summarizeStderr(chunks: readonly Buffer[]): string {
  return redactText(Buffer.concat(chunks).toString("utf8").slice(0, 2_000));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? Object.freeze(value.filter((item): item is string => typeof item === "string")) : Object.freeze([]);
}

function readTrustLevel(value: unknown): AiuTrustLevel {
  return AIU_TRUST_LEVELS.some((item) => item === value) ? value as AiuTrustLevel : "trusted";
}

function isTrustedStateKind(value: unknown): boolean {
  return AIU_TRUSTED_STATE_KINDS.some((item) => item === value);
}

function isStateValueKind(value: unknown): value is AiuStateValueKind {
  return AIU_STATE_VALUE_KINDS.some((item) => item === value);
}

function isFreshnessKind(value: unknown): value is AiuStateFreshnessKind {
  return AIU_STATE_FRESHNESS_KINDS.some((item) => item === value);
}

function isCapabilitySupport(value: unknown): value is AiuStateCapabilitySupport {
  return AIU_STATE_CAPABILITY_SUPPORT.some((item) => item === value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
