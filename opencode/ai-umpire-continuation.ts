import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PluginContext {
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

interface PriorityOrderSummary {
  readyIssues: number[];
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

const ISSUE_CREATION_TEMPLATE = [
  "## GitHub Issue Creation Rules (ALWAYS FOLLOW)",
  "* Before creating issues, ensure the core queue labels exist by running `./scripts/gh-ensure-labels.sh`.",
  "* Every created issue must have exactly one priority label: `P1-Critical`, `P2-High`, `P3-Medium`, or `P4-Low`.",
  "* Every created issue must have exactly one status label: `S-Ready`, `S-Blocked`, or `S-Blocking`. Do not create fresh issues directly as `S-InProgress`.",
  "* Add one `C-*` component label only if the repository already has a stable component taxonomy. Do not copy component or epic labels from another repository.",
  "* Keep dependencies explicit with one `Blocked by: #N` line per blocker in the issue body.",
  "* If the repository already uses `Sequence:` metadata to steer queue order, include it. Otherwise omit it.",
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
  "Blocked by: #<N>",
  "```",
].join("\n");

const COMMON_WORKFLOW_RULES = [
  "* Never ask questions - make decisions according to project rules and continue",
  "* Think holistically - consider system-wide impact, not just the immediate issue",
  "* If `AGENTS.md` exists, follow its Four Golden Rules and Ship Sequence. If it does not exist, follow the built-in workflow rules in this prompt.",
  "* Never stage, commit, or push `.umpire/**` files. They are plugin-managed local state.",
].join("\n");

const ISSUE_WORKFLOW_RULES = [
  COMMON_WORKFLOW_RULES,
  "* git commit, push, pr, merge to ship immediately when everything is done - no confirmations, no approvals needed",
  "* @scripts/gh-priority-order.sh -> start next S-Ready issue -> implement -> UI audit -> Oracle -> test -> cubic -> e2e when relevant -> PR + 10 min review -> ship -> repeat.",
].join("\n");

const WHIP_WORKFLOW_RULES = [
  COMMON_WORKFLOW_RULES,
  "* Focus on backlog triage only: audit the repository, create GitHub issues, and report evidence.",
  "* Do not commit, push, open PRs, or merge as part of a `.umpire` backlog task.",
  "* The plugin manages `.umpire/whip.json` task state automatically. Do not edit `.umpire/**` yourself.",
].join("\n");

const ISSUE_PROMPT = [
  "Continue solving open issues from gh-priority-order.sh. You are a trusted autonomous professional developer with full authority. Search for information. Analyze the issue. Work to completion. Execute without pause.",
  "Rules:",
  ISSUE_WORKFLOW_RULES,
  ISSUE_CREATION_TEMPLATE,
  ISSUE_TODO_TEMPLATE,
  "Go.",
].join("\n");

const PENDING_PROMPT_STALE_MS = 5 * 60_000;

const CONTINUATION_LOCK_STALE_MS = 2 * 60_000;

const OWNER_SESSION_STALE_MS = 10 * 60_000;

const RECENT_OWNER_HANDOFF_QUIET_MS = 20_000;

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
    prompt:
      "Review the last 20 pull requests. Find open review threads or materially late review comments that were not resolved, then create GitHub issues for every actionable gap.",
    status: "pending",
    title: "Audit the last 20 pull requests for unresolved review feedback",
  },
  {
    id: "validate-aiq-nine-stages",
    priority: "high",
    prompt:
      "Check whether the project uses the @tjalve/aiq npm package. If it does, create GitHub issues that validate all 9 AIQ stages in the current codebase and CI flow.",
    status: "pending",
    title: "Create validation issues for all 9 AIQ stages when @tjalve/aiq is in use",
  },
  {
    id: "review-duplication-and-tech-debt",
    priority: "medium",
    prompt:
      "Critically review code duplication, redundancy, and technical debt. Create GitHub issues for safe, scoped improvements that materially improve maintainability.",
    status: "pending",
    title: "Create improvement issues for duplication, redundancy, and tech debt",
  },
  {
    id: "audit-test-integrity",
    priority: "high",
    prompt:
      "Audit the test suite for cheating or fake coverage, especially mocked or non-real end-to-end tests that do not exercise the actual feature path. Create GitHub issues for every misleading test pattern you find.",
    status: "pending",
    title: "Create issues for cheating, fake, or over-mocked tests, especially e2e tests",
  },
  {
    id: "review-performance-issues",
    priority: "medium",
    prompt:
      "Review the codebase for performance issues and worthwhile performance improvements. Create GitHub issues for concrete bottlenecks, wasteful work, and measurable optimization opportunities.",
    status: "pending",
    title: "Create performance issues and improvement opportunities",
  },
  {
    id: "review-memory-leaks",
    priority: "medium",
    prompt:
      "Inspect the codebase for memory leaks, resource leaks, and lifetime-management bugs. Create GitHub issues for every concrete leak risk or cleanup gap you find.",
    status: "pending",
    title: "Create issues for memory leaks and resource cleanup problems",
  },
  {
    id: "review-error-handling",
    priority: "medium",
    prompt:
      "Review the codebase for inconsistent error handling, swallowed failures, and unclear failure paths. Create GitHub issues for each actionable inconsistency.",
    status: "pending",
    title: "Create issues for inconsistent error handling",
  },
  {
    id: "review-logging-gaps",
    priority: "medium",
    prompt:
      "Review the codebase for inconsistent logging, missing operational logging, and logs that are too noisy or not actionable. Create GitHub issues for each meaningful logging gap.",
    status: "pending",
    title: "Create issues for inconsistent or missing logging",
  },
];

const managedStateRootReady = new Map<string, Promise<void>>();

export class ContinuationController {
  private readonly client: ContinuationClient;

  private readonly continuationLockPath: string;

  private readonly continuationStatePath: string;

  private readonly cwd: string;

  private eventChain: Promise<void> = Promise.resolve();

  private readonly idleDelayMs: number;

  private managedStateRootReady?: Promise<void>;

  private readonly logger: ContinuationLogger;

  private readonly priorityOrderScript: string;

  private readonly sessionStates = new Map<string, SessionState>();

  private readonly whipPath: string;

  constructor(context: PluginContext, logger: ContinuationLogger) {
    this.client = context.client;
    this.cwd = path.resolve(context.worktree ?? context.directory);
    this.logger = logger;
    this.continuationLockPath = path.resolve(this.cwd, DEFAULT_CONTINUATION_LOCK_PATH);
    this.continuationStatePath = path.resolve(this.cwd, DEFAULT_CONTINUATION_STATE_PATH);
    this.idleDelayMs = Math.max(0, context.idleDelayMs ?? DEFAULT_INTERACTIVE_IDLE_DELAY_MS);
    this.priorityOrderScript = path.resolve(this.cwd, "scripts", "gh-priority-order.sh");
    this.whipPath = path.resolve(this.cwd, DEFAULT_WHIP_PATH);
    this.logger.info("Initialized continuation controller.", {
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
    state.lastEventAt = Date.now();

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
      this.managedStateRootReady = ensureManagedStateRoot(this.cwd);
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
        let continuationState = await ensureContinuationState(this.continuationStatePath);
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
          continuationState = await writeContinuationState(this.continuationStatePath, {
            ...continuationState,
            ownerSessionID: sessionID,
          });
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

        continuationState = await writeContinuationState(this.continuationStatePath, {
          ...continuationState,
          ownerSessionID: sessionID,
          pendingPromptFingerprint: decision.fingerprint,
          pendingPromptUpdatedAt: new Date().toISOString(),
          pendingWhipTaskID: decision.whipTaskID,
        });

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
          await writeContinuationState(this.continuationStatePath, {
            ...continuationState,
            pendingPromptFingerprint: undefined,
            pendingPromptUpdatedAt: undefined,
            pendingWhipTaskID: undefined,
          });
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
          await updateWhipTaskStatus(this.whipPath, decision.whipTaskID, "in_progress");
          this.logger.debug("Marked whip task in progress after prompt enqueue.", {
            sessionID,
            whipTaskID: decision.whipTaskID,
          });
        }

        await writeContinuationState(this.continuationStatePath, {
          ...continuationState,
          activeWhipTaskID: decision.kind === "whip" ? decision.whipTaskID : undefined,
          lastPromptFingerprint: decision.fingerprint,
          ownerSessionID: sessionID,
          pendingPromptFingerprint: undefined,
          pendingPromptUpdatedAt: undefined,
          pendingWhipTaskID: undefined,
        });
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

    await updateWhipTaskStatus(this.whipPath, continuationState.activeWhipTaskID, "completed");
    this.logger.info("Completed active whip task before selecting the next continuation prompt.", {
      sessionID,
      whipTaskID: continuationState.activeWhipTaskID,
    });
    return writeContinuationState(this.continuationStatePath, {
      ...continuationState,
      activeWhipTaskID: undefined,
    });
  }

  private async isHelperSession(sessionID: string, state: SessionState): Promise<boolean> {
    if (state.isHelper !== undefined) {
      return state.isHelper;
    }

    const sessionInfo = await fetchSessionInfo(this.client, sessionID, this.cwd, {
      allowMissing: true,
    });
    if (sessionInfo === undefined) {
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
      await updateWhipTaskStatus(this.whipPath, continuationState.pendingWhipTaskID, "in_progress");
    }

    this.logger.info(details.message, details);

    return writeContinuationState(this.continuationStatePath, {
      ...continuationState,
      activeWhipTaskID: undefined,
      lastPromptFingerprint: undefined,
      ownerSessionID: undefined,
      pendingPromptFingerprint: undefined,
      pendingPromptUpdatedAt: undefined,
      pendingWhipTaskID: undefined,
    });
  }

  private async releaseStalePendingPromptIfNeeded(
    continuationState: ContinuationState,
  ): Promise<ContinuationState> {
    if (continuationState.pendingPromptFingerprint === undefined) {
      return continuationState;
    }

    if (continuationState.pendingWhipTaskID !== undefined) {
      if (!isPendingPromptFresh(continuationState.pendingPromptUpdatedAt)) {
        await updateWhipTaskStatus(this.whipPath, continuationState.pendingWhipTaskID, "in_progress");

        this.logger.info("Released stale pending whip reservation.", {
          pendingPromptFingerprint: continuationState.pendingPromptFingerprint,
          pendingWhipTaskID: continuationState.pendingWhipTaskID,
        });

        return writeContinuationState(this.continuationStatePath, {
          ...continuationState,
          activeWhipTaskID: undefined,
          lastPromptFingerprint: undefined,
          ownerSessionID: undefined,
          pendingPromptFingerprint: undefined,
          pendingPromptUpdatedAt: undefined,
          pendingWhipTaskID: undefined,
        });
      }

      return continuationState;
    }

    if (continuationState.pendingPromptUpdatedAt === undefined) {
      this.logger.info("Promoted untimestamped pending prompt reservation to last delivered fingerprint.", {
        pendingPromptFingerprint: continuationState.pendingPromptFingerprint,
      });
      return writeContinuationState(this.continuationStatePath, {
        ...continuationState,
        lastPromptFingerprint: continuationState.pendingPromptFingerprint,
        pendingPromptFingerprint: undefined,
        pendingPromptUpdatedAt: undefined,
      });
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
      return writeContinuationState(this.continuationStatePath, {
        ...continuationState,
        lastPromptFingerprint: continuationState.pendingPromptFingerprint,
        pendingPromptFingerprint: undefined,
        pendingPromptUpdatedAt: undefined,
      });
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
    const priorityOrder = await runPriorityOrderScript(this.cwd, this.priorityOrderScript);
    if (priorityOrder.exitCode !== 0) {
      throw new Error(
        `Failed to run ${path.relative(this.cwd, this.priorityOrderScript) || this.priorityOrderScript}: ${priorityOrder.stderr.trim() || `exit code ${priorityOrder.exitCode}`}`,
      );
    }

    this.logger.debug("Priority order script completed.", {
      stderr: truncateForLog(priorityOrder.stderr),
      stdout: truncateForLog(priorityOrder.stdout),
    });

    const readyIssues = parsePriorityOrderOutput(priorityOrder.stdout).readyIssues;
    if (readyIssues.length > 0) {
      this.logger.debug("Selected continuation prompt from ready issues.", {
        readyIssues,
      });
      return {
        fingerprint: `issues:${readyIssues.join(",")}`,
        kind: "issue",
        prompt: ISSUE_PROMPT,
      };
    }

    const whipState = await ensureWhipState(this.whipPath);
    const nextTask = selectNextWhipTask(whipState.tasks);
    if (nextTask === undefined) {
      this.logger.debug("No ready issues or whip tasks remain for continuation.");
      return undefined;
    }

    this.logger.debug("Selected continuation prompt from whip queue.", {
      whipTaskID: nextTask.id,
    });

    return {
      fingerprint: `whip:${nextTask.id}`,
      kind: "whip",
      prompt: buildWhipTaskPrompt(nextTask),
      whipTaskID: nextTask.id,
    };
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

async function runPriorityOrderScript(cwd: string, scriptPath: string): Promise<CommandRunResult> {
  return runCommand("bash", [scriptPath], cwd);
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
): Promise<CommandRunResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  const execFileAsync = promisify(execFile);

  try {
    const result = await execFileAsync(command, [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      exitCode: 0,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      "stderr" in error &&
      "code" in error
    ) {
      return {
        exitCode: typeof error.code === "number" ? error.code : 1,
        stderr: String(error.stderr),
        stdout: String(error.stdout),
      };
    }

    throw error;
  }
}

function parsePriorityOrderOutput(output: string): PriorityOrderSummary {
  const readyIssues: number[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = /^\d+\.\s+#(\d+):.*\[(.+)\]\s*$/.exec(line.trim());
    if (match === null) {
      continue;
    }

    const issueNumber = Number.parseInt(match[1], 10);
    const labels = match[2]
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (labels.includes("S-Ready")) {
      readyIssues.push(issueNumber);
    }
  }

  return { readyIssues };
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

function buildWhipTaskPrompt(task: WhipTask): string {
  return [
    "Continue the selected WHIP backlog task.",
    "The plugin tracks WHIP state and selects the next task. Focus only on the task in this prompt.",
    `Selected task: ${task.title}.`,
    task.prompt,
    ISSUE_CREATION_TEMPLATE,
    "Rules:",
    WHIP_WORKFLOW_RULES,
    "* Create GitHub issues for actionable findings instead of writing extra documentation",
    "* Do not choose, reorder, or track other WHIP tasks yourself; the plugin will inject the next selected task later",
    "Go.",
  ].join("\n");
}

async function ensureContinuationState(continuationStatePath: string): Promise<ContinuationState> {
  await ensureManagedStateRoot(path.dirname(path.dirname(continuationStatePath)));

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

  await writeContinuationState(continuationStatePath, state);
  return state;
}

async function writeContinuationState(
  continuationStatePath: string,
  state: Omit<ContinuationState, "updatedAt" | "version"> &
    Partial<Pick<ContinuationState, "updatedAt" | "version">>,
): Promise<ContinuationState> {
  await ensureManagedStateRoot(path.dirname(path.dirname(continuationStatePath)));

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

async function ensureWhipState(whipPath: string): Promise<WhipState> {
  await ensureManagedStateRoot(path.dirname(path.dirname(whipPath)));

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

async function ensureManagedStateRoot(repoRoot: string): Promise<void> {
  const existing = managedStateRootReady.get(repoRoot);
  if (existing !== undefined) {
    return existing;
  }

  const pending = ensureManagedStateRootOnce(repoRoot).catch((error) => {
    managedStateRootReady.delete(repoRoot);
    throw error;
  });
  managedStateRootReady.set(repoRoot, pending);
  return pending;
}

async function ensureManagedStateRootOnce(repoRoot: string): Promise<void> {
  await ensureManagedStateIgnored(repoRoot);
  await mkdir(path.join(repoRoot, ".umpire"), { recursive: true });
  await assertManagedStateUntracked(repoRoot);
}

async function ensureManagedStateIgnored(repoRoot: string): Promise<void> {
  const ignoreEntry = ".umpire/";
  await ensureIgnoreEntry(path.join(repoRoot, ".gitignore"), ignoreEntry);

  const gitDir = await resolveGitDir(repoRoot);
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

async function assertManagedStateUntracked(repoRoot: string): Promise<void> {
  const trackedPaths = await listTrackedManagedStatePaths(repoRoot);
  if (trackedPaths.length === 0) {
    return;
  }

  throw new Error(
    `Refusing continuation because plugin-managed state is tracked by git: ${trackedPaths.join(", ")}. Remove it from the index (for example: git rm --cached -- ${trackedPaths.join(" ")}) and keep .umpire/ ignored.`,
  );
}

async function listTrackedManagedStatePaths(repoRoot: string): Promise<string[]> {
  const result = await runCommand("git", ["ls-files", "--", ".umpire"], repoRoot);
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

async function resolveGitDir(repoRoot: string): Promise<string | undefined> {
  const result = await runCommand("git", ["rev-parse", "--git-dir"], repoRoot);
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
): Promise<WhipState> {
  const state = await ensureWhipState(whipPath);
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

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
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
