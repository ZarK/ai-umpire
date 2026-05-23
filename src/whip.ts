import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AiuConfig, AiuWhipPolicy, AiuWhipTaskDefinition } from "./config.js";

export const AIU_WHIP_STATE_SCHEMA_VERSION = 1;
export const AIU_DEFAULT_WHIP_TASKS: readonly AiuWhipTaskDefinition[] = Object.freeze([
  Object.freeze({
    id: "review-doc-command-examples",
    title: "Review documented aiu command examples",
    prompt: "Inspect README.md and docs/ for stale aiu command examples, update only incorrect examples, then run the relevant documentation or CLI tests.",
    priority: 100,
  }),
  Object.freeze({
    id: "inspect-focused-test-coverage",
    title: "Inspect focused test coverage",
    prompt: "Find one implemented aiu behavior with weak local test coverage, add a focused test for that behavior, and run the affected test file plus typecheck.",
    priority: 200,
  }),
]);

export const AIU_WHIP_TASK_STATUSES = ["pending", "prompted", "completed", "cancelled"] as const;
export const AIU_WHIP_TASK_SOURCES = ["package-default", "repo-config", "cli"] as const;
export const AIU_WHIP_ERROR_CODES = [
  "whip-disabled",
  "whip-invalid-command",
  "whip-invalid-task",
  "whip-state-malformed",
  "whip-task-exists",
  "whip-task-not-found",
  "whip-invalid-transition",
  "whip-evidence-required",
  "whip-state-write-failed",
  "whip-stale-ownership",
] as const;

export type AiuWhipTaskStatus = (typeof AIU_WHIP_TASK_STATUSES)[number];
export type AiuWhipTaskSource = (typeof AIU_WHIP_TASK_SOURCES)[number];
export type AiuWhipErrorCode = (typeof AIU_WHIP_ERROR_CODES)[number];
export type AiuWhipOutcome = "higher-priority-ready" | "disabled" | "idle-no-work" | "prompt";

export interface AiuWhipState {
  readonly schemaVersion?: typeof AIU_WHIP_STATE_SCHEMA_VERSION;
  readonly tasks: readonly AiuWhipStateTask[];
}

export interface AiuWhipStateTask {
  readonly id: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly priority?: number;
  readonly status: AiuWhipTaskStatus;
  readonly source?: AiuWhipTaskSource;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly ownerSessionId?: string;
  readonly selectedSessionId?: string;
  readonly promptFingerprint?: string;
  readonly promptedAt?: string;
  readonly completionEvidence?: string;
  readonly completedAt?: string;
  readonly cancellationReason?: string;
  readonly cancelledAt?: string;
}

export interface AiuWhipContinuationInput {
  readonly config: AiuConfig;
  readonly state?: AiuWhipState;
  readonly higherPriorityReady?: boolean;
}

export interface AiuWhipContinuationDecision {
  readonly outcome: AiuWhipOutcome;
  readonly ok: boolean;
  readonly enqueuesPrompt: boolean;
  readonly reasonCodes: readonly string[];
  readonly task?: AiuWhipSelectedTask;
  readonly stateAction: "none" | "preserve";
  readonly promptDeliveryCompletesTask: false;
  readonly statePath: string;
}

export interface AiuWhipSelectedTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly priority: number;
  readonly promptFingerprint: string;
}

export interface AiuWhipReadResult {
  readonly ok: boolean;
  readonly path: string;
  readonly state: AiuWhipState;
  readonly errors: readonly AiuWhipError[];
}

export interface AiuWhipError {
  readonly code: AiuWhipErrorCode;
  readonly message: string;
  readonly path?: string;
}

export interface AiuWhipTaskView {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly priority: number;
  readonly status: AiuWhipTaskStatus;
  readonly source: AiuWhipTaskSource;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly ownerSessionId?: string;
  readonly selectedSessionId?: string;
  readonly promptFingerprint: string;
  readonly promptedAt?: string;
  readonly completionEvidence?: string;
  readonly completedAt?: string;
  readonly cancellationReason?: string;
  readonly cancelledAt?: string;
}

export interface AiuWhipReport {
  readonly enabled: boolean;
  readonly statePath: string;
  readonly stateOk: boolean;
  readonly dryRun: boolean;
  readonly action: AiuWhipAction | string;
  readonly tasks: readonly AiuWhipTaskView[];
  readonly counts: Readonly<Record<AiuWhipTaskStatus, number>>;
  readonly staleOwnership: readonly AiuWhipTaskView[];
  readonly errors: readonly AiuWhipError[];
  readonly changed: boolean;
}

export interface AiuWhipCommandInput {
  readonly action: AiuWhipAction | string;
  readonly repoRoot: string;
  readonly config: AiuConfig;
  readonly dryRun?: boolean;
  readonly observedAt?: string;
  readonly id?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly priority?: number;
  readonly source?: AiuWhipTaskSource;
  readonly reason?: string;
  readonly evidence?: string;
  readonly ownerSessionId?: string;
  readonly selectedSessionId?: string;
}

export type AiuWhipAction = "list" | "status" | "add" | "cancel" | "complete";
const AIU_WHIP_ACTIONS = ["list", "status", "add", "cancel", "complete"] as const;
const AIU_WHIP_MUTATING_ACTIONS = ["add", "cancel", "complete"] as const;

export function resolveAiuWhipTasks(policy: AiuWhipPolicy): readonly AiuWhipTaskDefinition[] {
  const defaults = policy.usePackageDefaults ? AIU_DEFAULT_WHIP_TASKS.map((task) => ({ ...task, source: "package-default" as const })) : [];
  const configured = policy.tasks.map((task) => ({ ...task, source: "repo-config" as const }));
  return Object.freeze([...new Map([...defaults, ...configured].map((task) => [task.id, task])).values()].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)));
}

export function decideAiuWhipContinuation(input: AiuWhipContinuationInput): AiuWhipContinuationDecision {
  const policy = input.config.whip;
  if (input.higherPriorityReady === true) {
    return decision("higher-priority-ready", policy.statePath, false, ["higher-priority-continuation-ready"]);
  }
  if (!policy.enabled) {
    return decision("disabled", policy.statePath, false, ["whip-disabled"], undefined, "preserve");
  }

  const stateTasks = input.state?.tasks ?? [];
  const task = resolveAiuWhipTaskViews(policy, input.state).find((candidate) => !stateTasks.some((stateTask) => blocksTask(stateTask, candidate)));
  if (!task) {
    return decision("idle-no-work", policy.statePath, true, ["whip-no-ready-task"]);
  }

  return decision("prompt", policy.statePath, true, ["whip-task-ready"], {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    priority: task.priority,
    promptFingerprint: fingerprintWhipPrompt(task),
  });
}

export function resolveAiuWhipStatePath(repoRoot: string, config: Pick<AiuConfig, "whip">): string {
  return path.resolve(repoRoot, config.whip.statePath);
}

export function readAiuWhipState(repoRoot: string, config: Pick<AiuConfig, "whip">): AiuWhipReadResult {
  const statePath = resolveAiuWhipStatePath(repoRoot, config);
  if (!existsSync(statePath)) {
    return readResult(statePath, true, { schemaVersion: AIU_WHIP_STATE_SCHEMA_VERSION, tasks: [] }, []);
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    const normalized = normalizeAiuWhipState(parsed);
    return readResult(statePath, normalized.errors.length === 0, normalized.state, normalized.errors);
  } catch (error) {
    return readResult(statePath, false, { schemaVersion: AIU_WHIP_STATE_SCHEMA_VERSION, tasks: [] }, [
      whipError("whip-state-malformed", `Could not parse whip state: ${error instanceof Error ? error.message : String(error)}`, statePath),
    ]);
  }
}

export function writeAiuWhipState(repoRoot: string, config: Pick<AiuConfig, "whip">, state: AiuWhipState): void {
  const statePath = resolveAiuWhipStatePath(repoRoot, config);
  mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ schemaVersion: AIU_WHIP_STATE_SCHEMA_VERSION, tasks: state.tasks }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, statePath);
}

export function runAiuWhipCommand(input: AiuWhipCommandInput): AiuWhipReport {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const read = readAiuWhipState(input.repoRoot, input.config);
  const errors = [...read.errors];
  let tasks: readonly AiuWhipStateTask[] = [...read.state.tasks];
  let changed = false;
  const action = isAiuWhipAction(input.action) ? input.action : undefined;

  if (!action) {
    errors.push(whipError("whip-invalid-command", `Unsupported whip action: ${String(input.action)}.`, read.path));
  } else if (!input.config.whip.enabled && isMutatingWhipAction(action)) {
    errors.push(whipError("whip-disabled", `Whip is disabled; aiu whip ${action} cannot mutate local state.`, read.path));
  } else if (action === "add") {
    const validation = validateNewTask(input);
    errors.push(...validation);
    if (validation.length === 0 && effectiveTaskById(input.config.whip, read.state, input.id) !== undefined) {
      errors.push(whipError("whip-task-exists", `Whip task ${input.id} already exists.`, read.path));
    }
    if (errors.length === 0) {
      tasks = upsertStateTask(tasks, {
        id: input.id as string,
        title: input.title as string,
        prompt: input.prompt as string,
        priority: input.priority as number,
        status: "pending",
        source: input.source ?? "cli",
        createdAt: observedAt,
        updatedAt: observedAt,
        promptFingerprint: fingerprintWhipPrompt(input as AiuWhipTaskDefinition),
      });
      changed = true;
    }
  } else if (action === "cancel" || action === "complete") {
    const task = effectiveTaskById(input.config.whip, read.state, input.id);
    if (!input.id) {
      errors.push(whipError("whip-invalid-task", "--id is required.", read.path));
    } else if (!task) {
      errors.push(whipError("whip-task-not-found", `Whip task ${input.id} was not found.`, read.path));
    } else if (task.status === "completed" || task.status === "cancelled") {
      errors.push(whipError("whip-invalid-transition", `Whip task ${task.id} is already ${task.status}.`, read.path));
    } else if (action === "complete" && !input.evidence?.trim()) {
      errors.push(whipError("whip-evidence-required", "--evidence is required to complete a whip task.", read.path));
    } else {
      const nextTask = stateTaskFromView(task, observedAt);
      tasks = upsertStateTask(tasks, action === "cancel"
        ? {
            ...nextTask,
            status: "cancelled",
            updatedAt: observedAt,
            cancelledAt: observedAt,
            cancellationReason: input.reason?.trim() || "cancelled by aiu whip cancel",
          }
        : {
            ...nextTask,
            status: "completed",
            updatedAt: observedAt,
            completedAt: observedAt,
            completionEvidence: input.evidence?.trim(),
          });
      changed = true;
    }
  }

  const nextState: AiuWhipState = { schemaVersion: AIU_WHIP_STATE_SCHEMA_VERSION, tasks };
  if (changed && !input.dryRun && errors.length === 0) {
    try {
      writeAiuWhipState(input.repoRoot, input.config, nextState);
    } catch (error) {
      errors.push(whipError("whip-state-write-failed", `Could not write whip state: ${error instanceof Error ? error.message : String(error)}`, read.path));
    }
  }

  const views = resolveAiuWhipTaskViews(input.config.whip, nextState);
  return Object.freeze({
    enabled: input.config.whip.enabled,
    statePath: read.path,
    stateOk: read.ok && errors.every((error) => error.code !== "whip-state-malformed"),
    dryRun: input.dryRun === true,
    action: input.action,
    tasks: Object.freeze(views),
    counts: countTasks(views),
    staleOwnership: Object.freeze(views.filter((task) => isStaleOwnedTask(task, observedAt))),
    errors: Object.freeze(errors),
    changed,
  });
}

export function formatAiuWhipReport(report: AiuWhipReport): string {
  const lines = [
    `action: ${report.action}`,
    `enabled: ${String(report.enabled)}`,
    `statePath: ${report.statePath}`,
    `stateOk: ${String(report.stateOk)}`,
    `dryRun: ${String(report.dryRun)}`,
    `changed: ${String(report.changed)}`,
    `tasks: ${report.tasks.length}`,
    `pending: ${report.counts.pending}`,
    `prompted: ${report.counts.prompted}`,
    `completed: ${report.counts.completed}`,
    `cancelled: ${report.counts.cancelled}`,
    `staleOwnership: ${report.staleOwnership.length}`,
    "",
    "Whip tasks:",
    ...(report.tasks.length > 0 ? report.tasks.map((task) => `- ${task.id} [${task.status}] p${task.priority} ${task.title}`) : ["- none"]),
    "",
    "Errors:",
    ...(report.errors.length > 0 ? report.errors.map((error) => `- ${error.code}: ${error.message}`) : ["- none"]),
  ];
  return `${lines.join("\n")}\n`;
}

export function resolveAiuWhipTaskViews(policy: AiuWhipPolicy, state?: AiuWhipState): readonly AiuWhipTaskView[] {
  const definitions = resolveAiuWhipTasks(policy).map((task) => taskViewFromDefinition(task, state?.tasks.find((stateTask) => stateTask.id === task.id)));
  const definitionIds = new Set(definitions.map((task) => task.id));
  const stateOnly = (state?.tasks ?? [])
    .filter((task) => !definitionIds.has(task.id) && task.title && task.prompt && typeof task.priority === "number")
    .map((task) => taskViewFromStateTask(task));
  return Object.freeze([...definitions, ...stateOnly].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)));
}

function decision(
  outcome: AiuWhipOutcome,
  statePath: string,
  ok: boolean,
  reasonCodes: readonly string[],
  task?: AiuWhipSelectedTask,
  stateAction: "none" | "preserve" = "none",
): AiuWhipContinuationDecision {
  return Object.freeze({
    outcome,
    ok,
    enqueuesPrompt: task !== undefined,
    reasonCodes: Object.freeze([...reasonCodes]),
    ...(task ? { task } : {}),
    stateAction,
    promptDeliveryCompletesTask: false as const,
    statePath,
  });
}

function fingerprintWhipPrompt(task: AiuWhipTaskDefinition): string {
  return createHash("sha256").update(`${task.id}\0${task.title}\0${task.prompt}`).digest("hex");
}

function blocksTask(stateTask: AiuWhipStateTask, candidate: AiuWhipTaskDefinition): boolean {
  if (stateTask.status !== "completed" && stateTask.status !== "cancelled") {
    return false;
  }
  if (stateTask.id !== candidate.id) {
    return false;
  }
  return stateTask.promptFingerprint === undefined || stateTask.promptFingerprint === fingerprintWhipPrompt(candidate);
}

function readResult(pathValue: string, ok: boolean, state: AiuWhipState, errors: readonly AiuWhipError[]): AiuWhipReadResult {
  return Object.freeze({
    ok,
    path: pathValue,
    state: Object.freeze({
      schemaVersion: AIU_WHIP_STATE_SCHEMA_VERSION,
      tasks: Object.freeze([...state.tasks]),
    }),
    errors: Object.freeze([...errors]),
  });
}

function normalizeAiuWhipState(value: unknown): { readonly state: AiuWhipState; readonly errors: readonly AiuWhipError[] } {
  const errors: AiuWhipError[] = [];
  if (!isRecord(value)) {
    return { state: { schemaVersion: AIU_WHIP_STATE_SCHEMA_VERSION, tasks: [] }, errors: [whipError("whip-state-malformed", "Whip state root must be an object.")] };
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== AIU_WHIP_STATE_SCHEMA_VERSION) {
    errors.push(whipError("whip-state-malformed", "Whip state schemaVersion must be 1."));
  }
  if (!Array.isArray(value.tasks)) {
    errors.push(whipError("whip-state-malformed", "Whip state tasks must be an array."));
    return { state: { schemaVersion: AIU_WHIP_STATE_SCHEMA_VERSION, tasks: [] }, errors };
  }
  const tasks = value.tasks.flatMap((task, index) => {
    const normalized = normalizeAiuWhipStateTask(task);
    if (!normalized) {
      errors.push(whipError("whip-state-malformed", `Whip task at index ${index} is malformed.`));
      return [];
    }
    return [normalized];
  });
  return {
    state: { schemaVersion: AIU_WHIP_STATE_SCHEMA_VERSION, tasks },
    errors,
  };
}

function normalizeAiuWhipStateTask(value: unknown): AiuWhipStateTask | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !AIU_WHIP_TASK_STATUSES.includes(value.status as AiuWhipTaskStatus)) {
    return undefined;
  }
  return Object.freeze({
    id: value.id,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
    ...(typeof value.priority === "number" && Number.isFinite(value.priority) ? { priority: value.priority } : {}),
    status: value.status as AiuWhipTaskStatus,
    ...(AIU_WHIP_TASK_SOURCES.includes(value.source as AiuWhipTaskSource) ? { source: value.source as AiuWhipTaskSource } : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.ownerSessionId === "string" ? { ownerSessionId: value.ownerSessionId } : {}),
    ...(typeof value.selectedSessionId === "string" ? { selectedSessionId: value.selectedSessionId } : {}),
    ...(typeof value.promptFingerprint === "string" ? { promptFingerprint: value.promptFingerprint } : {}),
    ...(typeof value.promptedAt === "string" ? { promptedAt: value.promptedAt } : {}),
    ...(typeof value.completionEvidence === "string" ? { completionEvidence: value.completionEvidence } : {}),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    ...(typeof value.cancellationReason === "string" ? { cancellationReason: value.cancellationReason } : {}),
    ...(typeof value.cancelledAt === "string" ? { cancelledAt: value.cancelledAt } : {}),
  });
}

function validateNewTask(input: AiuWhipCommandInput): readonly AiuWhipError[] {
  const errors: AiuWhipError[] = [];
  if (!input.id?.trim()) errors.push(whipError("whip-invalid-task", "--id is required."));
  if (!input.title?.trim()) errors.push(whipError("whip-invalid-task", "--title is required."));
  if (!input.prompt?.trim()) errors.push(whipError("whip-invalid-task", "--prompt is required."));
  if (typeof input.priority !== "number" || !Number.isInteger(input.priority) || input.priority < 0) {
    errors.push(whipError("whip-invalid-task", "--priority must be a non-negative integer."));
  }
  return errors;
}

function effectiveTaskById(policy: AiuWhipPolicy, state: AiuWhipState, id: string | undefined): AiuWhipTaskView | undefined {
  if (!id) return undefined;
  return resolveAiuWhipTaskViews(policy, state).find((task) => task.id === id);
}

function taskViewFromDefinition(task: AiuWhipTaskDefinition & { readonly source?: AiuWhipTaskSource }, stateTask: AiuWhipStateTask | undefined): AiuWhipTaskView {
  const fingerprint = fingerprintWhipPrompt(task);
  return Object.freeze({
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    priority: task.priority,
    status: stateTask?.status ?? "pending",
    source: stateTask?.source ?? task.source ?? "repo-config",
    ...(stateTask?.createdAt ? { createdAt: stateTask.createdAt } : {}),
    ...(stateTask?.updatedAt ? { updatedAt: stateTask.updatedAt } : {}),
    ...(stateTask?.ownerSessionId ? { ownerSessionId: stateTask.ownerSessionId } : {}),
    ...(stateTask?.selectedSessionId ? { selectedSessionId: stateTask.selectedSessionId } : {}),
    promptFingerprint: stateTask?.promptFingerprint ?? fingerprint,
    ...(stateTask?.promptedAt ? { promptedAt: stateTask.promptedAt } : {}),
    ...(stateTask?.completionEvidence ? { completionEvidence: stateTask.completionEvidence } : {}),
    ...(stateTask?.completedAt ? { completedAt: stateTask.completedAt } : {}),
    ...(stateTask?.cancellationReason ? { cancellationReason: stateTask.cancellationReason } : {}),
    ...(stateTask?.cancelledAt ? { cancelledAt: stateTask.cancelledAt } : {}),
  });
}

function taskViewFromStateTask(task: AiuWhipStateTask): AiuWhipTaskView {
  const definition = {
    id: task.id,
    title: task.title as string,
    prompt: task.prompt as string,
    priority: task.priority as number,
  };
  return taskViewFromDefinition({ ...definition, source: task.source ?? "cli" }, task);
}

function stateTaskFromView(task: AiuWhipTaskView, observedAt: string): AiuWhipStateTask {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    priority: task.priority,
    status: task.status,
    source: task.source,
    createdAt: task.createdAt ?? observedAt,
    updatedAt: observedAt,
    ...(task.ownerSessionId ? { ownerSessionId: task.ownerSessionId } : {}),
    ...(task.selectedSessionId ? { selectedSessionId: task.selectedSessionId } : {}),
    promptFingerprint: task.promptFingerprint,
    ...(task.promptedAt ? { promptedAt: task.promptedAt } : {}),
    ...(task.completionEvidence ? { completionEvidence: task.completionEvidence } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.cancellationReason ? { cancellationReason: task.cancellationReason } : {}),
    ...(task.cancelledAt ? { cancelledAt: task.cancelledAt } : {}),
  };
}

function upsertStateTask(tasks: readonly AiuWhipStateTask[], task: AiuWhipStateTask): readonly AiuWhipStateTask[] {
  const without = tasks.filter((existing) => existing.id !== task.id);
  return Object.freeze([...without, Object.freeze(task)]);
}

function countTasks(tasks: readonly AiuWhipTaskView[]): Readonly<Record<AiuWhipTaskStatus, number>> {
  return Object.freeze({
    pending: tasks.filter((task) => task.status === "pending").length,
    prompted: tasks.filter((task) => task.status === "prompted").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
  });
}

function isStaleOwnedTask(task: AiuWhipTaskView, observedAt: string): boolean {
  if (task.status !== "prompted" || !task.ownerSessionId) return false;
  const promptedAt = typeof task.promptedAt === "string" ? Date.parse(task.promptedAt) : Number.NaN;
  const updatedAt = Number.isFinite(promptedAt) ? promptedAt : Date.parse(task.updatedAt ?? "");
  const observed = Date.parse(observedAt);
  return Number.isFinite(updatedAt) && Number.isFinite(observed) && observed - updatedAt >= 24 * 60 * 60 * 1000;
}

function isAiuWhipAction(action: string): action is AiuWhipAction {
  return AIU_WHIP_ACTIONS.includes(action as AiuWhipAction);
}

function isMutatingWhipAction(action: AiuWhipAction): boolean {
  return AIU_WHIP_MUTATING_ACTIONS.includes(action as (typeof AIU_WHIP_MUTATING_ACTIONS)[number]);
}

function whipError(code: AiuWhipErrorCode, message: string, pathValue?: string): AiuWhipError {
  return Object.freeze({
    code,
    message,
    ...(pathValue ? { path: pathValue } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
