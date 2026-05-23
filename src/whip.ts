import { createHash } from "node:crypto";

import type { AiuConfig, AiuWhipPolicy, AiuWhipTaskDefinition } from "./config.js";

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

export type AiuWhipTaskStatus = (typeof AIU_WHIP_TASK_STATUSES)[number];
export type AiuWhipOutcome = "higher-priority-ready" | "disabled" | "idle-no-work" | "prompt";

export interface AiuWhipState {
  readonly tasks: readonly AiuWhipStateTask[];
}

export interface AiuWhipStateTask {
  readonly id: string;
  readonly status: AiuWhipTaskStatus;
  readonly promptFingerprint?: string;
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

export function resolveAiuWhipTasks(policy: AiuWhipPolicy): readonly AiuWhipTaskDefinition[] {
  const base = policy.usePackageDefaults ? [...AIU_DEFAULT_WHIP_TASKS] : [];
  return Object.freeze([...new Map([...base, ...policy.tasks].map((task) => [task.id, task])).values()].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)));
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
  const task = resolveAiuWhipTasks(policy).find((candidate) => !stateTasks.some((stateTask) => blocksTask(stateTask, candidate)));
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
