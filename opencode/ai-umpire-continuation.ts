import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PluginContext {
  commandTimeoutMs?: number;
  continuationLogPath?: string;
  client: ContinuationClient;
  directory: string;
  idleDelayMs?: number;
  logLevel?: ContinuationLogLevel;
  worktree?: string;
}

export type ContinuationLogLevel = "debug" | "info" | "silent";

export interface PluginHooks {
  event?: (input: { event: OpenCodeEvent }) => Promise<void>;
}

export interface WhipState {
  createdAt: string;
  tasks: WhipTask[];
  updatedAt: string;
  version: 1;
}

export interface WhipTask {
  id: string;
  priority: "high" | "low" | "medium";
  prompt: string;
  status: "cancelled" | "completed" | "in_progress" | "pending";
  title: string;
}

interface SessionState {
  preparedDecision?: Promise<ContinuationDecision | undefined>;
  promptTarget?: PromptTarget;
  promptTargetReady?: Promise<PromptTarget | undefined>;
  scheduledPrompt?: ReturnType<typeof setTimeout>;
  skipNextSessionIdle?: boolean;
  idle: boolean;
  isHelper?: boolean;
  lastEventAt?: number;
  lastTakeoverSignalAt?: number;
  sawTuiActivity?: boolean;
  todos?: TodoItem[];
}

interface ContinuationState {
  activeWhipTaskID?: string;
  lastPromptFingerprint?: string;
  ownerSessionID?: string;
  pendingPromptFingerprint?: string;
  pendingPromptUpdatedAt?: string;
  pendingWhipTaskID?: string;
  updatedAt: string;
  version: 1;
}

interface ContinuationDecision {
  fingerprint: string;
  kind: "issue" | "whip";
  prompt: string;
  whipTaskID?: string;
}

interface CommandRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface PromptModel {
  modelID: string;
  providerID: string;
}

interface PromptTarget {
  agent?: string;
  model?: PromptModel;
}

interface PriorityOrderIssue {
  component: string;
  labels: string[];
  number: number;
  priority: string;
  score: number;
  status: string;
  title: string;
}

interface PriorityOrderSummary {
  blockedIssues: number[];
  inProgress: number[];
  issues: PriorityOrderIssue[];
  nextIssue: number | null;
  readyIssues: number[];
  version: 1;
}

interface QueuePolicy {
  components: {
    labels: QueuePolicyComponent[];
    prefix: string;
  };
  defaults: {
    priorityKey: string;
    statusKey: string;
  };
  issueCreation: {
    dependencyLine: string;
    ensureLabelsCommand: string;
    sequenceGuidance: string;
  };
  priorities: QueuePolicyPriority[];
  statuses: QueuePolicyStatus[];
  transitions: Record<string, QueuePolicyTransition>;
  version: 1;
}

interface QueuePolicyLabel {
  color: string;
  createIssue: boolean;
  description: string;
  emoji: string;
  key: string;
  name: string;
}

interface QueuePolicyPriority extends QueuePolicyLabel {
  score: number;
}

interface QueuePolicyStatus extends QueuePolicyLabel {
  scoreModifier: number;
}

interface QueuePolicyComponent {
  color: string;
  description: string;
  name: string;
}

interface QueuePolicyTransition {
  add: string;
  description: string;
  remove: string[];
}

interface QueueStatusNames {
  all: string[];
  blocked: string;
  defaultStatus: string;
  inProgress: string;
  ready: string;
}

type ContinuationClient = {
  app?: {
    log?: (input: { body: { level: "debug" | "error" | "info"; message: string } }) => unknown;
  };
  session: {
    get: (input: {
      path: {
        id: string;
      };
      query?: {
        directory?: string;
      };
    }) => Promise<ContinuationResponse>;
    promptAsync: (input: {
      body: {
        agent?: string;
        model?: PromptModel;
        parts: Array<{ text: string; type: "text" }>;
      };
      path: {
        id: string;
      };
      query?: {
        directory?: string;
      };
    }) => Promise<ContinuationResponse>;
    messages: (input: {
      path: {
        id: string;
      };
      query?: {
        directory?: string;
        limit?: number;
      };
    }) => Promise<ContinuationResponse>;
    todo: (input: {
      path: {
        id: string;
      };
      query?: {
        directory?: string;
      };
    }) => Promise<ContinuationResponse>;
  };
};

type ContinuationResponse = {
  data?: unknown;
  error?: unknown;
  request?: {
    method?: string;
    url?: string;
  };
  response?: {
    status?: number;
    url?: string;
  };
};

type ContinuationTriggerEvent =
  | {
      properties: {
        info: {
          agent?: string;
          model?: {
            modelID?: string;
            providerID?: string;
          };
          modelID?: string;
          providerID?: string;
          role: "assistant" | "user";
          sessionID: string;
          time: {
            completed?: number;
          };
        };
      };
      type: "message.updated";
    }
  | {
      properties: {
        sessionID: string;
        status: {
          type: "busy" | "idle" | "retry";
        };
      };
      type: "session.status";
    }
  | {
      properties: {
        sessionID: string;
      };
      type: "session.idle";
    }
  | {
      properties: {
        sessionID: string;
        todos: TodoItem[];
      };
      type: "todo.updated";
    }
  | {
      properties: {
        sessionID: string;
      };
      type:
        | "tui.command.execute"
        | "tui.prompt.append"
        | "tui.session.select"
        | "tui.toast.show";
    };

type OpenCodeEvent =
  | ContinuationTriggerEvent
  | {
      properties?: {
        sessionID?: string;
      };
      type: string;
    };

function isContinuationTriggerEvent(event: OpenCodeEvent): event is ContinuationTriggerEvent {
  return [
    "message.updated",
    "session.idle",
    "session.status",
    "todo.updated",
    "tui.command.execute",
    "tui.prompt.append",
    "tui.session.select",
    "tui.toast.show",
  ].includes(event.type);
}

type TodoItem = {
  content: string;
  id: string;
  priority: string;
  status: string;
};

const ISSUE_TODO_TEMPLATE = [
  "## Issue Todo Template (ALWAYS USE THIS STRUCTURE)",
  "When starting ANY GitHub issue, create todos with this structure:",
  "```",
  "todowrite({ todos: [",
  '  { id: "1", content: "Read issue #N spec and requirements", status: "in_progress", priority: "high" },',
  '  { id: "2", content: "Implement [feature description]", status: "pending", priority: "high" },',
  '  { id: "oracle-review", content: "Request @oracle QA review of implementation and manual audit evidence", status: "pending", priority: "high" },',
  '  { id: "3", content: "Add E2E tests for [feature]", status: "pending", priority: "high" },',
  '  { id: "4", content: "Run cubic review after E2E tests and apply fixes", status: "pending", priority: "high" },',
  "  // ... more implementation todos ...",
  '  { id: "branch-check", content: "Verify current branch is correct for issue #N", status: "pending", priority: "high" },',
  '  { id: "ship", content: "Ship: commit, PR, merge, pull", status: "pending", priority: "high" },',
  '  { id: "next", content: "[!] BOOTSTRAP NEXT ISSUE - DO NOT COMPLETE UNTIL NEW TODOS EXIST", status: "pending", priority: "high" }',
  "]})",
  "```",
].join("\n");

const COMMON_WORKFLOW_RULES = [
  "* Never ask questions - make decisions according to project rules and continue",
  "* Think holistically - consider system-wide impact, not just the immediate issue",
  "* If `AGENTS.md` exists, follow its Four Golden Rules and Ship Sequence. If it does not exist, follow the built-in workflow rules in this prompt.",
  "* Never stage, commit, or push `.umpire/**` files. They are plugin-managed local state.",
].join("\n");

const WHIP_WORKFLOW_RULES = [
  COMMON_WORKFLOW_RULES,
  "* Focus on backlog triage only: audit the repository, create GitHub issues, and report evidence.",
  "* Do not commit, push, open PRs, or merge as part of a `.umpire` backlog task.",
  "* The plugin manages `.umpire/whip.json` task state automatically. Do not edit `.umpire/**` yourself.",
].join("\n");

const PENDING_PROMPT_STALE_MS = 5 * 60_000;

const CONTINUATION_LOCK_STALE_MS = 2 * 60_000;

const OWNER_SESSION_STALE_MS = 10 * 60_000;

const RECENT_OWNER_HANDOFF_QUIET_MS = 20_000;

const SESSION_STATE_STALE_MS = 30 * 60_000;

const COMMAND_TIMEOUT_EXIT_CODE = 124;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const COMMAND_TIMEOUT_KILL_SIGNAL = "SIGKILL";

const DEFAULT_CONTINUATION_LOCK_PATH = path.join(".umpire", "continuation.lock");

const DEFAULT_CONTINUATION_STATE_PATH = path.join(".umpire", "continuation-state.json");

const DEFAULT_WHIP_PATH = path.join(".umpire", "whip.json");

const DEFAULT_INTERACTIVE_IDLE_DELAY_MS = 0;

const DEFAULT_CONTINUATION_LOG_PATH = path.join(".umpire", "continuation.log");

const SESSION_MESSAGE_RECOVERY_LIMIT = 20;

const INITIAL_WHIP_TASKS: WhipTask[] = [
  {
    id: "review-last-20-prs",
    priority: "high",
    prompt: [
      "Mission: Review the most recent 20 pull requests, or all available recent pull requests if the repository has fewer than 20, and find materially unresolved review feedback.",
      "Inspect: The Conversation tab, review threads, requested changes, comments posted near or after merge, follow-up commits, re-requests for review, and comments marked resolved without a clear corresponding fix or tracked follow-up. Focus on correctness, security, UX, tests, maintainability, and operability gaps rather than taste-only debate.",
      "Dedup: Before opening anything new, check whether the concern was later fixed in another pull request, tracked in an issue, or intentionally deferred with an explicit follow-up.",
      "Issue bar: Create issues only for concrete unresolved gaps that still exist in the current repository. Group multiple review comments into one issue when they point to the same root cause or remediation unit.",
      "Issue contents: Cite the pull request number, the relevant reviewer feedback, the current code path or workflow still affected, why the gap still matters now, and the smallest safe follow-up scope.",
      "Do not file: Already-fixed comments, already-tracked follow-ups, subjective nits, or review remarks that do not imply a real repository problem.",
    ].join("\n"),
    status: "pending",
    title: "Audit the last 20 pull requests for unresolved review feedback",
  },
  {
    id: "validate-aiq-nine-stages",
    priority: "high",
    prompt: [
      "Mission: Determine whether the repository uses the `@tjalve/aiq` package. If it is not in use, stop and create no issues.",
      "Inspect: If `@tjalve/aiq` is in use, identify the repository's expected 9 AIQ stages from local package usage, configuration, scripts, CI workflows, docs, and source rather than guessing stage names. Audit whether each stage exists, is wired into the real workflow, produces real evidence or artifacts where expected, and cannot be trivially bypassed by stubs, dead configs, TODO placeholders, mocks, or manual-only steps.",
      "Dedup: Before opening anything new, check for existing AIQ issues, CI notes, release gates, and recent pull requests that already cover the gap.",
      "Issue bar: Create issues for any missing stage, partially implemented stage, unenforced stage, bypassable stage, misleading stage, or stage whose evidence is not connected to real repository behavior. Group findings by stage or root cause.",
      "Issue contents: Name the affected AIQ stage, cite the evidence you found, explain the exact enforcement or coverage gap, identify the files and workflows involved, and define what valid closed-loop validation should prove.",
      "Do not file: Stages that are clearly documented as intentionally out of scope for this repository and are not claimed elsewhere in the repo or CI flow.",
    ].join("\n"),
    status: "pending",
    title: "Create validation issues for all 9 AIQ stages when @tjalve/aiq is in use",
  },
  {
    id: "review-duplication-and-tech-debt",
    priority: "medium",
    prompt: [
      "Mission: Critically review the codebase for duplication, redundancy, fragmented abstractions, and technical debt that materially harms maintainability.",
      "Inspect: Copy-pasted business rules, duplicated validation or parsing, parallel implementations of the same behavior, repeated query/build logic, duplicated tests or fixtures that have drifted, dead abstractions, stale compatibility layers, TODO/FIXME clusters, and debt that causes bug fixes or feature changes to be repeated across multiple places.",
      "Dedup: Before opening anything new, check whether the cleanup is already tracked, recently refactored, or intentionally kept separate for boundary, performance, or dependency reasons.",
      "Issue bar: Create issues only for safe, scoped improvements with clear payoff. Prefer fewer strong issues over many weak ones, and group multiple occurrences into one issue when they share the same root cause or can be solved by the same cleanup.",
      "Issue contents: Cite the duplicated or debt-heavy locations, explain why the pattern is harmful, describe the smallest reasonable refactor or deletion scope, and note any regression risks or guardrails.",
      "Do not file: Tiny local repetition that is clearer than abstraction, framework or generated boilerplate, intentional boundary duplication, or vague 'could be cleaner' complaints without material value.",
    ].join("\n"),
    status: "pending",
    title: "Create improvement issues for duplication, redundancy, and tech debt",
  },
  {
    id: "audit-test-integrity",
    priority: "high",
    prompt: [
      "Mission: Audit the test suite for cheating, fake coverage, and misleading confidence, especially tests labeled or treated as end-to-end or integration tests that do not exercise the real feature path.",
      "Inspect: Heavy mocking of the core behavior under test, tests asserting mock interactions instead of user-visible outcomes, fake end-to-end flows that bypass real auth, network, database, or runtime boundaries, snapshot-only coverage for important logic, fixtures or test flags that disable real checks, retries and waits that hide flakiness, coverage padding, and tests that can pass while production behavior is broken.",
      "Dedup: Before opening anything new, check existing test-debt issues, CI discussions, flaky-test tickets, and recent fixes that already cover the problem.",
      "Issue bar: Create issues only for concrete misleading patterns with real product or CI risk. Group suites into one issue when the problem is the same anti-pattern rather than many isolated tests.",
      "Issue contents: Name the affected tests or suites, explain the false confidence they create, identify the real path that is not covered, state the risk that can escape to production, and define what a trustworthy replacement or supplement should verify.",
      "Do not file: Honest unit or component tests that are clear about their scope and still leave the critical path covered elsewhere.",
    ].join("\n"),
    status: "pending",
    title: "Create issues for cheating, fake, or over-mocked tests, especially e2e tests",
  },
  {
    id: "review-performance-issues",
    priority: "medium",
    prompt: [
      "Mission: Review the codebase for concrete performance issues and worthwhile optimization opportunities with measurable user, system, or CI impact.",
      "Inspect: Hot paths in request and response flows, rendering loops, background jobs, build and test pipelines, data access, caching, batching, serialization, I/O, and concurrency control. Look for N+1 work, repeated full scans, quadratic behavior, unnecessary recomputation, avoidable large copies, blocking work on latency-sensitive paths, unbounded fan-out, missing backpressure, excessive polling, and chatty external calls.",
      "Dedup: Before opening anything new, check existing performance issues, profiler notes, benchmarks, dashboards, and recent optimization pull requests.",
      "Issue bar: Create issues only for meaningful bottlenecks or high-confidence waste with a believable mechanism and plausible measurement plan. Group multiple call sites into one issue when they share the same root cause.",
      "Issue contents: Cite the suspected hot path, the trigger or scale dimension, the file locations involved, why the current behavior is inefficient, the likely impact, and how success should be measured.",
      "Do not file: Micro-optimizations without practical payoff, or changes that mostly trade readability and simplicity for hypothetical speed.",
    ].join("\n"),
    status: "pending",
    title: "Create performance issues and improvement opportunities",
  },
  {
    id: "review-memory-leaks",
    priority: "medium",
    prompt: [
      "Mission: Inspect the codebase for memory leaks, resource leaks, and lifetime-management bugs that can accumulate over time or under repeated use.",
      "Inspect: Event listeners, timers, intervals, subscriptions, observers, workers, child processes, sockets, streams, file handles, database connections, caches, in-memory queues, retained DOM objects, large closures, aborted tasks, retries, shutdown paths, unmount paths, and long-running processes where allocations or registrations can outlive their owner.",
      "Dedup: Before opening anything new, check existing leak issues, production incident notes, long-run test results, and recent cleanup pull requests.",
      "Issue bar: Create issues only for concrete leak risks or cleanup gaps with a realistic retention path or resource exhaustion story. Group related sites into one issue when they stem from the same lifecycle mistake.",
      "Issue contents: Identify what is allocated or registered, what fails to be released, the trigger pattern, the likely impact, and how the leak or resource exhaustion could be validated, such as heap growth, descriptor growth, queue growth, or long-run reproduction.",
      "Do not file: Speculative garbage-collection worries without a retained-reference story, or normal short-lived allocations for the workload.",
    ].join("\n"),
    status: "pending",
    title: "Create issues for memory leaks and resource cleanup problems",
  },
  {
    id: "review-error-handling",
    priority: "medium",
    prompt: [
      "Mission: Review the codebase for inconsistent error handling, swallowed failures, unclear failure paths, and contracts that make debugging or recovery harder than necessary.",
      "Inspect: Broad catch-and-continue patterns, dropped causes, misleading success states, missing propagation across async boundaries, unhandled promise rejections, retries that hide failure, partial failure without rollback or cleanup, commands that exit successfully on failure, jobs that fail silently, and missing or inconsistent boundary validation where external input enters the system.",
      "Dedup: Before opening anything new, check existing incident issues, bug reports, operational runbooks, and recent fixes that already track the problem.",
      "Issue bar: Create issues only for actionable inconsistencies where real failures can be hidden, misclassified, or turned into confusing behavior for users, operators, or later code. Group findings by failure pattern or contract break, not by file alone.",
      "Issue contents: Show the failing path, the current behavior, why it is unsafe or confusing, what the correct handling contract should be, and the smallest safe fix direction.",
      "Do not file: Deliberate fail-fast behavior that is consistent and documented, or impossible states already ruled out by stronger upstream invariants.",
    ].join("\n"),
    status: "pending",
    title: "Create issues for inconsistent error handling",
  },
  {
    id: "review-logging-gaps",
    priority: "medium",
    prompt: [
      "Mission: Review the codebase for inconsistent logging, missing operational logging, poor log semantics, and logs that are too noisy, too sparse, or not actionable.",
      "Inspect: Startup and shutdown, deploy-time checks, request handling, background jobs, retries, queue processing, scheduled tasks, external API and database calls, auth and security-sensitive flows, and failure recovery paths. Look for missing start, failure, and state-transition logs, missing correlation IDs or structured fields, wrong severity levels, success-only logging, duplicate spam, and logs that leak secrets or sensitive user data.",
      "Dedup: Before opening anything new, check existing observability issues, dashboards, alerts, logging standards, and recent pull requests that already address the gap.",
      "Issue bar: Create issues only for meaningful observability gaps or harmful logging patterns. Group multiple locations into one issue when the same logging contract or schema should be applied consistently.",
      "Issue contents: Cite the affected path or event, explain the current logging problem, why it hurts debugging or operations, and what concrete fields, levels, or events should exist instead.",
      "Do not file: Absence of logs in trivial pure functions, or style-only logging differences with no operational consequence.",
    ].join("\n"),
    status: "pending",
    title: "Create issues for inconsistent or missing logging",
  },
];

function loadQueuePolicy(repoRoot: string): QueuePolicy {
  const queuePolicyPath = path.resolve(repoRoot, "queue-policy.json");
  let raw: string;

  try {
    raw = readFileSync(queuePolicyPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${path.relative(repoRoot, queuePolicyPath) || queuePolicyPath}: ${formatError(error)}`);
  }

  return parseQueuePolicy(raw, path.relative(repoRoot, queuePolicyPath) || queuePolicyPath);
}

function parseQueuePolicy(raw: string, source: string): QueuePolicy {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${source}: ${formatError(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid ${source}: expected an object.`);
  }

  const policy = parsed as Record<string, unknown>;
  if (policy.version !== 1) {
    throw new Error(`Invalid ${source}: unsupported version.`);
  }

  const defaults = parseQueuePolicyDefaults(policy.defaults, source);
  const priorities = parseQueuePolicyPriorities(policy.priorities, source);
  const statuses = parseQueuePolicyStatuses(policy.statuses, source);
  const components = parseQueuePolicyComponents(policy.components, source);
  const transitions = parseQueuePolicyTransitions(policy.transitions, source);
  const issueCreation = parseQueuePolicyIssueCreation(policy.issueCreation, source);

  assertUniqueQueuePolicyKeys(priorities, source, "priority");
  assertUniqueQueuePolicyKeys(statuses, source, "status");
  assertUniqueQueuePolicyComponentNames(components.labels, source);
  assertQueuePolicyReferences({
    components,
    defaults,
    issueCreation,
    priorities,
    statuses,
    transitions,
    version: 1,
  }, source);

  return {
    components,
    defaults,
    issueCreation,
    priorities,
    statuses,
    transitions,
    version: 1,
  };
}

function parseQueuePolicyDefaults(raw: unknown, source: string): QueuePolicy["defaults"] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid ${source} defaults.`);
  }

  const defaults = raw as Record<string, unknown>;
  if (typeof defaults.priorityKey !== "string" || defaults.priorityKey.length === 0) {
    throw new Error(`Invalid ${source} defaults.priorityKey.`);
  }

  if (typeof defaults.statusKey !== "string" || defaults.statusKey.length === 0) {
    throw new Error(`Invalid ${source} defaults.statusKey.`);
  }

  return {
    priorityKey: defaults.priorityKey,
    statusKey: defaults.statusKey,
  };
}

function parseQueuePolicyPriorities(raw: unknown, source: string): QueuePolicyPriority[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Invalid ${source} priorities.`);
  }

  return raw.map((entry, index) => parseQueuePolicyPriority(entry, source, index));
}

function parseQueuePolicyPriority(raw: unknown, source: string, index: number): QueuePolicyPriority {
  const label = parseQueuePolicyLabel(raw, source, `priorities[${index}]`);
  const priority = raw as Record<string, unknown>;
  if (typeof priority.score !== "number" || !Number.isFinite(priority.score)) {
    throw new Error(`Invalid ${source} priorities[${index}].score.`);
  }

  return {
    ...label,
    score: priority.score,
  };
}

function parseQueuePolicyStatuses(raw: unknown, source: string): QueuePolicyStatus[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Invalid ${source} statuses.`);
  }

  return raw.map((entry, index) => parseQueuePolicyStatus(entry, source, index));
}

function parseQueuePolicyStatus(raw: unknown, source: string, index: number): QueuePolicyStatus {
  const label = parseQueuePolicyLabel(raw, source, `statuses[${index}]`);
  const status = raw as Record<string, unknown>;
  if (typeof status.scoreModifier !== "number" || !Number.isFinite(status.scoreModifier)) {
    throw new Error(`Invalid ${source} statuses[${index}].scoreModifier.`);
  }

  return {
    ...label,
    scoreModifier: status.scoreModifier,
  };
}

function parseQueuePolicyLabel(raw: unknown, source: string, fieldPath: string): QueuePolicyLabel {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid ${source} ${fieldPath}.`);
  }

  const label = raw as Record<string, unknown>;
  if (typeof label.key !== "string" || label.key.length === 0) {
    throw new Error(`Invalid ${source} ${fieldPath}.key.`);
  }

  if (typeof label.name !== "string" || label.name.length === 0) {
    throw new Error(`Invalid ${source} ${fieldPath}.name.`);
  }

  if (typeof label.color !== "string" || label.color.length === 0) {
    throw new Error(`Invalid ${source} ${fieldPath}.color.`);
  }

  if (typeof label.description !== "string" || label.description.length === 0) {
    throw new Error(`Invalid ${source} ${fieldPath}.description.`);
  }

  if (typeof label.emoji !== "string" || label.emoji.length === 0) {
    throw new Error(`Invalid ${source} ${fieldPath}.emoji.`);
  }

  if (typeof label.createIssue !== "boolean") {
    throw new Error(`Invalid ${source} ${fieldPath}.createIssue.`);
  }

  return {
    color: label.color,
    createIssue: label.createIssue,
    description: label.description,
    emoji: label.emoji,
    key: label.key,
    name: label.name,
  };
}

function parseQueuePolicyComponents(raw: unknown, source: string): QueuePolicy["components"] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid ${source} components.`);
  }

  const components = raw as Record<string, unknown>;
  if (typeof components.prefix !== "string" || components.prefix.length === 0) {
    throw new Error(`Invalid ${source} components.prefix.`);
  }

  if (!Array.isArray(components.labels)) {
    throw new Error(`Invalid ${source} components.labels.`);
  }

  return {
    labels: components.labels.map((entry, index) => parseQueuePolicyComponent(entry, source, index)),
    prefix: components.prefix,
  };
}

function parseQueuePolicyComponent(raw: unknown, source: string, index: number): QueuePolicyComponent {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid ${source} components.labels[${index}].`);
  }

  const component = raw as Record<string, unknown>;
  if (typeof component.name !== "string" || component.name.length === 0) {
    throw new Error(`Invalid ${source} components.labels[${index}].name.`);
  }

  if (typeof component.color !== "string" || component.color.length === 0) {
    throw new Error(`Invalid ${source} components.labels[${index}].color.`);
  }

  if (typeof component.description !== "string" || component.description.length === 0) {
    throw new Error(`Invalid ${source} components.labels[${index}].description.`);
  }

  return {
    color: component.color,
    description: component.description,
    name: component.name,
  };
}

function parseQueuePolicyTransitions(
  raw: unknown,
  source: string,
): Record<string, QueuePolicyTransition> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid ${source} transitions.`);
  }

  const transitions = Object.entries(raw as Record<string, unknown>);
  if (transitions.length === 0) {
    throw new Error(`Invalid ${source} transitions.`);
  }

  return Object.fromEntries(
    transitions.map(([name, value]) => [name, parseQueuePolicyTransition(value, source, name)]),
  );
}

function parseQueuePolicyTransition(
  raw: unknown,
  source: string,
  transitionName: string,
): QueuePolicyTransition {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid ${source} transitions.${transitionName}.`);
  }

  const transition = raw as Record<string, unknown>;
  if (typeof transition.add !== "string" || transition.add.length === 0) {
    throw new Error(`Invalid ${source} transitions.${transitionName}.add.`);
  }

  if (!Array.isArray(transition.remove) || transition.remove.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`Invalid ${source} transitions.${transitionName}.remove.`);
  }

  if (typeof transition.description !== "string" || transition.description.length === 0) {
    throw new Error(`Invalid ${source} transitions.${transitionName}.description.`);
  }

  return {
    add: transition.add,
    description: transition.description,
    remove: transition.remove.slice(),
  };
}

function parseQueuePolicyIssueCreation(
  raw: unknown,
  source: string,
): QueuePolicy["issueCreation"] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid ${source} issueCreation.`);
  }

  const issueCreation = raw as Record<string, unknown>;
  if (typeof issueCreation.ensureLabelsCommand !== "string" || issueCreation.ensureLabelsCommand.length === 0) {
    throw new Error(`Invalid ${source} issueCreation.ensureLabelsCommand.`);
  }

  if (typeof issueCreation.dependencyLine !== "string" || issueCreation.dependencyLine.length === 0) {
    throw new Error(`Invalid ${source} issueCreation.dependencyLine.`);
  }

  if (typeof issueCreation.sequenceGuidance !== "string" || issueCreation.sequenceGuidance.length === 0) {
    throw new Error(`Invalid ${source} issueCreation.sequenceGuidance.`);
  }

  return {
    dependencyLine: issueCreation.dependencyLine,
    ensureLabelsCommand: issueCreation.ensureLabelsCommand,
    sequenceGuidance: issueCreation.sequenceGuidance,
  };
}

function assertUniqueQueuePolicyKeys(
  labels: ReadonlyArray<QueuePolicyLabel>,
  source: string,
  labelType: string,
): void {
  const keys = new Set<string>();
  const names = new Set<string>();

  for (const label of labels) {
    if (keys.has(label.key)) {
      throw new Error(`Invalid ${source}: duplicate ${labelType} key ${label.key}.`);
    }

    if (names.has(label.name)) {
      throw new Error(`Invalid ${source}: duplicate ${labelType} name ${label.name}.`);
    }

    keys.add(label.key);
    names.add(label.name);
  }
}

function assertUniqueQueuePolicyComponentNames(
  components: ReadonlyArray<QueuePolicyComponent>,
  source: string,
): void {
  const names = new Set<string>();

  for (const component of components) {
    if (names.has(component.name)) {
      throw new Error(`Invalid ${source}: duplicate component name ${component.name}.`);
    }

    names.add(component.name);
  }
}

function assertQueuePolicyReferences(policy: QueuePolicy, source: string): void {
  const priorityKeys = new Set(policy.priorities.map((priority) => priority.key));
  const statusKeys = new Set(policy.statuses.map((status) => status.key));
  const requiredStatusKeys = ["ready", "in_progress", "blocked", "blocking"];
  const requiredTransitionKeys = ["ready", "start", "block", "unblock"];

  if (!policy.priorities.some((priority) => priority.createIssue)) {
    throw new Error(`Invalid ${source}: at least one priority must be enabled for issue creation.`);
  }

  if (!policy.statuses.some((status) => status.createIssue)) {
    throw new Error(`Invalid ${source}: at least one status must be enabled for issue creation.`);
  }

  if (!priorityKeys.has(policy.defaults.priorityKey)) {
    throw new Error(`Invalid ${source}: defaults.priorityKey must reference a defined priority.`);
  }

  if (!statusKeys.has(policy.defaults.statusKey)) {
    throw new Error(`Invalid ${source}: defaults.statusKey must reference a defined status.`);
  }

  for (const statusKey of requiredStatusKeys) {
    if (!statusKeys.has(statusKey)) {
      throw new Error(`Invalid ${source}: missing required status key ${statusKey}.`);
    }
  }

  for (const transitionKey of requiredTransitionKeys) {
    if (!(transitionKey in policy.transitions)) {
      throw new Error(`Invalid ${source}: missing required transition ${transitionKey}.`);
    }
  }

  for (const component of policy.components.labels) {
    if (!component.name.startsWith(policy.components.prefix)) {
      throw new Error(`Invalid ${source}: component ${component.name} must start with ${policy.components.prefix}.`);
    }
  }

  for (const [transitionName, transition] of Object.entries(policy.transitions)) {
    if (!statusKeys.has(transition.add)) {
      throw new Error(`Invalid ${source}: transitions.${transitionName}.add must reference a defined status.`);
    }

    for (const removedStatus of transition.remove) {
      if (!statusKeys.has(removedStatus)) {
        throw new Error(`Invalid ${source}: transitions.${transitionName}.remove must reference defined statuses.`);
      }
    }
  }
}

function resolveQueueStatusNames(policy: QueuePolicy): QueueStatusNames {
  return {
    all: policy.statuses.map((status) => status.name),
    blocked: getQueueStatusName(policy, "blocked"),
    defaultStatus: getQueueStatusName(policy, policy.defaults.statusKey),
    inProgress: getQueueStatusName(policy, "in_progress"),
    ready: getQueueStatusName(policy, "ready"),
  };
}

function getQueueStatusName(policy: QueuePolicy, key: string): string {
  const status = policy.statuses.find((candidate) => candidate.key === key);
  if (status === undefined) {
    throw new Error(`Invalid queue-policy.json: missing status key ${key}.`);
  }

  return status.name;
}

function findQueueStatusName(policy: QueuePolicy, key: string): string | undefined {
  return policy.statuses.find((candidate) => candidate.key === key)?.name;
}

function buildIssuePrompt(issueCreationTemplate: string, queueStatusNames: QueueStatusNames): string {
  return [
    "Continue solving open issues from gh-priority-order.sh. You are a trusted autonomous professional developer with full authority. Search for information. Analyze the issue. Work to completion. Execute without pause.",
    "Rules:",
    buildIssueWorkflowRules(queueStatusNames),
    issueCreationTemplate,
    ISSUE_TODO_TEMPLATE,
    "Go.",
  ].join("\n");
}

function buildIssueWorkflowRules(queueStatusNames: QueueStatusNames): string {
  return [
    COMMON_WORKFLOW_RULES,
    "* git commit, push, pr, merge to ship immediately when everything is done - no confirmations, no approvals needed",
    `* @scripts/gh-priority-order.sh -> start next ${queueStatusNames.ready} issue -> implement -> UI audit -> Oracle -> test -> cubic -> e2e when relevant -> PR + 10 min review -> ship -> repeat.`,
  ].join("\n");
}

function buildIssueCreationTemplate(policy: QueuePolicy): string {
  const priorityLabels = policy.priorities
    .filter((priority) => priority.createIssue)
    .map((priority) => priority.name);
  const statusLabels = policy.statuses
    .filter((status) => status.createIssue)
    .map((status) => status.name);
  const componentLabels = policy.components.labels.map((component) => component.name);
  const inProgressStatus = findQueueStatusName(policy, "in_progress");
  const componentPrefixPattern = `${policy.components.prefix}*`;

  return [
    "## GitHub Issue Creation Rules (ALWAYS FOLLOW)",
    `* Before creating issues, ensure the core queue labels exist by running \`${policy.issueCreation.ensureLabelsCommand}\`.`,
    `* Every created issue must have exactly one priority label: ${formatCodeList(priorityLabels)}.`,
    `* Every created issue must have exactly one status label: ${formatCodeList(statusLabels)}.${inProgressStatus === undefined ? "" : ` Do not create fresh issues directly as \`${inProgressStatus}\`.`}`,
    componentLabels.length === 0
      ? `* Add one \`${componentPrefixPattern}\` component label only if the repository already has a stable component taxonomy. Do not copy component or epic labels from another repository.`
      : `* Add one \`${componentPrefixPattern}\` component label only from the configured repository taxonomy: ${formatCodeList(componentLabels)}.`,
    `* Keep dependencies explicit with one \`${policy.issueCreation.dependencyLine}\` line per blocker in the issue body.`,
    `* ${policy.issueCreation.sequenceGuidance}`,
    "Use this issue body shape:",
    "```markdown",
    "## Problem",
    "[what is wrong, missing, or risky]",
    "",
    "## Why It Matters",
    "[user impact, correctness impact, maintainability impact, or operational risk]",
    "",
    "## Scope",
    "- [ ] [concrete acceptance criterion or task]",
    "- [ ] [concrete acceptance criterion or task]",
    "",
    "## Notes",
    "- [optional evidence, constraints, or implementation hints]",
    "",
    policy.issueCreation.dependencyLine,
    "```",
  ].join("\n");
}

function formatCodeList(values: readonly string[]): string {
  const formatted = values.map((value) => `\`${value}\``);
  if (formatted.length === 0) {
    return "";
  }

  if (formatted.length === 1) {
    return formatted[0] ?? "";
  }

  if (formatted.length === 2) {
    return `${formatted[0]} or ${formatted[1]}`;
  }

  return `${formatted.slice(0, -1).join(", ")}, or ${formatted[formatted.length - 1]}`;
}

const managedStateRootReady = new Map<string, Promise<void>>();

export class ContinuationController {
  private readonly client: ContinuationClient;

  private readonly continuationLockPath: string;

  private readonly continuationStatePath: string;

  private readonly commandTimeoutMs: number;

  private readonly cwd: string;

  private readonly issueCreationTemplate: string;

  private readonly issuePrompt: string;

  private eventChain: Promise<void> = Promise.resolve();

  private readonly idleDelayMs: number;

  private managedStateRootReady?: Promise<void>;

  private readonly logger: ContinuationLogger;

  private readonly priorityOrderScript: string;

  private readonly queueStatusNames: QueueStatusNames;

  private readonly sessionStates = new Map<string, SessionState>();

  private readonly whipPath: string;

  constructor(context: PluginContext, logger: ContinuationLogger) {
    this.client = context.client;
    this.cwd = path.resolve(context.worktree ?? context.directory);
    this.commandTimeoutMs = normalizeCommandTimeoutMs(context.commandTimeoutMs);
    const queuePolicy = loadQueuePolicy(this.cwd);
    this.logger = logger;
    this.continuationLockPath = path.resolve(this.cwd, DEFAULT_CONTINUATION_LOCK_PATH);
    this.continuationStatePath = path.resolve(this.cwd, DEFAULT_CONTINUATION_STATE_PATH);
    this.issueCreationTemplate = buildIssueCreationTemplate(queuePolicy);
    this.queueStatusNames = resolveQueueStatusNames(queuePolicy);
    this.issuePrompt = buildIssuePrompt(this.issueCreationTemplate, this.queueStatusNames);
    this.idleDelayMs = Math.max(0, context.idleDelayMs ?? DEFAULT_INTERACTIVE_IDLE_DELAY_MS);
    this.priorityOrderScript = path.resolve(this.cwd, "scripts", "gh-priority-order.sh");
    this.whipPath = path.resolve(this.cwd, DEFAULT_WHIP_PATH);
    this.logger.info("Initialized continuation controller.", {
      commandTimeoutMs: this.commandTimeoutMs,
      cwd: this.cwd,
      idleDelayMs: this.idleDelayMs,
      logLevel: context.logLevel ?? "silent",
    });
  }

  async handleEvent(event: ContinuationTriggerEvent): Promise<void> {
    const sessionID = getContinuationEventSessionID(event);
    this.logger.debug("Queueing continuation event.", {
      sessionID,
      type: event.type,
    });
    const run = this.eventChain.catch(() => undefined).then(() => this.handleEventSerial(event));
    this.eventChain = run;
    return run;
  }

  private async handleEventSerial(event: ContinuationTriggerEvent): Promise<void> {
    const sessionID = getContinuationEventSessionID(event);
    const state = this.getSessionState(sessionID);
    const observedAt = Date.now();
    state.lastEventAt = observedAt;
    this.pruneStaleSessionStates(sessionID, observedAt);

    this.logger.debug("Handling continuation event.", {
      hasTodos: state.todos !== undefined,
      idle: state.idle,
      sessionID,
      type: event.type,
    });

    switch (event.type) {
      case "message.updated":
        this.capturePromptTargetFromEvent(state, event);
        this.logger.debug("Observed message.updated event.", {
          agent: state.promptTarget?.agent,
          completed: event.properties.info.time.completed,
          model: state.promptTarget?.model,
          role: event.properties.info.role,
          sessionID,
        });
        break;
      case "session.status":
        state.idle = event.properties.status.type === "idle";
        this.logger.debug("Updated idle state from session.status event.", {
          idle: state.idle,
          sessionID,
          status: event.properties.status.type,
        });
        if (!state.idle) {
          this.clearScheduledPrompt(state, sessionID, "session became busy");
          state.skipNextSessionIdle = false;
          return;
        }

        break;
      case "session.idle":
        state.idle = true;
        this.logger.debug("Marked session idle from session.idle event.", {
          sessionID,
        });
        if (state.skipNextSessionIdle) {
          state.skipNextSessionIdle = false;
          this.logger.debug("Ignoring redundant session.idle after enqueuing continuation.", {
            sessionID,
          });
          return;
        }
        break;
      case "tui.command.execute":
      case "tui.prompt.append":
      case "tui.session.select":
        state.lastTakeoverSignalAt = Date.now();
        state.sawTuiActivity = true;
        this.logger.debug("Observed TUI activity for session.", {
          sessionID,
          type: event.type,
        });
        return;
      case "tui.toast.show":
        state.sawTuiActivity = true;
        this.logger.debug("Observed TUI activity for session.", {
          sessionID,
          type: event.type,
        });
        return;
      case "todo.updated":
        state.todos = [...event.properties.todos];
        this.logger.debug("Updated cached todos from todo.updated event.", {
          activeTodoCount: countActiveTodos(state.todos),
          sessionID,
          totalTodos: state.todos.length,
        });
        if (hasActiveTodos(state.todos)) {
          this.clearPreparedDecision(state);
        }
        break;
    }

    await this.prepareManagedStateRoot(event, state);
    await this.prepareDecisionIfNeeded(event, state, sessionID);

    if (event.type === "message.updated") {
      return;
    }

    await this.scheduleOrRunPrompt(sessionID, state);
  }

  private async prepareManagedStateRoot(
    event: ContinuationTriggerEvent,
    state: SessionState,
  ): Promise<void> {
    if (event.type !== "todo.updated" && event.type !== "message.updated" && !state.idle) {
      return;
    }

    if (event.type === "message.updated" && !isAssistantMessageEvent(event)) {
      return;
    }

    if (this.managedStateRootReady === undefined) {
      this.logger.debug("Preparing managed continuation state root.", {
        cwd: this.cwd,
        reason: event.type,
        sessionID: getContinuationEventSessionID(event),
      });
      this.managedStateRootReady = ensureManagedStateRoot(this.cwd, this.commandTimeoutMs);
    }

    await this.managedStateRootReady;
  }

  private async prepareDecisionIfNeeded(
    event: ContinuationTriggerEvent,
    state: SessionState,
    sessionID: string,
  ): Promise<void> {
    if (!shouldPrepareDecision(event, state)) {
      return;
    }

    if (await this.isHelperSession(sessionID, state)) {
      return;
    }

    const todos = state.todos ?? (await fetchSessionTodos(this.client, sessionID, this.cwd));
    state.todos = todos;
    if (hasActiveTodos(todos)) {
      this.clearPreparedDecision(state);
      return;
    }

    if (state.preparedDecision === undefined) {
      this.logger.debug("Precomputing continuation decision.", {
        reason: event.type,
        sessionID,
      });
      state.preparedDecision = this.resolveDecision().catch((error) => {
        state.preparedDecision = undefined;
        throw error;
      });
    }

    await state.preparedDecision;
  }

  private clearPreparedDecision(state: SessionState): void {
    state.preparedDecision = undefined;
  }

  private clearScheduledPrompt(state: SessionState, sessionID: string, reason: string): void {
    if (state.scheduledPrompt === undefined) {
      return;
    }

    clearTimeout(state.scheduledPrompt);
    state.scheduledPrompt = undefined;
    this.logger.debug("Cancelled scheduled continuation prompt.", {
      reason,
      sessionID,
    });
  }

  private async takePreparedDecision(
    state: SessionState,
    sessionID: string,
  ): Promise<ContinuationDecision | undefined> {
    const preparedDecision = state.preparedDecision ?? this.resolveDecision();
    try {
      return await preparedDecision;
    } finally {
      if (state.preparedDecision === preparedDecision) {
        this.logger.debug("Clearing prepared continuation decision after use.", {
          sessionID,
        });
        state.preparedDecision = undefined;
      }
    }
  }

  private getSessionState(sessionID: string): SessionState {
    const existing = this.sessionStates.get(sessionID);
    if (existing !== undefined) {
      return existing;
    }

    const created: SessionState = { idle: false };
    this.sessionStates.set(sessionID, created);
    return created;
  }

  private pruneStaleSessionStates(activeSessionID: string, observedAt: number): void {
    if (this.sessionStates.size <= 1) {
      return;
    }

    const staleBefore = observedAt - SESSION_STATE_STALE_MS;
    let evictedSessionCount = 0;

    for (const [sessionID, state] of this.sessionStates.entries()) {
      if (sessionID === activeSessionID) {
        continue;
      }

      if (state.scheduledPrompt !== undefined) {
        continue;
      }

      if (state.lastEventAt === undefined || state.lastEventAt > staleBefore) {
        continue;
      }

      this.evictSessionState(sessionID, state, "stale session state");
      evictedSessionCount += 1;
    }

    if (evictedSessionCount === 0) {
      return;
    }

    this.logger.debug("Evicted stale continuation session state entries.", {
      activeSessionID,
      evictedSessionCount,
      sessionStateStaleMs: SESSION_STATE_STALE_MS,
    });
  }

  private evictSessionState(sessionID: string, state: SessionState, reason: string): void {
    this.clearScheduledPrompt(state, sessionID, reason);
    state.preparedDecision = undefined;
    state.promptTarget = undefined;
    state.promptTargetReady = undefined;
    state.todos = undefined;
    this.sessionStates.delete(sessionID);
    this.logger.debug("Evicted continuation session state.", {
      reason,
      sessionID,
    });
  }

  private getIdleDelayMs(state: SessionState): number {
    if (!state.sawTuiActivity) {
      return 0;
    }

    return this.idleDelayMs;
  }

  private async scheduleOrRunPrompt(sessionID: string, state: SessionState): Promise<void> {
    this.clearScheduledPrompt(state, sessionID, "rescheduling continuation check");
    const delayMs = this.getIdleDelayMs(state);
    if (delayMs <= 0) {
      await this.maybePrompt(sessionID);
      return;
    }

    this.logger.info("Delaying continuation prompt after idle TUI event.", {
      delayMs,
      sessionID,
    });

    state.scheduledPrompt = setTimeout(() => {
      state.scheduledPrompt = undefined;
      void this.handleDelayedPrompt(sessionID);
    }, delayMs);
  }

  private async handleDelayedPrompt(sessionID: string): Promise<void> {
    try {
      await this.maybePrompt(sessionID);
    } catch (error) {
      this.logger.error(formatError(error));
    }
  }

  private async maybePrompt(sessionID: string): Promise<void> {
    const state = this.getSessionState(sessionID);
    this.logger.debug("Evaluating continuation prompt eligibility.", {
      cachedTodoCount: state.todos?.length,
      idle: state.idle,
      sessionID,
    });

    if (await this.isHelperSession(sessionID, state)) {
      this.logger.debug("Skipping continuation for helper session.", { sessionID });
      return;
    }

    const todos = state.todos ?? (await fetchSessionTodos(this.client, sessionID, this.cwd));
    state.todos = todos;

    this.logger.debug("Loaded session todos for continuation check.", {
      activeTodoCount: countActiveTodos(todos),
      sessionID,
      totalTodos: todos.length,
    });

    if (!state.idle) {
      this.logger.debug("Skipping continuation because session is not idle.", { sessionID });
      return;
    }

    if (hasActiveTodos(todos)) {
      this.logger.debug("Skipping continuation because active todos remain.", {
        activeTodoCount: countActiveTodos(todos),
        sessionID,
      });
      return;
    }

    const lockResult = await withContinuationLock<void>(
      this.continuationLockPath,
      this.logger,
      async () => {
        this.logger.debug("Acquired continuation lock.", {
          continuationLockPath: this.continuationLockPath,
          sessionID,
        });

        await this.prepareManagedStateRoot(
          {
            properties: { sessionID },
            type: "session.idle",
          },
          state,
        );
        let continuationState = await ensureContinuationState(
          this.continuationStatePath,
          this.commandTimeoutMs,
        );
        continuationState = await this.releaseInactiveOwnerIfNeeded(sessionID, state, continuationState);
        continuationState = await this.releaseStalePendingPromptIfNeeded(continuationState);

        if (
          continuationState.ownerSessionID !== undefined &&
          continuationState.ownerSessionID !== sessionID
        ) {
          this.logger.debug("Skipping continuation because another session owns it.", {
            ownerSessionID: continuationState.ownerSessionID,
            sessionID,
          });
          return;
        }

        if (continuationState.ownerSessionID === undefined) {
          continuationState = await writeContinuationState(
            this.continuationStatePath,
            {
              ...continuationState,
              ownerSessionID: sessionID,
            },
            this.commandTimeoutMs,
          );
          this.logger.info("Claimed continuation ownership.", { sessionID });
        }

        continuationState = await this.completeWhipTaskIfNeeded(sessionID, continuationState);
        if (continuationState.pendingPromptFingerprint !== undefined) {
          this.logger.debug("Skipping continuation because a prompt reservation is already pending.", {
            pendingPromptFingerprint: continuationState.pendingPromptFingerprint,
            pendingWhipTaskID: continuationState.pendingWhipTaskID,
            sessionID,
          });
          return;
        }

        const decision = await this.takePreparedDecision(state, sessionID);
        if (decision === undefined) {
          this.logger.debug("Skipping continuation because no next decision was available.", {
            sessionID,
          });
          return;
        }

        if (decision.fingerprint === continuationState.lastPromptFingerprint) {
          this.logger.debug("Skipping continuation because the next fingerprint matches the last delivered prompt.", {
            fingerprint: decision.fingerprint,
            sessionID,
          });
          return;
        }

        continuationState = await writeContinuationState(
          this.continuationStatePath,
          {
            ...continuationState,
            ownerSessionID: sessionID,
            pendingPromptFingerprint: decision.fingerprint,
            pendingPromptUpdatedAt: new Date().toISOString(),
            pendingWhipTaskID: decision.whipTaskID,
          },
          this.commandTimeoutMs,
        );

        this.logger.info("Reserved continuation prompt.", {
          fingerprint: decision.fingerprint,
          kind: decision.kind,
          sessionID,
          whipTaskID: decision.whipTaskID,
        });

        try {
          const promptTarget = await this.getPromptTarget(sessionID, state);
          this.logger.info("Enqueuing continuation prompt.", {
            agent: promptTarget?.agent,
            fingerprint: decision.fingerprint,
            kind: decision.kind,
            model: promptTarget?.model,
            sessionID,
            whipTaskID: decision.whipTaskID,
          });
          await promptSession(this.client, sessionID, this.cwd, decision.prompt, promptTarget);
        } catch (error) {
          await writeContinuationState(
            this.continuationStatePath,
            {
              ...continuationState,
              pendingPromptFingerprint: undefined,
              pendingPromptUpdatedAt: undefined,
              pendingWhipTaskID: undefined,
            },
            this.commandTimeoutMs,
          );
          this.logger.debug("Cleared failed continuation prompt reservation.", {
            fingerprint: decision.fingerprint,
            sessionID,
          });
          throw error;
        }

        this.logger.info("Enqueued continuation prompt.", {
          fingerprint: decision.fingerprint,
          kind: decision.kind,
          sessionID,
          whipTaskID: decision.whipTaskID,
        });
        state.skipNextSessionIdle = true;

        if (decision.kind === "whip" && decision.whipTaskID !== undefined) {
          await updateWhipTaskStatus(
            this.whipPath,
            decision.whipTaskID,
            "in_progress",
            this.commandTimeoutMs,
          );
          this.logger.debug("Marked whip task in progress after prompt enqueue.", {
            sessionID,
            whipTaskID: decision.whipTaskID,
          });
        }

        await writeContinuationState(
          this.continuationStatePath,
          {
            ...continuationState,
            activeWhipTaskID: decision.kind === "whip" ? decision.whipTaskID : undefined,
            lastPromptFingerprint: decision.fingerprint,
            ownerSessionID: sessionID,
            pendingPromptFingerprint: undefined,
            pendingPromptUpdatedAt: undefined,
            pendingWhipTaskID: undefined,
          },
          this.commandTimeoutMs,
        );
      },
    );

    if (!lockResult.acquired) {
      this.logger.debug("Skipping continuation because the lock is already held.", {
        continuationLockPath: this.continuationLockPath,
        sessionID,
      });
    }
  }

  private async completeWhipTaskIfNeeded(
    sessionID: string,
    continuationState: ContinuationState,
  ): Promise<ContinuationState> {
    if (
      continuationState.ownerSessionID !== sessionID ||
      continuationState.activeWhipTaskID === undefined
    ) {
      return continuationState;
    }

    await updateWhipTaskStatus(
      this.whipPath,
      continuationState.activeWhipTaskID,
      "completed",
      this.commandTimeoutMs,
    );
    this.logger.info("Completed active whip task before selecting the next continuation prompt.", {
      sessionID,
      whipTaskID: continuationState.activeWhipTaskID,
    });
    return writeContinuationState(
      this.continuationStatePath,
      {
        ...continuationState,
        activeWhipTaskID: undefined,
      },
      this.commandTimeoutMs,
    );
  }

  private async isHelperSession(sessionID: string, state: SessionState): Promise<boolean> {
    if (state.isHelper !== undefined) {
      return state.isHelper;
    }

    const sessionInfo = await fetchSessionInfo(this.client, sessionID, this.cwd, {
      allowMissing: true,
    });
    if (sessionInfo === undefined) {
      this.evictSessionState(sessionID, state, "missing session metadata");
      this.logger.debug("Treating session as non-continuation target because metadata is missing.", {
        sessionID,
      });
      return true;
    }

    state.isHelper = sessionInfo.parentID !== undefined;
    this.logger.debug("Resolved session metadata for continuation eligibility.", {
      isHelper: state.isHelper,
      parentID: sessionInfo.parentID,
      sessionID,
    });
    return state.isHelper;
  }

  private async releaseInactiveOwnerIfNeeded(
    sessionID: string,
    state: SessionState,
    continuationState: ContinuationState,
  ): Promise<ContinuationState> {
    if (continuationState.ownerSessionID === undefined) {
      return continuationState;
    }

    if (continuationState.ownerSessionID === sessionID) {
      return continuationState;
    }

    const ownerSession = await fetchSessionInfo(this.client, continuationState.ownerSessionID, this.cwd, {
      allowMissing: true,
    });
    if (ownerSession === undefined) {
      return this.releaseOwnerSession(continuationState, {
        message: "Released continuation ownership because the recorded owner session no longer exists.",
        ownerSessionID: continuationState.ownerSessionID,
        pendingWhipTaskID: continuationState.pendingWhipTaskID,
      });
    }

    const ownerLastActivityAt = await fetchSessionLastActivityAt(
      this.logger,
      this.client,
      continuationState,
      continuationState.ownerSessionID,
      this.cwd,
      SESSION_MESSAGE_RECOVERY_LIMIT,
    );
    if (ownerLastActivityAt === undefined) {
      return continuationState;
    }

    if (Date.now() - ownerLastActivityAt <= OWNER_SESSION_STALE_MS) {
      if (!this.shouldYieldRecentOwnerToNewerSession(state, continuationState.ownerSessionID, ownerLastActivityAt)) {
        return continuationState;
      }

      return this.releaseOwnerSession(continuationState, {
        lastActivityAt: new Date(ownerLastActivityAt).toISOString(),
        message: "Released continuation ownership because a newer root session became active after the previous owner went locally quiet.",
        ownerSessionID: continuationState.ownerSessionID,
        pendingWhipTaskID: continuationState.pendingWhipTaskID,
      });
    }

    return this.releaseOwnerSession(continuationState, {
      lastActivityAt: new Date(ownerLastActivityAt).toISOString(),
      message: "Released continuation ownership because the recorded owner session was inactive.",
      ownerSessionID: continuationState.ownerSessionID,
      pendingWhipTaskID: continuationState.pendingWhipTaskID,
    });
  }

  private shouldYieldRecentOwnerToNewerSession(
    candidateState: SessionState,
    ownerSessionID: string,
    ownerLastActivityAt: number,
  ): boolean {
    if (candidateState.lastEventAt === undefined) {
      return false;
    }

    if (!hasFreshTakeoverSignal(candidateState, candidateState.lastEventAt)) {
      return false;
    }

    if (candidateState.lastEventAt - ownerLastActivityAt < RECENT_OWNER_HANDOFF_QUIET_MS) {
      return false;
    }

    const ownerState = this.sessionStates.get(ownerSessionID);
    if (ownerState?.lastEventAt === undefined) {
      return false;
    }

    return candidateState.lastEventAt - ownerState.lastEventAt >= RECENT_OWNER_HANDOFF_QUIET_MS;
  }

  private async releaseOwnerSession(
    continuationState: ContinuationState,
    details: {
      lastActivityAt?: string;
      message: string;
      ownerSessionID: string;
      pendingWhipTaskID?: string;
    },
  ): Promise<ContinuationState> {
    if (continuationState.pendingWhipTaskID !== undefined) {
      await updateWhipTaskStatus(
        this.whipPath,
        continuationState.pendingWhipTaskID,
        "in_progress",
        this.commandTimeoutMs,
      );
    }

    const ownerState = this.sessionStates.get(details.ownerSessionID);
    if (ownerState !== undefined) {
      this.evictSessionState(details.ownerSessionID, ownerState, "released continuation owner");
    }

    this.logger.info(details.message, details);

    return writeContinuationState(
      this.continuationStatePath,
      {
        ...continuationState,
        activeWhipTaskID: undefined,
        lastPromptFingerprint: undefined,
        ownerSessionID: undefined,
        pendingPromptFingerprint: undefined,
        pendingPromptUpdatedAt: undefined,
        pendingWhipTaskID: undefined,
      },
      this.commandTimeoutMs,
    );
  }

  private async releaseStalePendingPromptIfNeeded(
    continuationState: ContinuationState,
  ): Promise<ContinuationState> {
    if (continuationState.pendingPromptFingerprint === undefined) {
      return continuationState;
    }

    if (continuationState.pendingWhipTaskID !== undefined) {
      if (!isPendingPromptFresh(continuationState.pendingPromptUpdatedAt)) {
        await updateWhipTaskStatus(
          this.whipPath,
          continuationState.pendingWhipTaskID,
          "in_progress",
          this.commandTimeoutMs,
        );

        this.logger.info("Released stale pending whip reservation.", {
          pendingPromptFingerprint: continuationState.pendingPromptFingerprint,
          pendingWhipTaskID: continuationState.pendingWhipTaskID,
        });

        return writeContinuationState(
          this.continuationStatePath,
          {
            ...continuationState,
            activeWhipTaskID: undefined,
            lastPromptFingerprint: undefined,
            ownerSessionID: undefined,
            pendingPromptFingerprint: undefined,
            pendingPromptUpdatedAt: undefined,
            pendingWhipTaskID: undefined,
          },
          this.commandTimeoutMs,
        );
      }

      return continuationState;
    }

    if (continuationState.pendingPromptUpdatedAt === undefined) {
      this.logger.info("Promoted untimestamped pending prompt reservation to last delivered fingerprint.", {
        pendingPromptFingerprint: continuationState.pendingPromptFingerprint,
      });
      return writeContinuationState(
        this.continuationStatePath,
        {
          ...continuationState,
          lastPromptFingerprint: continuationState.pendingPromptFingerprint,
          pendingPromptFingerprint: undefined,
          pendingPromptUpdatedAt: undefined,
        },
        this.commandTimeoutMs,
      );
    }

    const pendingUpdatedAt = Date.parse(continuationState.pendingPromptUpdatedAt);
    if (
      Number.isNaN(pendingUpdatedAt) ||
      Date.now() - pendingUpdatedAt > PENDING_PROMPT_STALE_MS
    ) {
      this.logger.info("Promoted stale pending prompt reservation to last delivered fingerprint.", {
        pendingPromptFingerprint: continuationState.pendingPromptFingerprint,
        pendingPromptUpdatedAt: continuationState.pendingPromptUpdatedAt,
      });
      return writeContinuationState(
        this.continuationStatePath,
        {
          ...continuationState,
          lastPromptFingerprint: continuationState.pendingPromptFingerprint,
          pendingPromptFingerprint: undefined,
          pendingPromptUpdatedAt: undefined,
        },
        this.commandTimeoutMs,
      );
    }

    return continuationState;
  }

  private async getPromptTarget(
    sessionID: string,
    state: SessionState,
  ): Promise<PromptTarget | undefined> {
    if (state.promptTargetReady === undefined) {
      state.promptTargetReady = this.fetchPromptTarget(sessionID)
        .then((promptTarget) => {
          if (promptTarget !== undefined) {
            state.promptTarget = promptTarget;
          }

          return promptTarget;
        })
        .finally(() => {
          state.promptTargetReady = undefined;
        });
    }

    return state.promptTarget ?? await state.promptTargetReady;
  }

  private capturePromptTargetFromEvent(
    state: SessionState,
    event: Extract<ContinuationTriggerEvent, { type: "message.updated" }>,
  ): void {
    const promptTarget = parsePromptTargetFromMessageInfo(event.properties.info);
    if (promptTarget === undefined) {
      return;
    }

    state.promptTarget = {
      agent: promptTarget.agent ?? state.promptTarget?.agent,
      model: promptTarget.model ?? state.promptTarget?.model,
    };
    state.lastTakeoverSignalAt = Date.now();
  }

  private async fetchPromptTarget(sessionID: string): Promise<PromptTarget | undefined> {
    const messages = await fetchSessionMessages(
      this.client,
      sessionID,
      this.cwd,
      SESSION_MESSAGE_RECOVERY_LIMIT,
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const promptTarget = parsePromptTargetFromMessageEnvelope(messages[index]);
      if (promptTarget !== undefined) {
        this.logger.debug("Recovered prompt target from session messages.", {
          agent: promptTarget.agent,
          model: promptTarget.model,
          sessionID,
        });
        return promptTarget;
      }
    }

    this.logger.debug("No prompt target metadata found in recent session messages.", {
      sessionID,
    });
    return undefined;
  }

  private async resolveDecision(): Promise<ContinuationDecision | undefined> {
    const readyIssueProbe = await this.probeReadyIssueAvailability();
    if (readyIssueProbe.kind !== "empty") {
      const priorityOrderSummary = await this.loadPriorityOrderSummary();
      if (priorityOrderSummary.readyIssues.length > 0) {
        this.logger.debug("Selected continuation prompt from ready issues.", {
          readyIssues: priorityOrderSummary.readyIssues,
        });
        return buildIssueDecision(priorityOrderSummary.readyIssues, this.issuePrompt);
      }

      if (readyIssueProbe.kind === "ready") {
        this.logger.info("Ready issue probe changed before priority ordering completed.", {
          readyIssueCount: readyIssueProbe.readyIssueCount,
        });
        return undefined;
      }
    }

    const whipState = await ensureWhipState(this.whipPath, this.commandTimeoutMs);
    const nextTask = selectNextWhipTask(whipState.tasks);
    if (nextTask === undefined) {
      this.logger.debug("No ready issues or whip tasks remain for continuation.");
      return undefined;
    }

    this.logger.debug("Selected continuation prompt from whip queue.", {
      whipTaskID: nextTask.id,
    });

    return buildWhipDecision(nextTask, this.issueCreationTemplate);
  }

  private async probeReadyIssueAvailability(): Promise<{
    kind: "empty" | "ready" | "unknown";
    readyIssueCount?: number;
  }> {
    try {
      const readyIssues = await listReadyIssueNumbers(
        this.cwd,
        this.queueStatusNames,
        this.commandTimeoutMs,
      );
      this.logger.debug("Checked ready GitHub issue availability.", {
        readyIssueCount: readyIssues.length,
      });

      return readyIssues.length === 0
        ? { kind: "empty", readyIssueCount: 0 }
        : { kind: "ready", readyIssueCount: readyIssues.length };
    } catch (error) {
      this.logger.info("Ready issue probe failed; falling back to full priority order summary.", {
        error: formatError(error),
      });
      return { kind: "unknown" };
    }
  }

  private async loadPriorityOrderSummary(): Promise<PriorityOrderSummary> {
    const priorityOrder = await runPriorityOrderScript(
      this.cwd,
      this.priorityOrderScript,
      this.commandTimeoutMs,
    );
    if (priorityOrder.exitCode !== 0) {
      throw new Error(
        `Failed to run ${path.relative(this.cwd, this.priorityOrderScript) || this.priorityOrderScript}: ${priorityOrder.stderr.trim() || `exit code ${priorityOrder.exitCode}`}`,
      );
    }

    this.logger.debug("Priority order script completed.", {
      stderr: truncateForLog(priorityOrder.stderr),
      stdout: truncateForLog(priorityOrder.stdout),
    });

    return parsePriorityOrderSummary(priorityOrder.stdout, this.queueStatusNames);
  }
}

export async function AiUmpireContinuationPlugin(
  context: PluginContext,
): Promise<PluginHooks> {
  const logPath = path.resolve(
    context.worktree ?? context.directory,
    context.continuationLogPath ?? DEFAULT_CONTINUATION_LOG_PATH,
  );
  const logger = new ContinuationLogger(context.logLevel, {
    client: context.client,
    logPath,
  });
  const controller = new ContinuationController(context, logger);
  const seenUnsupportedEventTypes = new Set<string>();

  return {
    event: async ({ event }) => {
      if (!isContinuationTriggerEvent(event)) {
        if (!seenUnsupportedEventTypes.has(event.type)) {
          seenUnsupportedEventTypes.add(event.type);
          logger.debug("Ignoring unsupported event type.", {
            sessionID: event.properties?.sessionID,
            type: event.type,
          });
        }
        return;
      }

      try {
        await controller.handleEvent(event);
      } catch (error) {
        logger.error(formatError(error));
      }
    },
  };
}

export default AiUmpireContinuationPlugin;

async function fetchSessionTodos(
  client: ContinuationClient,
  sessionID: string,
  cwd: string,
): Promise<TodoItem[]> {
  const response = await client.session.todo({
    path: { id: sessionID },
    query: { directory: cwd },
  });

  if (response.error !== undefined) {
    throw new Error(
      formatSessionApiError("fetch todos", sessionID, response),
    );
  }

  return Array.isArray(response.data) ? response.data.map(cloneTodo) : [];
}

type SessionMessageEnvelope = {
  info?: unknown;
  parts?: unknown;
};

async function fetchSessionMessages(
  client: ContinuationClient,
  sessionID: string,
  cwd: string,
  limit: number,
): Promise<SessionMessageEnvelope[]> {
  const response = await client.session.messages({
    path: { id: sessionID },
    query: { directory: cwd, limit },
  });

  if (response.error !== undefined) {
    throw new Error(formatSessionApiError("fetch session messages", sessionID, response));
  }

  return Array.isArray(response.data) ? response.data as SessionMessageEnvelope[] : [];
}

async function fetchSessionLastActivityAt(
  logger: ContinuationLogger,
  client: ContinuationClient,
  continuationState: ContinuationState,
  sessionID: string,
  cwd: string,
  limit: number,
): Promise<number | undefined> {
  try {
    const messages = await fetchSessionMessages(client, sessionID, cwd, limit);
    let latest = 0;

    for (const message of messages) {
      const timestamp = getMessageActivityTimestamp(message);
      if (timestamp !== undefined) {
        latest = Math.max(latest, timestamp);
      }
    }

    if (latest > 0) {
      return latest;
    }
  } catch (error) {
    logger.debug("Falling back to persisted continuation timestamp after failing to read owner session activity.", {
      error: formatError(error),
      ownerSessionID: sessionID,
    });
  }

  const persistedUpdatedAt = Date.parse(continuationState.updatedAt);
  if (Number.isNaN(persistedUpdatedAt)) {
    return undefined;
  }

  logger.debug("Falling back to persisted continuation timestamp for owner session activity.", {
    ownerSessionID: sessionID,
    updatedAt: continuationState.updatedAt,
  });
  return persistedUpdatedAt;
}

async function promptSession(
  client: ContinuationClient,
  sessionID: string,
  cwd: string,
  prompt: string,
  promptTarget?: PromptTarget,
): Promise<void> {
  const response = await client.session.promptAsync({
    body: {
      agent: promptTarget?.agent,
      model: promptTarget?.model,
      parts: [{ text: prompt, type: "text" }],
    },
    path: { id: sessionID },
    query: { directory: cwd },
  });

  if (response.error !== undefined) {
    throw new Error(
      formatSessionApiError("enqueue continuation prompt", sessionID, response),
    );
  }
}

async function runPriorityOrderScript(
  cwd: string,
  scriptPath: string,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<CommandRunResult> {
  return runCommand("bash", [scriptPath, "--json"], cwd, commandTimeoutMs);
}

async function listReadyIssueNumbers(
  cwd: string,
  queueStatusNames: QueueStatusNames,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<number[]> {
  const result = await runCommand(
    "gh",
    ["issue", "list", "--state", "open", "--limit", "100", "--json", "number,labels"],
    cwd,
    commandTimeoutMs,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to probe ready GitHub issues: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
    );
  }

  return parseReadyIssueNumbers(result.stdout, queueStatusNames);
}

async function fetchSessionInfo(
  client: ContinuationClient,
  sessionID: string,
  cwd: string,
  options: { allowMissing?: boolean } = {},
): Promise<{ id: string; parentID?: string } | undefined> {
  const response = await client.session.get({
    path: { id: sessionID },
    query: { directory: cwd },
  });

  if (response.error !== undefined) {
    if (options.allowMissing && isMissingSessionResponse(response)) {
      return undefined;
    }

    throw new Error(formatSessionApiError("fetch session", sessionID, response));
  }

  return parseSessionInfo(response.data, sessionID);
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<CommandRunResult> {
  return await new Promise<CommandRunResult>((resolve, reject) => {
    const maxBufferBytes = 10 * 1024 * 1024;
    let settled = false;
    let timedOut = false;
    let outputOverflowed = false;
    let stdout = "";
    let stderr = "";

    const finish = (result: CommandRunResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    };

    const timeoutMessage = `Command ${command} timed out after ${commandTimeoutMs}ms and was killed with ${COMMAND_TIMEOUT_KILL_SIGNAL}.`;
    const overflowMessage = `Command ${command} exceeded the ${maxBufferBytes} byte output buffer and was killed with ${COMMAND_TIMEOUT_KILL_SIGNAL}.`;
    const child = spawn(
      command,
      [...args],
      {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const appendOutput = (target: "stderr" | "stdout", chunk: string | Buffer): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (target === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }

      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > maxBufferBytes) {
        outputOverflowed = true;
        killCommandProcessTree(child, COMMAND_TIMEOUT_KILL_SIGNAL);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      appendOutput("stdout", chunk);
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      appendOutput("stderr", chunk);
    });

    child.once("error", (error: Error) => {
      fail(error);
    });

    child.once("close", (code: number | null) => {
      if (timedOut) {
        finish({
          exitCode: COMMAND_TIMEOUT_EXIT_CODE,
          stderr: stderr.length > 0 ? `${timeoutMessage}\n${stderr}` : timeoutMessage,
          stdout,
        });
        return;
      }

      if (outputOverflowed) {
        finish({
          exitCode: 1,
          stderr: stderr.length > 0 ? `${overflowMessage}\n${stderr}` : overflowMessage,
          stdout,
        });
        return;
      }

      finish({
        exitCode: typeof code === "number" ? code : 1,
        stderr,
        stdout,
      });
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killCommandProcessTree(child, COMMAND_TIMEOUT_KILL_SIGNAL);
    }, commandTimeoutMs);
    timeoutHandle.unref?.();
  });
}

function buildIssueDecision(
  readyIssues: readonly number[],
  issuePrompt: string,
): ContinuationDecision {
  return {
    fingerprint: `issues:${readyIssues.join(",")}`,
    kind: "issue",
    prompt: issuePrompt,
  };
}

function buildWhipDecision(
  nextTask: WhipTask,
  issueCreationTemplate: string,
): ContinuationDecision {
  return {
    fingerprint: `whip:${nextTask.id}`,
    kind: "whip",
    prompt: buildWhipTaskPrompt(nextTask, issueCreationTemplate),
    whipTaskID: nextTask.id,
  };
}

function parseReadyIssueNumbers(output: string, queueStatusNames: QueueStatusNames): number[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error(`Invalid ready issue JSON: ${formatError(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid ready issue list.");
  }

  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || !("number" in entry) || !("labels" in entry)) {
      throw new Error("Invalid ready issue entry.");
    }

    const issue = entry as { labels?: unknown; number?: unknown };
    const number = issue.number;
    if (!isPositiveInteger(number)) {
      throw new Error("Invalid ready issue number.");
    }

    const labels = parseIssueLabelNames(issue.labels);
    const status = resolveEffectiveIssueStatus(labels, queueStatusNames);
    return status === queueStatusNames.ready ? [number] : [];
  });
}

function parseIssueLabelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("Invalid ready issue labels.");
  }

  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null || !("name" in entry)) {
      throw new Error("Invalid ready issue label.");
    }

    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Invalid ready issue label name.");
    }

    return name;
  });
}

function resolveEffectiveIssueStatus(
  labelNames: readonly string[],
  queueStatusNames: QueueStatusNames,
): string {
  for (const labelName of labelNames) {
    if (queueStatusNames.all.includes(labelName)) {
      return labelName;
    }
  }

  return queueStatusNames.defaultStatus;
}

function parsePriorityOrderSummary(output: string, queueStatusNames: QueueStatusNames): PriorityOrderSummary {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error(`Invalid priority order JSON: ${formatError(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid priority order summary.");
  }

  const summary = parsed as {
    blockedIssues?: unknown;
    inProgress?: unknown;
    issues?: unknown;
    nextIssue?: unknown;
    readyIssues?: unknown;
    version?: unknown;
  };

  if (summary.version !== 1) {
    throw new Error("Invalid priority order summary version.");
  }

  const issues = parsePriorityOrderIssues(summary.issues);
  const parsedSummary: PriorityOrderSummary = {
    blockedIssues: parsePriorityOrderIssueNumbers(summary.blockedIssues, "blockedIssues"),
    inProgress: parsePriorityOrderIssueNumbers(summary.inProgress, "inProgress"),
    issues,
    nextIssue: parsePriorityOrderOptionalIssueNumber(summary.nextIssue, "nextIssue"),
    readyIssues: parsePriorityOrderIssueNumbers(summary.readyIssues, "readyIssues"),
    version: 1,
  };

  assertPriorityOrderSummaryConsistency(parsedSummary, queueStatusNames);
  return parsedSummary;
}

function parsePriorityOrderIssues(raw: unknown): PriorityOrderIssue[] {
  if (!Array.isArray(raw)) {
    throw new Error("Invalid priority order summary issues.");
  }

  return raw.map((issue, index) => parsePriorityOrderIssue(issue, index));
}

function parsePriorityOrderIssue(raw: unknown, index: number): PriorityOrderIssue {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid priority order issue at index ${index}.`);
  }

  const issue = raw as {
    component?: unknown;
    labels?: unknown;
    number?: unknown;
    priority?: unknown;
    score?: unknown;
    status?: unknown;
    title?: unknown;
  };

  if (typeof issue.component !== "string") {
    throw new Error(`Invalid priority order issue component at index ${index}.`);
  }

  if (!Array.isArray(issue.labels) || issue.labels.some((label) => typeof label !== "string" || label.length === 0)) {
    throw new Error(`Invalid priority order issue labels at index ${index}.`);
  }

  if (!isPositiveInteger(issue.number)) {
    throw new Error(`Invalid priority order issue number at index ${index}.`);
  }

  if (typeof issue.priority !== "string" || issue.priority.length === 0) {
    throw new Error(`Invalid priority order issue priority at index ${index}.`);
  }

  if (typeof issue.score !== "number" || !Number.isInteger(issue.score)) {
    throw new Error(`Invalid priority order issue score at index ${index}.`);
  }

  const labels = issue.labels.slice();
  const score = issue.score;

  if (typeof issue.status !== "string" || issue.status.length === 0) {
    throw new Error(`Invalid priority order issue status at index ${index}.`);
  }

  if (typeof issue.title !== "string" || issue.title.length === 0) {
    throw new Error(`Invalid priority order issue title at index ${index}.`);
  }

  return {
    component: issue.component,
    labels,
    number: issue.number,
    priority: issue.priority,
    score,
    status: issue.status,
    title: issue.title,
  };
}

function parsePriorityOrderIssueNumbers(raw: unknown, fieldName: string): number[] {
  if (!Array.isArray(raw) || raw.some((value) => !isPositiveInteger(value))) {
    throw new Error(`Invalid priority order summary ${fieldName}.`);
  }

  return raw;
}

function parsePriorityOrderOptionalIssueNumber(raw: unknown, fieldName: string): number | null {
  if (raw === null) {
    return null;
  }

  if (!isPositiveInteger(raw)) {
    throw new Error(`Invalid priority order summary ${fieldName}.`);
  }

  return raw;
}

function assertPriorityOrderSummaryConsistency(
  summary: PriorityOrderSummary,
  queueStatusNames: QueueStatusNames,
): void {
  const expectedReadyIssues = summary.issues
    .filter((issue) => issue.status === queueStatusNames.ready)
    .map((issue) => issue.number);
  if (!areNumberArraysEqual(summary.readyIssues, expectedReadyIssues)) {
    throw new Error("Invalid priority order summary readyIssues.");
  }

  const expectedBlockedIssues = summary.issues
    .filter((issue) => issue.status === queueStatusNames.blocked)
    .map((issue) => issue.number);
  if (!areNumberArraysEqual(summary.blockedIssues, expectedBlockedIssues)) {
    throw new Error("Invalid priority order summary blockedIssues.");
  }

  const expectedInProgress = summary.issues
    .filter((issue) => issue.status === queueStatusNames.inProgress)
    .map((issue) => issue.number);
  if (!areNumberArraysEqual(summary.inProgress, expectedInProgress)) {
    throw new Error("Invalid priority order summary inProgress.");
  }

  const expectedNextIssue = summary.issues.find(
    (issue) => issue.status !== queueStatusNames.inProgress && issue.status !== queueStatusNames.blocked,
  )?.number ?? null;
  if (summary.nextIssue !== expectedNextIssue) {
    throw new Error("Invalid priority order summary nextIssue.");
  }
}

function areNumberArraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hasActiveTodos(todos: readonly TodoItem[]): boolean {
  return todos.some((todo) => !["cancelled", "completed"].includes(todo.status));
}

function countActiveTodos(todos: readonly TodoItem[]): number {
  return todos.filter((todo) => !["cancelled", "completed"].includes(todo.status)).length;
}

function hasFreshTakeoverSignal(state: SessionState, observedAt: number): boolean {
  return (
    state.lastTakeoverSignalAt !== undefined &&
    observedAt - state.lastTakeoverSignalAt <= RECENT_OWNER_HANDOFF_QUIET_MS
  );
}

function buildWhipTaskPrompt(task: WhipTask, issueCreationTemplate: string): string {
  return [
    "Continue the selected WHIP backlog task.",
    "The plugin tracks WHIP state and selects the next task. Focus only on the task in this prompt.",
    `Selected task: ${task.title}.`,
    task.prompt,
    issueCreationTemplate,
    "Rules:",
    WHIP_WORKFLOW_RULES,
    "* Create GitHub issues for actionable findings instead of writing extra documentation",
    "* Do not choose, reorder, or track other WHIP tasks yourself; the plugin will inject the next selected task later",
    "Go.",
  ].join("\n");
}

async function ensureContinuationState(
  continuationStatePath: string,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<ContinuationState> {
  await ensureManagedStateRoot(path.dirname(path.dirname(continuationStatePath)), commandTimeoutMs);

  try {
    const raw = await readFile(continuationStatePath, "utf8");
    return parseContinuationState(raw);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const state: ContinuationState = {
    updatedAt: new Date().toISOString(),
    version: 1,
  };

  await writeContinuationState(continuationStatePath, state, commandTimeoutMs);
  return state;
}

async function writeContinuationState(
  continuationStatePath: string,
  state: Omit<ContinuationState, "updatedAt" | "version"> &
    Partial<Pick<ContinuationState, "updatedAt" | "version">>,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<ContinuationState> {
  await ensureManagedStateRoot(path.dirname(path.dirname(continuationStatePath)), commandTimeoutMs);

  const nextState: ContinuationState = {
    activeWhipTaskID: state.activeWhipTaskID,
    lastPromptFingerprint: state.lastPromptFingerprint,
    ownerSessionID: state.ownerSessionID,
    pendingPromptFingerprint: state.pendingPromptFingerprint,
    pendingPromptUpdatedAt: state.pendingPromptUpdatedAt,
    pendingWhipTaskID: state.pendingWhipTaskID,
    updatedAt: new Date().toISOString(),
    version: 1,
  };

  await mkdir(path.dirname(continuationStatePath), { recursive: true });
  await writeFile(continuationStatePath, JSON.stringify(nextState, null, 2).concat("\n"), "utf8");
  return nextState;
}

async function withContinuationLock<T>(
  continuationLockPath: string,
  logger: ContinuationLogger,
  callback: () => Promise<T>,
): Promise<{ acquired: boolean; value?: T }> {
  const lockToken = await tryAcquireContinuationLock(continuationLockPath, logger);
  if (lockToken === undefined) {
    logger.debug("Continuation lock acquisition failed because the lock file already exists.", {
      continuationLockPath,
    });
    return { acquired: false };
  }

  try {
    return {
      acquired: true,
      value: await callback(),
    };
  } finally {
    await releaseContinuationLock(continuationLockPath, lockToken);
  }
}

async function tryAcquireContinuationLock(
  continuationLockPath: string,
  logger: ContinuationLogger,
): Promise<string | undefined> {
  return tryAcquireContinuationLockOnce(continuationLockPath, logger, true);
}

async function tryAcquireContinuationLockOnce(
  continuationLockPath: string,
  logger: ContinuationLogger,
  allowStaleRecovery: boolean,
): Promise<string | undefined> {
  await mkdir(path.dirname(continuationLockPath), { recursive: true });
  const lockToken = randomUUID();

  try {
    await writeFile(continuationLockPath, lockToken, { encoding: "utf8", flag: "wx" });
    return lockToken;
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      const staleLockAgeMs = allowStaleRecovery
        ? await recoverStaleContinuationLock(continuationLockPath)
        : undefined;
      if (staleLockAgeMs !== undefined) {
        logger.info("Removed stale continuation lock before retrying acquisition.", {
          continuationLockPath,
          staleLockAgeMs: Math.round(staleLockAgeMs),
        });
        return tryAcquireContinuationLockOnce(continuationLockPath, logger, false);
      }

      return undefined;
    }

    throw error;
  }
}

async function recoverStaleContinuationLock(
  continuationLockPath: string,
): Promise<number | undefined> {
  try {
    const lockStats = await stat(continuationLockPath);
    const lockAgeMs = Date.now() - lockStats.mtimeMs;
    if (lockAgeMs <= CONTINUATION_LOCK_STALE_MS) {
      return undefined;
    }

    await rm(continuationLockPath, { force: true, recursive: true });
    return lockAgeMs;
  } catch (error) {
    if (isMissingFileError(error)) {
      return CONTINUATION_LOCK_STALE_MS + 1;
    }

    throw error;
  }
}

async function releaseContinuationLock(
  continuationLockPath: string,
  lockToken: string,
): Promise<void> {
  try {
    const owner = await readFile(continuationLockPath, "utf8");
    if (owner !== lockToken) {
      return;
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  await rm(continuationLockPath, { force: true, recursive: true });
}

async function ensureWhipState(
  whipPath: string,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<WhipState> {
  await ensureManagedStateRoot(path.dirname(path.dirname(whipPath)), commandTimeoutMs);

  try {
    const raw = await readFile(whipPath, "utf8");
    return parseWhipState(raw);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const createdAt = new Date().toISOString();
  const state: WhipState = {
    createdAt,
    tasks: INITIAL_WHIP_TASKS.map((task) => ({ ...task })),
    updatedAt: createdAt,
    version: 1,
  };

  await mkdir(path.dirname(whipPath), { recursive: true });
  await writeFile(whipPath, JSON.stringify(state, null, 2).concat("\n"), "utf8");
  return state;
}

async function ensureManagedStateRoot(
  repoRoot: string,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<void> {
  const cacheKey = getManagedStateRootCacheKey(repoRoot, commandTimeoutMs);
  const existing = managedStateRootReady.get(cacheKey);
  if (existing !== undefined) {
    return existing;
  }

  const pending = ensureManagedStateRootOnce(repoRoot, commandTimeoutMs).catch((error) => {
    managedStateRootReady.delete(cacheKey);
    throw error;
  });
  managedStateRootReady.set(cacheKey, pending);
  return pending;
}

async function ensureManagedStateRootOnce(
  repoRoot: string,
  commandTimeoutMs: number,
): Promise<void> {
  await ensureManagedStateIgnored(repoRoot, commandTimeoutMs);
  await mkdir(path.join(repoRoot, ".umpire"), { recursive: true });
  await assertManagedStateUntracked(repoRoot, commandTimeoutMs);
}

async function ensureManagedStateIgnored(
  repoRoot: string,
  commandTimeoutMs: number,
): Promise<void> {
  const ignoreEntry = ".umpire/";
  await ensureIgnoreEntry(path.join(repoRoot, ".gitignore"), ignoreEntry);

  const gitDir = await resolveGitDir(repoRoot, commandTimeoutMs);
  if (gitDir !== undefined) {
    await ensureIgnoreEntry(path.join(gitDir, "info", "exclude"), ignoreEntry);
  }
}

async function ensureIgnoreEntry(filePath: string, ignoreEntry: string): Promise<void> {
  let existing = "";

  try {
    existing = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const entries = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (entries.includes(ignoreEntry)) {
    return;
  }

  const next = existing.length === 0
    ? `${ignoreEntry}\n`
    : `${existing.replace(/\s*$/u, "")}\n${ignoreEntry}\n`;

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, next, "utf8");
}

async function assertManagedStateUntracked(
  repoRoot: string,
  commandTimeoutMs: number,
): Promise<void> {
  const trackedPaths = await listTrackedManagedStatePaths(repoRoot, commandTimeoutMs);
  if (trackedPaths.length === 0) {
    return;
  }

  throw new Error(
    `Refusing continuation because plugin-managed state is tracked by git: ${trackedPaths.join(", ")}. Remove it from the index (for example: git rm --cached -- ${trackedPaths.join(" ")}) and keep .umpire/ ignored.`,
  );
}

async function listTrackedManagedStatePaths(
  repoRoot: string,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<string[]> {
  const result = await runCommand("git", ["ls-files", "--", ".umpire"], repoRoot, commandTimeoutMs);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    if (stderr.includes("not a git repository")) {
      return [];
    }

    throw new Error(stderr.length > 0 ? stderr : "Failed to inspect tracked .umpire state.");
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function resolveGitDir(
  repoRoot: string,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<string | undefined> {
  const result = await runCommand("git", ["rev-parse", "--git-dir"], repoRoot, commandTimeoutMs);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    if (stderr.includes("not a git repository")) {
      return undefined;
    }

    throw new Error(stderr.length > 0 ? stderr : "Failed to resolve git directory.");
  }

  const gitDir = result.stdout.trim();
  if (gitDir.length === 0) {
    return undefined;
  }

  return path.isAbsolute(gitDir) ? gitDir : path.resolve(repoRoot, gitDir);
}

async function updateWhipTaskStatus(
  whipPath: string,
  taskID: string,
  status: WhipTask["status"],
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<WhipState> {
  const state = await ensureWhipState(whipPath, commandTimeoutMs);
  const tasks = state.tasks.map((task) => task.id === taskID ? { ...task, status } : task);

  if (tasks.every((task, index) => task.status === state.tasks[index]?.status)) {
    return state;
  }

  const nextState: WhipState = {
    ...state,
    tasks,
    updatedAt: new Date().toISOString(),
  };

  await writeFile(whipPath, JSON.stringify(nextState, null, 2).concat("\n"), "utf8");
  return nextState;
}

function parseWhipState(raw: string): WhipState {
  const parsed = JSON.parse(raw) as Partial<WhipState>;
  if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
    throw new Error("Invalid .umpire/whip.json state.");
  }

  const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
  const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
  if (createdAt.length === 0 || updatedAt.length === 0) {
    throw new Error("Invalid .umpire/whip.json timestamps.");
  }

  return {
    createdAt,
    tasks: parsed.tasks.map(parseWhipTask),
    updatedAt,
    version: 1,
  };
}

function parseContinuationState(raw: string): ContinuationState {
  const parsed = JSON.parse(raw) as Partial<ContinuationState>;
  if (parsed.version !== 1) {
    throw new Error("Invalid .umpire/continuation-state.json state.");
  }

  const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
  if (updatedAt.length === 0) {
    throw new Error("Invalid .umpire/continuation-state.json timestamp.");
  }

  if (parsed.activeWhipTaskID !== undefined && typeof parsed.activeWhipTaskID !== "string") {
    throw new Error("Invalid .umpire/continuation-state.json active task.");
  }

  if (
    parsed.lastPromptFingerprint !== undefined &&
    typeof parsed.lastPromptFingerprint !== "string"
  ) {
    throw new Error("Invalid .umpire/continuation-state.json fingerprint.");
  }

  if (parsed.ownerSessionID !== undefined && typeof parsed.ownerSessionID !== "string") {
    throw new Error("Invalid .umpire/continuation-state.json owner.");
  }

  if (
    parsed.pendingPromptFingerprint !== undefined &&
    typeof parsed.pendingPromptFingerprint !== "string"
  ) {
    throw new Error("Invalid .umpire/continuation-state.json pending fingerprint.");
  }

  if (
    parsed.pendingPromptUpdatedAt !== undefined &&
    typeof parsed.pendingPromptUpdatedAt !== "string"
  ) {
    throw new Error("Invalid .umpire/continuation-state.json pending timestamp.");
  }

  if (parsed.pendingWhipTaskID !== undefined && typeof parsed.pendingWhipTaskID !== "string") {
    throw new Error("Invalid .umpire/continuation-state.json pending whip task.");
  }

  return {
    activeWhipTaskID: parsed.activeWhipTaskID,
    lastPromptFingerprint: parsed.lastPromptFingerprint,
    ownerSessionID: parsed.ownerSessionID,
    pendingPromptFingerprint: parsed.pendingPromptFingerprint,
    pendingPromptUpdatedAt: parsed.pendingPromptUpdatedAt,
    pendingWhipTaskID: parsed.pendingWhipTaskID,
    updatedAt,
    version: 1,
  };
}

function parseSessionInfo(
  raw: unknown,
  sessionID: string,
): { id: string; parentID?: string } {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid session payload for ${sessionID}.`);
  }

  const info = raw as { id?: unknown; parentID?: unknown };
  if (typeof info.id !== "string" || info.id.length === 0) {
    throw new Error(`Invalid session identity for ${sessionID}.`);
  }

  if (info.parentID !== undefined && typeof info.parentID !== "string") {
    throw new Error(`Invalid session parent for ${sessionID}.`);
  }

  return {
    id: info.id,
    parentID: info.parentID,
  };
}

function parsePromptTargetFromMessageEnvelope(envelope: SessionMessageEnvelope): PromptTarget | undefined {
  if (typeof envelope !== "object" || envelope === null || !("info" in envelope)) {
    return undefined;
  }

  return parsePromptTargetFromMessageInfo(envelope.info);
}

function getMessageActivityTimestamp(envelope: SessionMessageEnvelope): number | undefined {
  if (typeof envelope !== "object" || envelope === null || !("info" in envelope)) {
    return undefined;
  }

  const info = envelope.info;
  if (typeof info !== "object" || info === null || !("time" in info)) {
    return undefined;
  }

  const time = info.time;
  if (typeof time !== "object" || time === null) {
    return undefined;
  }

  const created = "created" in time && typeof time.created === "number" ? time.created : undefined;
  const completed = "completed" in time && typeof time.completed === "number" ? time.completed : undefined;

  return completed ?? created;
}

function parsePromptTargetFromMessageInfo(info: unknown): PromptTarget | undefined {
  if (typeof info !== "object" || info === null) {
    return undefined;
  }

  const entry = info as {
    agent?: unknown;
    model?: unknown;
    modelID?: unknown;
    providerID?: unknown;
  };
  const agent = typeof entry.agent === "string" && entry.agent.length > 0 ? entry.agent : undefined;
  const model = parsePromptModel(entry.model) ?? parsePromptModel(entry);

  if (agent === undefined && model === undefined) {
    return undefined;
  }

  return { agent, model };
}

function parsePromptModel(value: unknown): PromptModel | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as { modelID?: unknown; providerID?: unknown };
  if (typeof record.modelID !== "string" || record.modelID.length === 0) {
    return undefined;
  }

  if (typeof record.providerID !== "string" || record.providerID.length === 0) {
    return undefined;
  }

  return {
    modelID: record.modelID,
    providerID: record.providerID,
  };
}

function isPendingPromptFresh(pendingPromptUpdatedAt: string | undefined): boolean {
  if (pendingPromptUpdatedAt === undefined) {
    return false;
  }

  const updatedAt = Date.parse(pendingPromptUpdatedAt);
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  return Date.now() - updatedAt <= PENDING_PROMPT_STALE_MS;
}

function selectNextWhipTask(tasks: readonly WhipTask[]): WhipTask | undefined {
  return [...tasks]
    .filter((task) => !["cancelled", "completed"].includes(task.status))
    .sort(compareWhipTasks)[0];
}

function compareWhipTasks(left: WhipTask, right: WhipTask): number {
  return (
    getTaskStatusWeight(right.status) - getTaskStatusWeight(left.status) ||
    getTaskPriorityWeight(right.priority) - getTaskPriorityWeight(left.priority)
  );
}

function getTaskStatusWeight(status: WhipTask["status"]): number {
  switch (status) {
    case "in_progress":
      return 2;
    case "pending":
      return 1;
    case "cancelled":
    case "completed":
      return 0;
  }
}

function getTaskPriorityWeight(priority: WhipTask["priority"]): number {
  switch (priority) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function parseWhipTask(task: unknown): WhipTask {
  if (typeof task !== "object" || task === null) {
    throw new Error("Invalid .umpire/whip.json task entry.");
  }

  const entry = task as Partial<WhipTask>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.priority !== "string" ||
    typeof entry.prompt !== "string" ||
    typeof entry.status !== "string" ||
    typeof entry.title !== "string"
  ) {
    throw new Error("Invalid .umpire/whip.json task shape.");
  }

  if (!["high", "medium", "low"].includes(entry.priority)) {
    throw new Error("Invalid .umpire/whip.json task priority.");
  }

  if (!["cancelled", "completed", "in_progress", "pending"].includes(entry.status)) {
    throw new Error("Invalid .umpire/whip.json task status.");
  }

  return {
    id: entry.id,
    priority: entry.priority,
    prompt: entry.prompt,
    status: entry.status,
    title: entry.title,
  };
}

function cloneTodo(todo: TodoItem): TodoItem {
  return {
    content: todo.content,
    id: todo.id,
    priority: todo.priority,
    status: todo.status,
  };
}

function getContinuationEventSessionID(event: ContinuationTriggerEvent): string {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID;
    case "session.idle":
    case "session.status":
    case "todo.updated":
    case "tui.command.execute":
    case "tui.prompt.append":
    case "tui.session.select":
    case "tui.toast.show":
      return event.properties.sessionID;
  }
}

function shouldPrepareDecision(event: ContinuationTriggerEvent, state: SessionState): boolean {
  if (event.type === "todo.updated") {
    return !hasActiveTodos(state.todos ?? []);
  }

  return isAssistantMessageEvent(event);
}

function isAssistantMessageEvent(
  event: ContinuationTriggerEvent,
): event is Extract<ContinuationTriggerEvent, { type: "message.updated" }> {
  return event.type === "message.updated" && event.properties.info.role === "assistant";
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function normalizeCommandTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }

  return Math.max(1, Math.floor(value));
}

function getManagedStateRootCacheKey(repoRoot: string, commandTimeoutMs: number): string {
  return `${repoRoot}\u0000${commandTimeoutMs}`;
}

function killCommandProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;
  if (pid === undefined) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (!isMissingProcessError(error)) {
        try {
          child.kill(signal);
        } catch {
          return;
        }
      }
      return;
    }
  }

  try {
    const taskkill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.unref();
    return;
  } catch {
  }

  try {
    child.kill(signal);
  } catch {
    return;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "NotFoundError";
}

function isMissingSessionResponse(response: ContinuationResponse): boolean {
  return response.response?.status === 404 || isNotFoundError(response.error);
}

function formatSessionApiError(
  action: string,
  sessionID: string,
  response: ContinuationResponse,
): string {
  const details: string[] = [];
  const status = response.response?.status;
  if (typeof status === "number") {
    details.push(`status ${status}`);
  }

  const url = response.response?.url ?? response.request?.url;
  if (typeof url === "string" && url.length > 0) {
    details.push(url);
  }

  const errorSummary = summarizeUnknown(response.error);
  if (errorSummary.length > 0) {
    details.push(`error=${errorSummary}`);
  }

  if (details.length === 0) {
    return `Failed to ${action} for session ${sessionID}.`;
  }

  return `Failed to ${action} for session ${sessionID} (${details.join("; ")}).`;
}

function summarizeUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

class ContinuationLogger {
  private readonly client?: ContinuationClient;

  private readonly logPath?: string;

  private readonly logLevel: ContinuationLogLevel;

  constructor(
    logLevel: ContinuationLogLevel | undefined,
    options: { client?: ContinuationClient; logPath?: string } = {},
  ) {
    this.client = options.client;
    this.logPath = options.logPath;
    this.logLevel = logLevel ?? "silent";
  }

  debug(message: string, details?: Record<string, unknown>): void {
    if (!this.isEnabled("debug")) {
      return;
    }

    this.write("debug", message, details);
  }

  error(message: string): void {
    this.write("error", message);
  }

  info(message: string, details?: Record<string, unknown>): void {
    if (!this.isEnabled("info")) {
      return;
    }

    this.write("info", message, details);
  }

  private isEnabled(level: "debug" | "info"): boolean {
    switch (this.logLevel) {
      case "debug":
        return true;
      case "info":
        return level === "info";
      case "silent":
        return false;
    }
  }

  private write(
    level: "debug" | "error" | "info",
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const line = level === "error"
      ? `[ai-umpire-continuation] ${message}`
      : formatLoggerLine(level, message, details);
    this.writeToClient(level, line);
    this.writeToDisk(line);
  }

  private writeToClient(level: "debug" | "error" | "info", message: string): void {
    try {
      this.client?.app?.log?.({ body: { level, message } });
    } catch {
    }
  }

  private writeToDisk(message: string): void {
    if (this.logPath === undefined) {
      return;
    }

    void mkdir(path.dirname(this.logPath), { recursive: true })
      .then(() => appendFile(this.logPath!, `${message}\n`, "utf8"))
      .catch(() => undefined);
  }
}

function formatLoggerLine(
  level: "debug" | "info",
  message: string,
  details?: Record<string, unknown>,
): string {
  const suffix = details === undefined ? "" : ` ${summarizeUnknown(normalizeLogDetails(details))}`;
  return `[ai-umpire-continuation:${level}] ${message}${suffix}`;
}

function normalizeLogDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === "string" ? truncateForLog(value) : value]),
  );
}

function truncateForLog(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
