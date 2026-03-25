import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AiUmpireContinuationPlugin } from "../.opencode/plugins/ai-umpire-continuation.ts";
import type { WhipState, WhipTask } from "../opencode/ai-umpire-continuation.ts";

const tempDirs: string[] = [];
const pathRestorers: Array<() => void> = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queuePolicy = readQueuePolicy(repoRoot);
const issuePriorityLabels = queuePolicy.priorities
  .filter((priority) => priority.createIssue)
  .map((priority) => priority.name);
const issueStatusLabels = queuePolicy.statuses
  .filter((status) => status.createIssue)
  .map((status) => status.name);
const inProgressStatus = queuePolicy.statuses.find((status) => status.key === "in_progress")?.name;

type PromptRecord = {
  agent?: string;
  model?: {
    modelID: string;
    providerID: string;
  };
  sessionID: string;
  text: string;
};

type SessionInfoRecord = {
  id: string;
  parentID?: string;
};

type StoredContinuationState = {
  activeWhipTaskID?: string;
  lastPromptFingerprint?: string;
  ownerSessionID?: string;
  pendingPromptFingerprint?: string;
  pendingPromptUpdatedAt?: string;
  pendingWhipTaskID?: string;
  updatedAt: string;
  version: 1;
};

type TestPlugin = Awaited<ReturnType<typeof AiUmpireContinuationPlugin>>;

type SeededFixtureState = {
  capturedContinuationState: StoredContinuationState;
  continuationState: StoredContinuationState;
  whipState?: WhipState;
};

type QueueSummaryFixture = {
  blockedIssues: number[];
  inProgress: number[];
  issues: Array<{
    component: string;
    labels: string[];
    number: number;
    priority: string;
    score: number;
    status: string;
    title: string;
  }>;
  nextIssue: number | null;
  readyIssues: number[];
  version: 1;
};

type QueuePolicyFixture = {
  components: {
    labels: Array<{ name: string }>;
    prefix: string;
  };
  issueCreation: {
    dependencyLine: string;
    ensureLabelsCommand: string;
    sequenceGuidance: string;
  };
  priorities: Array<{ createIssue: boolean; name: string }>;
  statuses: Array<{ createIssue: boolean; key: string; name: string }>;
};

type GhIssueListEntryFixture =
  | number
  | {
      labels?: string[];
      number: number;
    };

type ContextOverrides = {
  appLog?: (input: { body: { level: "debug" | "error" | "info"; message: string } }) => unknown;
  get?: (input: { path: { id: string }; query?: { directory?: string } }) => Promise<{
    data?: unknown;
    error?: unknown;
    request?: { method?: string; url?: string };
    response?: { status?: number; url?: string };
  }>;
  messages?: (input: {
    path: { id: string };
    query?: { directory?: string; limit?: number };
  }) => Promise<{
    data?: unknown;
    error?: unknown;
    request?: { method?: string; url?: string };
    response?: { status?: number; url?: string };
  }>;
  promptAsync?: (input: {
    body?: {
      agent?: string;
      model?: { modelID: string; providerID: string };
      parts?: Array<{ text: string }>;
    };
    path: { id: string };
    query?: { directory?: string };
  }) => Promise<{
    data?: unknown;
    error?: unknown;
    request?: { method?: string; url?: string };
    response?: { status?: number; url?: string };
  }>;
  todo?: (input: { path: { id: string }; query?: { directory?: string } }) => Promise<{
    data?: unknown;
    error?: unknown;
    request?: { method?: string; url?: string };
    response?: { status?: number; url?: string };
  }>;
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (pathRestorers.length > 0) {
    pathRestorers.pop()?.();
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  await Promise.all(tempDirs.splice(0).map((dir) => removePathEventually(dir)));
});

describe("AiUmpireContinuationPlugin", () => {
  it("enqueues the ready-issue prompt with the issue todo template", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_ready" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_ready");
    expect(prompts[0]?.text).toContain("Continue solving open issues from gh-priority-order.sh.");
    expect(prompts[0]?.text).toContain(queuePolicy.issueCreation.ensureLabelsCommand);
    expect(prompts[0]?.text).toContain("## GitHub Issue Creation Rules (ALWAYS FOLLOW)");
    expect(prompts[0]?.text).toContain("## Issue Todo Template (ALWAYS USE THIS STRUCTURE)");
    expect(prompts[0]?.text).toContain("todowrite({ todos: [");
    expect(prompts[0]?.text).toContain("Never stage, commit, or push `.umpire/**` files.");
    expect(prompts[0]?.text).toContain(
      `Every created issue must have exactly one priority label: ${formatCodeList(issuePriorityLabels)}.`,
    );
    expect(prompts[0]?.text).toContain(
      `Every created issue must have exactly one status label: ${formatCodeList(issueStatusLabels)}.${inProgressStatus === undefined ? "" : ` Do not create fresh issues directly as \`${inProgressStatus}\`.`}`,
    );
    expect(prompts[0]?.text).toContain(queuePolicy.issueCreation.dependencyLine);
  });

  it("consumes the real priority-order script JSON contract when selecting issue work", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];

    await installRealPriorityOrderScript(repoDir);
    const restorePath = await installFakeGhBinary(`
process.stdout.write(JSON.stringify([
  { number: 42, title: "Medium blocked", labels: [{ name: "P3-Medium" }, { name: "S-Blocked" }] },
  { number: 41, title: "Low but blocking", labels: [{ name: "P4-Low" }, { name: "S-Blocking" }] },
  { number: 77, title: "High in progress", labels: [{ name: "P2-High" }, { name: "S-InProgress" }] },
  { number: 43, title: "High ready", labels: [{ name: "P2-High" }, { name: "C-Infrastructure" }, { name: "S-Ready" }] }
]));
`);

    try {
      const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

      await plugin.event?.({
        event: {
          properties: { sessionID: "ses_ready" },
          type: "session.idle",
        },
      });
    } finally {
      restorePath();
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_ready");
    expect(prompts[0]?.text).toContain("Continue solving open issues from gh-priority-order.sh.");
    expect(readContinuationState(repoDir).lastPromptFingerprint).toBe("issues:43");
  });

  it("falls back to the full priority-order summary when the ready-issue probe fails", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const restorePath = await installFakeGhBinary(`
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  process.stderr.write("gh probe unavailable\\n");
  process.exit(1);
}
process.stderr.write("Unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`);

    try {
      const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

      await plugin.event?.({
        event: {
          properties: { sessionID: "ses_ready" },
          type: "session.idle",
        },
      });
    } finally {
      restorePath();
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain("Continue solving open issues from gh-priority-order.sh.");
    await waitForContinuationLogToContain(repoDir, "Ready issue probe failed; falling back to full priority order summary.");
    expect(readContinuationState(repoDir).lastPromptFingerprint).toBe("issues:26");
  });

  it("falls back to whip work when the ready-issue probe fails and the full summary is empty", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const restorePath = await installFakeGhBinary(`
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  process.stderr.write("gh probe unavailable\\n");
  process.exit(1);
}
process.stderr.write("Unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`);

    try {
      const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

      await plugin.event?.({
        event: {
          properties: { sessionID: "ses_whip" },
          type: "session.idle",
        },
      });
    } finally {
      restorePath();
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain("Continue the selected WHIP backlog task.");
    await waitForContinuationLogToContain(repoDir, "Ready issue probe failed; falling back to full priority order summary.");
  });

  it("uses the repo-local queue policy when validating queue summaries and generating prompts", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const restorePath = await installFakeGhIssueListSequence([[26]]);
    const customPolicy = readQueuePolicyDocument(repoDir);
    const statuses = Array.isArray(customPolicy.statuses)
      ? customPolicy.statuses as Array<Record<string, unknown>>
      : [];

    for (const status of statuses) {
      if (status.key === "ready") {
        status.name = "Ready-Now";
      } else if (status.key === "in_progress") {
        status.name = "Doing-Now";
      } else if (status.key === "blocked") {
        status.name = "Blocked-Later";
      } else if (status.key === "blocking") {
        status.name = "Blocking-Now";
      }
    }

    await writeFile(
      path.join(repoDir, "queue-policy.json"),
      JSON.stringify(customPolicy, null, 2).concat("\n"),
      "utf8",
    );
    await installStubPriorityOrderScript(
      repoDir,
      {
        blockedIssues: [],
        inProgress: [],
        issues: [
          {
            component: "",
            labels: ["P2-High", "Ready-Now"],
            number: 26,
            priority: "P2-High",
            score: 550,
            status: "Ready-Now",
            title: "Ship continuation plugin",
          },
        ],
        nextIssue: 26,
        readyIssues: [26],
        version: 1,
      },
      "1. #26: Ship continuation plugin [P2-High, Ready-Now]",
    );

    try {
      const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

      await plugin.event?.({
        event: {
          properties: { sessionID: "ses_ready" },
          type: "session.idle",
        },
      });
    } finally {
      restorePath();
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain("start next Ready-Now issue");
    expect(prompts[0]?.text).toContain(
      "Every created issue must have exactly one status label: `Ready-Now`, `Blocked-Later`, or `Blocking-Now`. Do not create fresh issues directly as `Doing-Now`.",
    );
    expect(readContinuationState(repoDir).lastPromptFingerprint).toBe("issues:26");
  });

  it("rejects inconsistent priority-order summaries instead of enqueueing issue work", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const restorePath = await installFakeGhIssueListSequence([[26]]);

    await installStubPriorityOrderScript(
      repoDir,
      {
        blockedIssues: [],
        inProgress: [],
        issues: [
          {
            component: "",
            labels: ["P2-High", "S-Blocked"],
            number: 26,
            priority: "P2-High",
            score: 400,
            status: "S-Blocked",
            title: "Blocked issue masquerading as ready",
          },
        ],
        nextIssue: 26,
        readyIssues: [26],
        version: 1,
      },
      "1. #26: Blocked issue masquerading as ready [P2-High, S-Blocked]",
    );

    try {
      const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

      await plugin.event?.({
        event: {
          properties: { sessionID: "ses_ready" },
          type: "session.idle",
        },
      });
    } finally {
      restorePath();
    }

    expect(prompts).toHaveLength(0);
    await waitForContinuationLogToContain(repoDir, "Invalid priority order summary readyIssues.");
  });

  it("fails plugin initialization when queue-policy.json is missing from the repo root", async () => {
    const repoDir = await createTempDir(true);

    await rm(path.join(repoDir, "queue-policy.json"), { force: true });

    await expect(AiUmpireContinuationPlugin(createContext(repoDir, [], []))).rejects.toThrow(
      "Failed to read queue-policy.json",
    );
  });

  it("fails plugin initialization when queue-policy.json is invalid", async () => {
    const repoDir = await createTempDir(true);
    const queuePolicy = readQueuePolicyDocument(repoDir);

    if (!Array.isArray(queuePolicy.statuses) || queuePolicy.statuses.length === 0) {
      throw new Error("Missing statuses in queue-policy test fixture.");
    }

    queuePolicy.statuses[0] = {
      ...(queuePolicy.statuses[0] as Record<string, unknown>),
      key: "not-ready",
    };
    queuePolicy.defaults = {
      ...(queuePolicy.defaults as Record<string, unknown>),
      statusKey: "not-ready",
    };

    await writeFile(
      path.join(repoDir, "queue-policy.json"),
      JSON.stringify(queuePolicy, null, 2).concat("\n"),
      "utf8",
    );

    await expect(AiUmpireContinuationPlugin(createContext(repoDir, [], []))).rejects.toThrow(
      "Invalid queue-policy.json: missing required status key ready.",
    );
  });

  it("starts continuation from an idle session.status event and dedupes the later session.idle event", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: {
          sessionID: "ses_ready",
          status: { type: "idle" },
        },
        type: "session.status",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_ready" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_ready");
  });

  it("writes continuation logs to disk without using console output", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_ready" },
        type: "session.idle",
      },
    });

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    await waitForContinuationLogToContain(repoDir, "Initialized continuation controller.");
  });

  it("rotates and trims continuation logs when they exceed the configured byte budget", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const continuationLogMaxBytes = 320;
    const logPath = path.join(repoDir, ".umpire", "continuation.log");

    await mkdir(path.join(repoDir, ".umpire"), { recursive: true });
    await writeFile(logPath, "x".repeat(continuationLogMaxBytes * 2), "utf8");

    const plugin = await AiUmpireContinuationPlugin({
      ...createContext(repoDir, prompts, []),
      continuationLogMaxBytes,
    });

    for (let index = 0; index < 12; index += 1) {
      await plugin.event?.({
        event: {
          properties: { sessionID: `ses_log_${index}` },
          type: "tui.prompt.append",
        },
      });
    }

    await waitForContinuationLogToContain(repoDir, '"sessionID":"ses_log_11"');

    const rotatedPath = path.join(repoDir, ".umpire", "continuation.log.1");

    await waitForFileToExist(rotatedPath);
    await waitForFileToExist(logPath);

    const [logStats, rotatedStats, log, rotatedLog] = await Promise.all([
      stat(logPath),
      stat(rotatedPath),
      readFile(logPath, "utf8"),
      readFile(rotatedPath, "utf8"),
    ]);

    expect(logStats.size).toBeLessThanOrEqual(continuationLogMaxBytes);
    expect(rotatedStats.size).toBeLessThanOrEqual(continuationLogMaxBytes);
    expect(logStats.size + rotatedStats.size).toBeLessThanOrEqual(continuationLogMaxBytes * 2);
    expect(log).toContain('"sessionID":"ses_log_11"');
    expect(rotatedLog).toContain('"sessionID":"ses_log_');
  });

  it("forwards log lines to client.app.log", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const appLog = vi.fn();
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {}, { appLog }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_ready" },
        type: "session.idle",
      },
    });

    expect(appLog).toHaveBeenCalledWith({
      body: {
        level: "info",
        message: expect.stringContaining("Initialized continuation controller."),
      },
    });
  });

  it("precomputes the continuation decision on a completed assistant message before idle", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: {
          info: {
            role: "assistant",
            sessionID: "ses_ready",
            time: { completed: Date.now() },
          },
        },
        type: "message.updated",
      },
    });

    expect(prompts).toHaveLength(0);
    await waitForContinuationLogToContain(repoDir, "Precomputing continuation decision.");

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_ready" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_ready");
  });

  it("does not start continuation from a busy session.status event", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: {
          sessionID: "ses_ready",
          status: { type: "busy" },
        },
        type: "session.status",
      },
    });

    expect(prompts).toHaveLength(0);
    expect(maybeReadContinuationState(repoDir)).toBeUndefined();
  });

  it("keeps continuation pinned to the first prompted session", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_primary" },
        type: "session.idle",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_helper" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_primary");
  });

  it("ignores helper sessions and waits for a root session to claim continuation", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {
        ses_helper: { id: "ses_helper", parentID: "ses_primary" },
        ses_primary: { id: "ses_primary" },
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_helper" },
        type: "session.idle",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_primary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_primary");
  });

  it("logs info when skipping continuation because active todos remain", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const appLog = vi.fn();
    const activeTodos = [
      { content: "Keep working", id: "todo-1", priority: "high", status: "in_progress" },
    ];
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, activeTodos, {}, { appLog }),
    );

    await emitIdle(plugin, "ses_busy");

    expect(prompts).toHaveLength(0);
    await waitForContinuationLogToContain(repoDir, "Skipping continuation because active todos remain.");

    const infoMessages = appLog.mock.calls
      .map(([input]) => input.body)
      .filter((body) => body.level === "info")
      .map((body) => body.message);

    expect(
      infoMessages.some(
        (message) =>
          message.includes("Skipping continuation because active todos remain.") &&
          message.includes('"activeTodoCount":1') &&
          message.includes('"sessionID":"ses_busy"'),
      ),
    ).toBe(true);
    expect(await readContinuationLog(repoDir)).toContain(
      "[ai-umpire-continuation:info] Skipping continuation because active todos remain.",
    );
  });

  it("logs info when skipping continuation because another session owns it", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const appLog = vi.fn();
    const sessionInfoByID = {
      ses_owner: { id: "ses_owner" },
      ses_guest: { id: "ses_guest" },
    } satisfies Record<string, SessionInfoRecord>;

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, { appLog }),
    );

    // First session claims it
    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_owner" },
        type: "session.idle",
      },
    });

    // Second session tries to claim it
    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_guest" },
        type: "session.idle",
      },
    });

    await waitForContinuationLogToContain(repoDir, "Skipping continuation because another session owns it.");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_owner");

    const infoMessages = appLog.mock.calls
      .map(([input]) => input.body)
      .filter((body) => body.level === "info")
      .map((body) => body.message);

    expect(
      infoMessages.some(
        (message) =>
          message.includes("Skipping continuation because another session owns it.") &&
          message.includes('"ownerSessionID":"ses_owner"') &&
          message.includes('"sessionID":"ses_guest"'),
      ),
    ).toBe(true);
    expect(await readContinuationLog(repoDir)).toContain(
      "[ai-umpire-continuation:info] Skipping continuation because another session owns it.",
    );
  });

  it("persists continuation ownership and dedupe across plugin instances", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const appLog = vi.fn();
    const sessionInfoByID = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    } satisfies Record<string, SessionInfoRecord>;

    const firstPlugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, { appLog }),
    );
    const secondPlugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, { appLog }),
    );

    await firstPlugin.event?.({
      event: {
        properties: { sessionID: "ses_primary" },
        type: "session.idle",
      },
    });

    await secondPlugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    await secondPlugin.event?.({
      event: {
        properties: { sessionID: "ses_primary" },
        type: "session.idle",
      },
    });

    const continuationState = readContinuationState(repoDir);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_primary");
    expect(continuationState.ownerSessionID).toBe("ses_primary");
    expect(continuationState.lastPromptFingerprint).toBe("issues:26");
    await waitForContinuationLogToContain(
      repoDir,
      "Skipping continuation because the next fingerprint matches the last delivered prompt.",
    );

    const infoMessages = appLog.mock.calls
      .map(([input]) => input.body)
      .filter((body) => body.level === "info")
      .map((body) => body.message);

    expect(
      infoMessages.some(
        (message) =>
          message.includes(
            "Skipping continuation because the next fingerprint matches the last delivered prompt.",
          ) &&
          message.includes('"fingerprint":"issues:26"') &&
          message.includes('"sessionID":"ses_primary"'),
      ),
    ).toBe(true);
    expect(await readContinuationLog(repoDir)).toContain(
      "[ai-umpire-continuation:info] Skipping continuation because the next fingerprint matches the last delivered prompt.",
    );
  });

  it("creates whip state, claims the first task, and keeps .umpire out of shipping prompts", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_whip" },
        type: "session.idle",
      },
    });

    const whipPath = path.join(repoDir, ".umpire", "whip.json");
    const whipRaw = await readFile(whipPath, "utf8");
    const gitignoreRaw = await readFile(path.join(repoDir, ".gitignore"), "utf8");
    const gitInfoExcludeRaw = await readFile(path.join(repoDir, ".git", "info", "exclude"), "utf8");

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain("Continue the selected WHIP backlog task.");
    expect(prompts[0]?.text).toContain(
      "The plugin tracks WHIP state and selects the next task. Focus only on the task in this prompt.",
    );
    expect(prompts[0]?.text).toContain(
      "Selected task: Audit the last 20 pull requests for unresolved review feedback.",
    );
    expect(prompts[0]?.text).toContain("## Problem");
    expect(prompts[0]?.text).toContain("Blocked by: #<N>");
    expect(prompts[0]?.text).toContain("The plugin manages `.umpire/whip.json` task state automatically.");
    expect(prompts[0]?.text).not.toContain("current WHIP task queue");
    expect(prompts[0]?.text).not.toContain("next idle tick will return to the issue queue automatically");
    expect(prompts[0]?.text).not.toContain("git commit, push, pr, merge");
    expect(prompts[0]?.text).not.toContain("Update .umpire/whip.json");
    expect(whipRaw).toContain('"review-last-20-prs"');
    expect(whipRaw).toContain('"audit-test-integrity"');
    expect(whipRaw).toContain('"review-performance-issues"');
    expect(whipRaw).toContain('"review-memory-leaks"');
    expect(whipRaw).toContain('"review-error-handling"');
    expect(whipRaw).toContain('"review-logging-gaps"');
    expect(whipRaw).toContain('"review-last-20-prs"');
    expect(whipRaw).toContain('"status": "in_progress"');
    expect(gitignoreRaw).toContain(".umpire/");
    expect(gitInfoExcludeRaw).toContain(".umpire/");
  });

  it("resumes an in-progress whip task from whip state on a cold start without rerunning priority ordering", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];

    const seededState = await seedInProgressWhipState(repoDir);
    const markerPath = path.join(repoDir, ".priority-order-called");

    await writeFile(
      path.join(repoDir, "scripts", "gh-priority-order.sh"),
      `#!/usr/bin/env bash
MARKER_PATH=${JSON.stringify(markerPath)}
touch "$MARKER_PATH"
exit 99
`,
      "utf8",
    );
    await chmod(path.join(repoDir, "scripts", "gh-priority-order.sh"), 0o755);

    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_whip" },
        type: "session.idle",
      },
    });

    const continuationState = readContinuationState(repoDir);
    const whipState = readWhipState(repoDir);
    const activeTask = expectWhipTaskFromContinuationState(
      whipState,
      seededState.capturedContinuationState,
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain(`Selected task: ${activeTask.title}.`);
    expect(whipState.tasks.find((task) => task.id === activeTask.id)?.status).toBe("in_progress");
    expect(whipState.tasks.find((task) => task.id === "validate-aiq-nine-stages")?.status).toBe("pending");
    expect(continuationState.activeWhipTaskID).toBe(activeTask.id);
    expect(continuationState.lastPromptFingerprint).toBe(
      seededState.capturedContinuationState.lastPromptFingerprint,
    );
    expect(continuationState.pendingPromptFingerprint).toBeUndefined();
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes the active whip task in the controller before prompting the next one", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_whip" },
        type: "session.idle",
      },
    });

    await plugin.event?.({
      event: {
        properties: {
          sessionID: "ses_whip",
          status: { type: "busy" },
        },
        type: "session.status",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_whip" },
        type: "session.idle",
      },
    });

    const whipState = readWhipState(repoDir);

    expect(prompts).toHaveLength(2);
    expect(whipState.tasks.find((task) => task.id === "review-last-20-prs")?.status).toBe("completed");
    expect(whipState.tasks.find((task) => task.id === "validate-aiq-nine-stages")?.status).toBe("in_progress");
    expect(prompts[1]?.text).toContain(
      "Selected task: Create validation issues for all 9 AIQ stages when @tjalve/aiq is in use.",
    );
  });

  it("skips priority ordering while local whip work continues when no ready issues exist", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const priorityOrderCountPath = await installCountingPriorityOrderScript(repoDir, [
      {
        blockedIssues: [],
        inProgress: [],
        issues: [],
        nextIssue: null,
        readyIssues: [],
        version: 1,
      },
    ]);

    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await emitIdle(plugin, "ses_whip");
    await plugin.event?.({
      event: {
        properties: {
          sessionID: "ses_whip",
          status: { type: "busy" },
        },
        type: "session.status",
      },
    });
    await emitIdle(plugin, "ses_whip");

    expect(prompts).toHaveLength(2);
    expect(readPriorityOrderInvocationCount(priorityOrderCountPath)).toBe(0);
    expect(prompts[1]?.text).toContain(
      "Selected task: Create validation issues for all 9 AIQ stages when @tjalve/aiq is in use.",
    );
  });

  it("logs a specific info outcome when no ready issues or whip tasks remain", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const appLog = vi.fn();
    const timestamp = new Date("2026-03-25T00:00:00.000Z").toISOString();

    await writeWhipState(repoDir, {
      createdAt: timestamp,
      tasks: [],
      updatedAt: timestamp,
      version: 1,
    });

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {}, { appLog }),
    );

    await emitIdle(plugin, "ses_idle");

    expect(prompts).toHaveLength(0);
    await waitForContinuationLogToContain(repoDir, "No ready issues or whip tasks remain for continuation.");

    const infoMessages = appLog.mock.calls
      .map(([input]) => input.body)
      .filter((body) => body.level === "info")
      .map((body) => body.message);

    expect(
      infoMessages.some(
        (message) =>
          message.includes("No ready issues or whip tasks remain for continuation.") &&
          message.includes('"sessionID":"ses_idle"'),
      ),
    ).toBe(true);
    expect(
      infoMessages.some((message) =>
        message.includes("Skipping continuation because no next decision was available."),
      ),
    ).toBe(false);
    expect(await readContinuationLog(repoDir)).toContain(
      "[ai-umpire-continuation:info] No ready issues or whip tasks remain for continuation.",
    );
  });

  it("rechecks ready issue availability before advancing whip work", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const priorityOrderCountPath = await installCountingPriorityOrderScript(repoDir, [
      {
        blockedIssues: [],
        inProgress: [],
        issues: [
          {
            component: "",
            labels: ["P2-High", "S-Ready"],
            number: 71,
            priority: "P2-High",
            score: 550,
            status: "S-Ready",
            title: "Ship queued issue work",
          },
        ],
        nextIssue: 71,
        readyIssues: [71],
        version: 1,
      },
    ]);
    const restorePath = await installFakeGhIssueListSequence([[], [71]]);

    try {
      const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

      await emitIdle(plugin, "ses_whip");
      await plugin.event?.({
        event: {
          properties: {
            sessionID: "ses_whip",
            status: { type: "busy" },
          },
          type: "session.status",
        },
      });
      await emitIdle(plugin, "ses_whip");
    } finally {
      restorePath();
    }

    expect(prompts).toHaveLength(2);
    expect(readPriorityOrderInvocationCount(priorityOrderCountPath)).toBe(1);
    expect(prompts[1]?.text).toContain("Continue solving open issues from gh-priority-order.sh.");
    expect(readContinuationState(repoDir).lastPromptFingerprint).toBe("issues:71");
  });

  it("defers continuation instead of advancing whip when the ready probe and summary disagree", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const restorePath = await installFakeGhIssueListSequence([[71]]);

    try {
      const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

      await emitIdle(plugin, "ses_whip");
    } finally {
      restorePath();
    }

    expect(prompts).toHaveLength(0);
    expect(maybeReadWhipState(repoDir)).toBeUndefined();
    expect(maybeReadContinuationState(repoDir)?.lastPromptFingerprint).toBeUndefined();
    await waitForContinuationLogToContain(repoDir, "Ready issue probe changed before priority ordering completed.");
  });

  it("ignores the trailing session.idle after a whip prompt was already enqueued on session.status idle", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: {
          sessionID: "ses_whip",
          status: { type: "idle" },
        },
        type: "session.status",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_whip" },
        type: "session.idle",
      },
    });

    const whipState = readWhipState(repoDir);

    expect(prompts).toHaveLength(1);
    expect(whipState.tasks.find((task) => task.id === "review-last-20-prs")?.status).toBe("in_progress");
    expect(whipState.tasks.find((task) => task.id === "validate-aiq-nine-stages")?.status).toBe("pending");
  });

  it("refuses continuation when plugin-managed .umpire state is tracked by git", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];

    await mkdir(path.join(repoDir, ".umpire"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".umpire", "whip.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), tasks: [], updatedAt: new Date().toISOString(), version: 1 }, null, 2).concat("\n"),
      "utf8",
    );
    execFileSync("git", ["add", ".umpire/whip.json"], { cwd: repoDir });

    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    const gitignoreRaw = await readFile(path.join(repoDir, ".gitignore"), "utf8");
    const gitInfoExcludeRaw = await readFile(path.join(repoDir, ".git", "info", "exclude"), "utf8");

    expect(prompts).toHaveLength(0);
    await waitForContinuationLogToContain(repoDir, "plugin-managed state is tracked by git");
    expect(gitignoreRaw).toContain(".umpire/");
    expect(gitInfoExcludeRaw).toContain(".umpire/");
  });

  it("refuses continuation when any plugin-managed file inside .umpire is tracked by git", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];

    await mkdir(path.join(repoDir, ".umpire"), { recursive: true });
    await writeFile(path.join(repoDir, ".umpire", "continuation.log"), "debug\n", "utf8");
    execFileSync("git", ["add", ".umpire/continuation.log"], { cwd: repoDir });

    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(0);
    await waitForContinuationLogToContain(repoDir, ".umpire/continuation.log");
  });

  it("hands an in-progress whip task to a new root owner when the original owner disappears", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };

    const firstPlugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID),
    );
    const secondPlugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID),
    );

    await firstPlugin.event?.({
      event: {
        properties: { sessionID: "ses_primary" },
        type: "session.idle",
      },
    });

    sessionInfoByID.ses_primary = null;

    await secondPlugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.text).toContain(
      "Selected task: Audit the last 20 pull requests for unresolved review feedback.",
    );
    expect(prompts[1]?.text).toContain(
      "Selected task: Audit the last 20 pull requests for unresolved review feedback.",
    );
    expect(readWhipState(repoDir).tasks.find((task) => task.id === "review-last-20-prs")?.status).toBe("in_progress");
  });

  it("hands an in-progress whip task to a new root owner when the previous owner is inactive", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const staleActivity = Date.now() - 11 * 60_000;
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };

    const seededState = await seedOwnedInProgressWhipState(repoDir, "ses_primary");

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, {
        messages: async (input) => ({
          data: input.path.id === "ses_primary"
            ? [{ info: { role: "assistant", time: { completed: staleActivity, created: staleActivity } } }]
            : [],
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    const continuationState = readContinuationState(repoDir);
    const activeTask = expectWhipTaskFromContinuationState(
      seededState.whipState ?? readWhipState(repoDir),
      seededState.continuationState,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_secondary");
    expect(prompts[0]?.text).toContain(`Selected task: ${activeTask.title}.`);
    expect(continuationState.activeWhipTaskID).toBe(activeTask.id);
    expect(continuationState.ownerSessionID).toBe("ses_secondary");
    await waitForContinuationLogToContain(repoDir, "recorded owner session was inactive");
  });

  it("does not steal whip ownership from a recently active owner session", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const recentActivity = Date.now() - 60_000;
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };

    const seededState = await seedOwnedInProgressWhipState(repoDir, "ses_primary");

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, {
        messages: async (input) => ({
          data: input.path.id === "ses_primary"
            ? [{ info: { role: "assistant", time: { completed: recentActivity, created: recentActivity } } }]
            : [],
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(0);
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_primary");
    expect(readContinuationState(repoDir).activeWhipTaskID).toBe(
      seededState.continuationState.activeWhipTaskID,
    );
  });

  it("hands continuation to a newer root session after the previous owner goes locally quiet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T17:37:00.000Z"));

    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };
    const ownerActivityAt = Date.now();

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, {
        messages: async (input) => ({
          data: input.path.id === "ses_primary"
            ? [{ info: { role: "assistant", time: { completed: ownerActivityAt, created: ownerActivityAt } } }]
            : [],
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: {
          info: {
            agent: "Hephaestus",
            modelID: "gpt-5.4",
            providerID: "openai",
            role: "assistant",
            sessionID: "ses_primary",
            time: { completed: ownerActivityAt },
          },
        },
        type: "message.updated",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_primary" },
        type: "session.idle",
      },
    });

    await vi.advanceTimersByTimeAsync(21_000);

    await plugin.event?.({
      event: {
        properties: {
          info: {
            agent: "Hephaestus",
            modelID: "gpt-5.4",
            providerID: "openai",
            role: "assistant",
            sessionID: "ses_secondary",
            time: { completed: Date.now() },
          },
        },
        type: "message.updated",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.sessionID).toBe("ses_secondary");
    expect(prompts[1]?.text).toContain(
      "Selected task: Audit the last 20 pull requests for unresolved review feedback.",
    );
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_secondary");
    await waitForContinuationLogToContain(
      repoDir,
      "newer root session became active after the previous owner went locally quiet",
    );
  });

  it("does not hand continuation to a newer root session before the local quiet window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T17:37:00.000Z"));

    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };
    const ownerActivityAt = Date.now();

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, {
        messages: async (input) => ({
          data: input.path.id === "ses_primary"
            ? [{ info: { role: "assistant", time: { completed: ownerActivityAt, created: ownerActivityAt } } }]
            : [],
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: {
          info: {
            agent: "Hephaestus",
            modelID: "gpt-5.4",
            providerID: "openai",
            role: "assistant",
            sessionID: "ses_primary",
            time: { completed: ownerActivityAt },
          },
        },
        type: "message.updated",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_primary" },
        type: "session.idle",
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await plugin.event?.({
      event: {
        properties: {
          info: {
            agent: "Hephaestus",
            modelID: "gpt-5.4",
            providerID: "openai",
            role: "assistant",
            sessionID: "ses_secondary",
            time: { completed: Date.now() },
          },
        },
        type: "message.updated",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_primary");
    expect(readContinuationState(repoDir).activeWhipTaskID).toBe("review-last-20-prs");
  });

  it("does not treat toast-only TUI activity as a takeover signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T17:37:00.000Z"));

    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };
    const ownerActivityAt = Date.now();

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, {
        messages: async (input) => ({
          data: input.path.id === "ses_primary"
            ? [{ info: { role: "assistant", time: { completed: ownerActivityAt, created: ownerActivityAt } } }]
            : [],
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: {
          info: {
            agent: "Hephaestus",
            modelID: "gpt-5.4",
            providerID: "openai",
            role: "assistant",
            sessionID: "ses_primary",
            time: { completed: ownerActivityAt },
          },
        },
        type: "message.updated",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_primary" },
        type: "session.idle",
      },
    });

    await vi.advanceTimersByTimeAsync(21_000);

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "tui.toast.show",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_primary");
    expect(readContinuationState(repoDir).activeWhipTaskID).toBe("review-last-20-prs");
  });

  it("does not reuse stale takeover intent for a later owner handoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T17:37:00.000Z"));

    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };
    const ownerActivityAt = Date.now();

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, {
        messages: async (input) => ({
          data: input.path.id === "ses_primary"
            ? [{ info: { role: "assistant", time: { completed: ownerActivityAt, created: ownerActivityAt } } }]
            : [],
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: {
          info: {
            agent: "Hephaestus",
            modelID: "gpt-5.4",
            providerID: "openai",
            role: "assistant",
            sessionID: "ses_primary",
            time: { completed: ownerActivityAt },
          },
        },
        type: "message.updated",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_primary" },
        type: "session.idle",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "tui.session.select",
      },
    });

    await vi.advanceTimersByTimeAsync(21_000);

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_primary");
    expect(readContinuationState(repoDir).activeWhipTaskID).toBe("review-last-20-prs");
  });

  it("reclaims a stale owner when session history has no parseable activity timestamps", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const staleUpdatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };

    const seededState = await seedOwnedInProgressWhipState(repoDir, "ses_primary", staleUpdatedAt);

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, {
        messages: async (input) => ({
          data: input.path.id === "ses_primary"
            ? [{ info: { role: "assistant", time: {} } }]
            : [],
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_secondary");
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_secondary");
    expect(readContinuationState(repoDir).activeWhipTaskID).toBe(
      seededState.continuationState.activeWhipTaskID,
    );
    await waitForContinuationLogToContain(repoDir, "Falling back to persisted continuation timestamp for owner session activity.");
  });

  it("reclaims a stale owner when session activity lookup fails", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const staleUpdatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };

    const seededState = await seedOwnedInProgressWhipState(repoDir, "ses_primary", staleUpdatedAt);

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, {
        messages: async (input) => input.path.id === "ses_primary"
          ? { error: { name: "APIError" } }
          : { data: [] },
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_secondary");
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_secondary");
    expect(readContinuationState(repoDir).activeWhipTaskID).toBe(
      seededState.continuationState.activeWhipTaskID,
    );
    await waitForContinuationLogToContain(repoDir, "Falling back to persisted continuation timestamp after failing to read owner session activity.");
  });

  it("does not reclaim ownership when session history is unreadable but the persisted lease is recent", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const recentUpdatedAt = new Date(Date.now() - 60_000).toISOString();
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: { id: "ses_primary" },
      ses_secondary: { id: "ses_secondary" },
    };

    const seededState = await seedOwnedInProgressWhipState(repoDir, "ses_primary", recentUpdatedAt);

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID, {
        messages: async (input) => ({
          data: input.path.id === "ses_primary"
            ? [{ info: { role: "assistant", time: {} } }]
            : [],
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(0);
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_primary");
    expect(readContinuationState(repoDir).activeWhipTaskID).toBe(
      seededState.continuationState.activeWhipTaskID,
    );
  });

  it("ignores idle events when the current session metadata is missing", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], { ses_missing: null }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_missing" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(0);
    expect(maybeReadContinuationState(repoDir)).toBeUndefined();
  });

  it("treats SDK 404 responses as missing even when the error body is not NotFoundError-shaped", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {}, {
        get: async () => ({
          error: { data: { message: "missing" }, success: false },
          response: { status: 404, url: "http://localhost:4096/session/ses_missing" },
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_missing" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(0);
    expect(maybeReadContinuationState(repoDir)).toBeUndefined();
  });

  it("uses the legacy plugin client request shape with nested path, query, and body fields", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const seen: {
      get?: { path: { id: string }; query?: { directory?: string } };
      promptAsync?: {
        body?: { parts?: Array<{ text: string }> };
        path: { id: string };
        query?: { directory?: string };
      };
      todo?: { path: { id: string }; query?: { directory?: string } };
    } = {};

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {}, {
        get: async (input) => {
          seen.get = input;
          return { data: { id: input.path.id } };
        },
        promptAsync: async (input) => {
          seen.promptAsync = input;
          const [firstPart] = input.body?.parts ?? [];
          if (firstPart !== undefined) {
            prompts.push({ sessionID: input.path.id, text: firstPart.text });
          }

          return { data: undefined };
        },
        todo: async (input) => {
          seen.todo = input;
          return { data: [] };
        },
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(seen.get).toEqual({
      path: { id: "ses_root" },
      query: { directory: repoDir },
    });
    expect(seen.todo).toEqual({
      path: { id: "ses_root" },
      query: { directory: repoDir },
    });
    expect(seen.promptAsync).toEqual({
      body: {
        agent: undefined,
        model: undefined,
        parts: [{ text: expect.stringContaining("Continue solving open issues"), type: "text" }],
      },
      path: { id: "ses_root" },
      query: { directory: repoDir },
    });
  });

  it("logs and skips continuation when session todo payloads are malformed", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {}, {
        todo: async () => ({
          data: { items: [] },
        }),
      }),
    );

    await emitIdle(plugin, "ses_root");

    expect(prompts).toHaveLength(0);
    expect(maybeReadContinuationState(repoDir)).toBeUndefined();
    await waitForContinuationLogToContain(repoDir, "Invalid session todo payload for ses_root.");
  });

  it("forwards the cached session agent and model when enqueuing continuation", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: {
          info: {
            agent: "Hephaestus",
            modelID: "gpt-5.4",
            providerID: "openai",
            role: "assistant",
            sessionID: "ses_root",
            time: { completed: Date.now() },
          },
        },
        type: "message.updated",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      agent: "Hephaestus",
      model: { modelID: "gpt-5.4", providerID: "openai" },
      sessionID: "ses_root",
    });
  });

  it("recovers the session agent and model from session history when no message cache exists", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {}, {
        messages: async () => ({
          data: [
            {
              info: {
                agent: "Hephaestus",
                model: { modelID: "gpt-5.4", providerID: "openai" },
                role: "user",
              },
            },
          ],
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      agent: "Hephaestus",
      model: { modelID: "gpt-5.4", providerID: "openai" },
      sessionID: "ses_root",
    });
  });

  it("clears prompt reservations when session message payloads are malformed", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {}, {
        messages: async () => ({
          data: { items: [] },
        }),
      }),
    );

    await emitIdle(plugin, "ses_root");

    const continuationState = readContinuationState(repoDir);
    expect(prompts).toHaveLength(0);
    expect(continuationState.ownerSessionID).toBe("ses_root");
    expect(continuationState.lastPromptFingerprint).toBeUndefined();
    expect(continuationState.pendingPromptFingerprint).toBeUndefined();
    expect(continuationState.pendingWhipTaskID).toBeUndefined();
    await waitForContinuationLogToContain(repoDir, "Invalid session messages payload for ses_root.");
  });

  it("delays TUI-triggered continuation and cancels it if the session becomes busy again", async () => {
    vi.useFakeTimers();

    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "tui.prompt.append",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    await vi.advanceTimersByTimeAsync(44_000);
    expect(prompts).toHaveLength(0);

    await plugin.event?.({
      event: {
        properties: {
          sessionID: "ses_root",
          status: { type: "busy" },
        },
        type: "session.status",
      },
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(prompts).toHaveLength(0);
  });

  it("uses the wrapper default 45s delay after TUI activity", async () => {
    vi.useFakeTimers();

    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_tui" },
        type: "tui.prompt.append",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_tui" },
        type: "session.idle",
      },
    });

    await vi.advanceTimersByTimeAsync(44_000);
    expect(prompts).toHaveLength(0);

    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const log = await readFile(path.join(repoDir, ".umpire", "continuation.log"), "utf8");
    expect(log).toContain("Delaying continuation prompt after idle TUI event.");
    expect(log).toContain('"delayMs":45000');
  });

  it("preserves a delayed prompt when another session triggers stale-session pruning", async () => {
    vi.useFakeTimers();
    const baseTime = new Date("2026-03-24T00:00:00.000Z");
    vi.setSystemTime(baseTime);

    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin({
      ...createContext(repoDir, prompts, []),
      idleDelayMs: 31 * 60 * 1000,
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_delayed" },
        type: "tui.prompt.append",
      },
    });

    await emitIdle(plugin, "ses_delayed");
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1_000);

    await plugin.event?.({
      event: {
        properties: {
          info: {
            role: "assistant",
            sessionID: "ses_other",
            time: { completed: Date.now() },
          },
        },
        type: "message.updated",
      },
    });

    expect(prompts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    vi.useRealTimers();

    for (let attempt = 0; attempt < 20 && prompts.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_delayed");
  });

  it("recovers with a later live root session after ignoring a missing current session event", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];

    const seededState = await seedClaimedOwnershipState(repoDir, "ses_owner");

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {
        ses_missing: null,
        ses_owner: null,
        ses_root: { id: "ses_root" },
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_missing" },
        type: "session.idle",
      },
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_root");
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_root");
    expect(readContinuationState(repoDir).lastPromptFingerprint).toBe(
      expectPendingPromptFingerprint(seededState.capturedContinuationState),
    );
  });

  it("evicts stale session state so expired sessions reload cached metadata and todos", async () => {
    vi.useFakeTimers();
    const baseTime = new Date("2026-03-24T00:00:00.000Z");
    vi.setSystemTime(baseTime);

    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const activeTodos = [{ content: "Keep working", id: "todo-1", priority: "high", status: "in_progress" }];
    let sessionInfoLookups = 0;
    let todoFetches = 0;
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, activeTodos, {}, {
        get: async (input) => {
          sessionInfoLookups += 1;
          return { data: { id: input.path.id } };
        },
        todo: async () => {
          todoFetches += 1;
          return { data: activeTodos };
        },
      }),
    );

    await emitIdle(plugin, "ses_stale");

    expect(prompts).toHaveLength(0);
    expect(sessionInfoLookups).toBe(1);
    expect(todoFetches).toBe(1);

    vi.setSystemTime(new Date(baseTime.getTime() + 24 * 60 * 60 * 1000));
    await emitIdle(plugin, "ses_fresh");
    await emitIdle(plugin, "ses_stale");

    expect(sessionInfoLookups).toBe(3);
    expect(todoFetches).toBe(3);

    vi.useRealTimers();
    await waitForContinuationLogToContain(repoDir, "Evicted stale continuation session state entries.");
  });

  it("logs how many stale session states were pruned on a later event", async () => {
    vi.useFakeTimers();
    const baseTime = new Date("2026-03-24T00:00:00.000Z");
    vi.setSystemTime(baseTime);

    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const activeTodos = [{ content: "Keep working", id: "todo-1", priority: "high", status: "in_progress" }];
    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, activeTodos));

    for (const sessionID of ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5"]) {
      await emitIdle(plugin, sessionID);
    }

    vi.setSystemTime(new Date(baseTime.getTime() + 24 * 60 * 60 * 1000));
    await emitIdle(plugin, "ses_trigger");

    vi.useRealTimers();
    await waitForContinuationLogToContain(repoDir, "Evicted stale continuation session state entries.");
    const log = await readContinuationLog(repoDir);
    expect(log).toContain('"evictedSessionCount":5');
  });

  it("re-prompts the pending whip task when the previous owner disappears before reservation finalization", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];
    const sessionInfoByID: Record<string, SessionInfoRecord | null> = {
      ses_primary: null,
      ses_secondary: { id: "ses_secondary" },
    };

    const seededState = await seedPendingWhipReservation(repoDir, {
      ownerSessionID: "ses_primary",
      pendingPromptUpdatedAt: new Date().toISOString(),
    });

    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], sessionInfoByID),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_secondary" },
        type: "session.idle",
      },
    });

    const activeTask = expectWhipTaskFromContinuationState(
      seededState.whipState ?? readWhipState(repoDir),
      seededState.capturedContinuationState,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_secondary");
    expect(prompts[0]?.text).toContain(`Selected task: ${activeTask.title}.`);
    expect(readWhipState(repoDir).tasks.find((task) => task.id === activeTask.id)?.status).toBe("in_progress");
    const continuationState = readContinuationState(repoDir);
    expect(continuationState.activeWhipTaskID).toBe(activeTask.id);
    expect(continuationState.lastPromptFingerprint).toBe(
      expectPendingPromptFingerprint(seededState.capturedContinuationState),
    );
    expect(continuationState.ownerSessionID).toBe("ses_secondary");
    expect(continuationState.pendingPromptFingerprint).toBeUndefined();
    expect(continuationState.pendingWhipTaskID).toBeUndefined();
  });

  it("clears pending prompt reservations after a prompt failure so the owner can retry", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    let attempts = 0;
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {}, {
        promptAsync: async (input) => {
          attempts += 1;
          if (attempts === 1) {
            return { error: { name: "PromptError" } };
          }

          const [firstPart] = input.body?.parts ?? [];
          if (firstPart !== undefined) {
            prompts.push({ sessionID: input.path.id, text: firstPart.text });
          }

          return { data: undefined };
        },
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    await waitForContinuationLogToContain(
      repoDir,
      "Failed to enqueue continuation prompt for session ses_root (error={\"name\":\"PromptError\"}).",
    );
    const errorLog = await readContinuationLog(repoDir);
    expect(errorLog).toContain('"fingerprint":"issues:26"');
    expect(errorLog).toContain('"kind":"issue"');
    expect(errorLog).toContain('"sessionID":"ses_root"');
    expect(errorLog).toContain('"type":"session.idle"');
    expect(readContinuationState(repoDir).pendingPromptFingerprint).toBeUndefined();

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(readContinuationState(repoDir).lastPromptFingerprint).toBe("issues:26");
  });

  it("forwards structured delayed prompt failures to client.app.log", async () => {
    vi.useFakeTimers();

    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const appLog = vi.fn();
    let promptAttempts = 0;
    const plugin = await AiUmpireContinuationPlugin({
      ...createContext(repoDir, prompts, [], {}, {
        appLog,
        promptAsync: async () => {
          promptAttempts += 1;
          return { error: { name: "PromptError" } };
        },
      }),
      idleDelayMs: 1_000,
    });

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_delayed_error" },
        type: "tui.prompt.append",
      },
    });

    await emitIdle(plugin, "ses_delayed_error");
    await vi.advanceTimersByTimeAsync(1_001);
    vi.useRealTimers();

    let errorMessages: string[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      errorMessages = appLog.mock.calls
        .map(([input]) => input.body)
        .filter((body) => body.level === "error")
        .map((body) => body.message);
      if (promptAttempts === 1 && errorMessages.length === 1) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(promptAttempts).toBe(1);
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toContain(
      "Failed to enqueue continuation prompt for session ses_delayed_error (error={\"name\":\"PromptError\"}).",
    );
    expect(errorMessages[0]).toContain('"fingerprint":"issues:26"');
    expect(errorMessages[0]).toContain('"kind":"issue"');
    expect(errorMessages[0]).toContain('"sessionID":"ses_delayed_error"');
    expect(errorMessages[0]).not.toContain('"type":');
  });

  it("logs HTTP status, URL, and error payload when session fetch fails for a non-404 response", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const plugin = await AiUmpireContinuationPlugin(
      createContext(repoDir, prompts, [], {}, {
        get: async () => ({
          error: { data: { directory: "bad" }, errors: [{ path: "directory" }], success: false },
          response: { status: 400, url: "http://localhost:4096/session/ses_root?directory=bad" },
        }),
      }),
    );

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(0);
    await waitForContinuationLogToContain(
      repoDir,
      "Failed to fetch session for session ses_root (status 400; http://localhost:4096/session/ses_root?directory=bad; error={\"data\":{\"directory\":\"bad\"},\"errors\":[{\"path\":\"directory\"}],\"success\":false}).",
    );
  });

  it("converts stale pending reservations into delivered fingerprints instead of re-enqueueing", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];

    const seededState = await seedPendingIssueReservation(
      repoDir,
      new Date(Date.now() - 10 * 60_000).toISOString(),
    );

    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(0);
    expect(readContinuationState(repoDir).pendingPromptFingerprint).toBeUndefined();
    expect(readContinuationState(repoDir).lastPromptFingerprint).toBe(
      expectPendingPromptFingerprint(seededState.continuationState),
    );
  });

  it("re-enqueues a stale pending whip reservation instead of auto-completing it", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];

    const seededState = await seedPendingWhipReservation(
      repoDir,
      { pendingPromptUpdatedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    );

    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, [], {
      ses_root: { id: "ses_root" },
    }));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    const continuationState = readContinuationState(repoDir);
    const activeTask = expectWhipTaskFromContinuationState(
      seededState.whipState ?? readWhipState(repoDir),
      seededState.capturedContinuationState,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_root");
    expect(prompts[0]?.text).toContain(`Selected task: ${activeTask.title}.`);
    expect(readWhipState(repoDir).tasks.find((task) => task.id === activeTask.id)?.status).toBe("in_progress");
    expect(continuationState.activeWhipTaskID).toBe(activeTask.id);
    expect(continuationState.lastPromptFingerprint).toBe(
      expectPendingPromptFingerprint(seededState.capturedContinuationState),
    );
    expect(continuationState.ownerSessionID).toBe("ses_root");
    expect(continuationState.pendingPromptFingerprint).toBeUndefined();
    expect(continuationState.pendingWhipTaskID).toBeUndefined();
  });

  it("re-enqueues a pending whip reservation with no timestamp instead of auto-completing it", async () => {
    const repoDir = await createTempDir(false);
    const prompts: PromptRecord[] = [];

    const seededState = await seedPendingWhipReservation(repoDir);

    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, [], {
      ses_root: { id: "ses_root" },
    }));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    const continuationState = readContinuationState(repoDir);
    const activeTask = expectWhipTaskFromContinuationState(
      seededState.whipState ?? readWhipState(repoDir),
      seededState.capturedContinuationState,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_root");
    expect(prompts[0]?.text).toContain(`Selected task: ${activeTask.title}.`);
    expect(readWhipState(repoDir).tasks.find((task) => task.id === activeTask.id)?.status).toBe("in_progress");
    expect(continuationState.activeWhipTaskID).toBe(activeTask.id);
    expect(continuationState.lastPromptFingerprint).toBe(
      expectPendingPromptFingerprint(seededState.capturedContinuationState),
    );
    expect(continuationState.ownerSessionID).toBe("ses_root");
    expect(continuationState.pendingPromptFingerprint).toBeUndefined();
    expect(continuationState.pendingWhipTaskID).toBeUndefined();
  });

  it("skips prompting while another continuation lock file exists", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const lockPath = path.join(repoDir, ".umpire", "continuation.lock");

    await mkdir(path.join(repoDir, ".umpire"), { recursive: true });
    await writeFile(lockPath, "other-owner", "utf8");

    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(0);
    expect(maybeReadContinuationState(repoDir)).toBeUndefined();
    await waitForContinuationLogToContain(
      repoDir,
      "Skipping continuation because the lock is already held.",
    );
  });

  it("recovers stale continuation locks and retries prompting", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const lockPath = path.join(repoDir, ".umpire", "continuation.lock");
    const staleTimestamp = new Date(Date.now() - 15 * 60_000);

    await mkdir(path.join(repoDir, ".umpire"), { recursive: true });
    await writeFile(lockPath, "stale-owner", "utf8");
    await utimes(lockPath, staleTimestamp, staleTimestamp);

    const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, prompts, []));

    await plugin.event?.({
      event: {
        properties: { sessionID: "ses_root" },
        type: "session.idle",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_root");
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_root");
    await waitForContinuationLogToContain(
      repoDir,
      "Removed stale continuation lock before retrying acquisition.",
    );
  });

  it("times out a hung ready-issue probe and falls back to full priority ordering", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const commandTimeoutMs = 75;
    const restorePath = await installFakeGhBinary(`
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  setInterval(() => {}, 1000);
} else {
  process.stderr.write("Unexpected gh invocation: " + args.join(" ") + "\\n");
  process.exit(1);
}
`);

    try {
      const plugin = await AiUmpireContinuationPlugin({
        ...createContext(repoDir, prompts, []),
        commandTimeoutMs,
      });

      await emitIdle(plugin, "ses_root");
    } finally {
      restorePath();
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_root");
    expect(prompts[0]?.text).toContain("Continue solving open issues from gh-priority-order.sh.");
    expect(readContinuationState(repoDir).lastPromptFingerprint).toBe("issues:26");
    await waitForContinuationLogToContain(repoDir, "Ready issue probe failed; falling back to full priority order summary.");
    await waitForContinuationLogToContain(repoDir, `Command gh timed out after ${commandTimeoutMs}ms and was killed with SIGKILL.`);
  });

  it("releases the serialized event chain after a hung priority-order script times out", async () => {
    const repoDir = await createTempDir(true);
    const prompts: PromptRecord[] = [];
    const commandTimeoutMs = 75;
    const childPidPath = path.join(repoDir, ".priority-order-child.pid");
    const scriptPath = path.join(repoDir, "scripts", "gh-priority-order.sh");
    const restorePath = await installFakeGhBinary(`
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ labels: [{ name: "S-Ready" }], number: 26 }]));
} else {
  process.stderr.write("Unexpected gh invocation: " + args.join(" ") + "\\n");
  process.exit(1);
}
`);

    await writeFile(
      scriptPath,
      `#!/usr/bin/env bash
CHILD_PID_PATH=${JSON.stringify(childPidPath)}
if [ "\${1:-}" = "--json" ]; then
  node -e 'setInterval(() => {}, 1000)' &
  child_pid=$!
  printf '%s' "$child_pid" > "$CHILD_PID_PATH"
  wait "$child_pid"
  exit 0
fi
printf 'Commands:\n  ./scripts/gh-priority-order.sh --help'
`,
      "utf8",
    );
    await chmod(scriptPath, 0o755);

    try {
      const plugin = await AiUmpireContinuationPlugin({
        ...createContext(repoDir, prompts, []),
        commandTimeoutMs,
      });

      await emitIdle(plugin, "ses_timeout");

      expect(prompts).toHaveLength(0);
      await waitForContinuationLogToContain(repoDir, `Command bash timed out after ${commandTimeoutMs}ms and was killed with SIGKILL.`);
      const childPID = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
      expect(childPID).toBeGreaterThan(0);
      await waitForProcessToExit(childPID);

      await installStubPriorityOrderScript(
        repoDir,
        {
          blockedIssues: [],
          inProgress: [],
          issues: [
            {
              component: "",
              labels: ["P2-High", "S-Ready"],
              number: 26,
              priority: "P2-High",
              score: 550,
              status: "S-Ready",
              title: "Ship continuation plugin",
            },
          ],
          nextIssue: 26,
          readyIssues: [26],
          version: 1,
        },
        "1. #26: Ship continuation plugin [P2-High, S-Ready]",
      );

      await emitIdle(plugin, "ses_timeout");
    } finally {
      restorePath();
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe("ses_timeout");
    expect(prompts[0]?.text).toContain("Continue solving open issues from gh-priority-order.sh.");
    expect(readContinuationState(repoDir).lastPromptFingerprint).toBe("issues:26");
    expect(readContinuationState(repoDir).ownerSessionID).toBe("ses_timeout");
  });
});

async function createTempDir(withReadyIssue: boolean): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-umpire-opencode-plugin-"));
  tempDirs.push(tempDir);
  execFileSync("git", ["init", "-q"], { cwd: tempDir });

  const scriptDir = path.join(tempDir, "scripts");
  const queueSummary: QueueSummaryFixture = withReadyIssue
    ? {
        blockedIssues: [],
        inProgress: [],
        issues: [
          {
            component: "",
            labels: ["P2-High", "S-Ready"],
            number: 26,
            priority: "P2-High",
            score: 550,
            status: "S-Ready",
            title: "Ship continuation plugin",
          },
        ],
        nextIssue: 26,
        readyIssues: [26],
        version: 1,
      }
    : {
        blockedIssues: [],
        inProgress: [],
        issues: [],
        nextIssue: null,
        readyIssues: [],
        version: 1,
      };
  const humanOutput = withReadyIssue
    ? "1. #26: Ship continuation plugin [P2-High, S-Ready]"
    : "Commands:\n  ./scripts/gh-priority-order.sh --help";
  await mkdir(scriptDir, { recursive: true });
  await installQueuePolicyFiles(tempDir);
  await rm(path.join(tempDir, ".umpire"), { force: true, recursive: true });
  await installStubPriorityOrderScript(tempDir, queueSummary, humanOutput);
  await installFakeGhIssueListSequence([withReadyIssue ? [26] : []]);
  return tempDir;
}

async function installStubPriorityOrderScript(
  repoDir: string,
  queueSummary: QueueSummaryFixture,
  humanOutput: string,
): Promise<void> {
  await writeFile(
    path.join(repoDir, "scripts", "gh-priority-order.sh"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--json" ]; then
  cat <<'EOF'
${JSON.stringify(queueSummary)}
EOF
else
  cat <<'EOF'
${humanOutput}
EOF
fi
`,
    "utf8",
  );
  await chmod(path.join(repoDir, "scripts", "gh-priority-order.sh"), 0o755);
}

async function installRealPriorityOrderScript(repoDir: string): Promise<void> {
  await installQueuePolicyFiles(repoDir);
  const targetPath = path.join(repoDir, "scripts", "gh-priority-order.sh");
  await copyFile(path.join(repoRoot, "scripts", "gh-priority-order.sh"), targetPath);
  await chmod(targetPath, 0o755);
}

async function installCountingPriorityOrderScript(
  repoDir: string,
  queueSummaries: QueueSummaryFixture[],
): Promise<string> {
  const countPath = path.join(repoDir, ".priority-order-count");
  const outputPaths: string[] = [];

  for (const [index, summary] of queueSummaries.entries()) {
    const outputPath = path.join(repoDir, `.priority-order-output-${index}.json`);
    await writeFile(outputPath, JSON.stringify(summary), "utf8");
    outputPaths.push(outputPath);
  }

  const caseArms = outputPaths
    .map((outputPath, index) => `  ${index}) cat ${JSON.stringify(outputPath)} ;;
`)
    .join("");

  await writeFile(
    path.join(repoDir, "scripts", "gh-priority-order.sh"),
    `#!/usr/bin/env bash
COUNT_PATH=${JSON.stringify(countPath)}
count=0
if [ -f "$COUNT_PATH" ]; then
  count=$(cat "$COUNT_PATH")
fi
printf '%s' "$((count + 1))" > "$COUNT_PATH"

index="$count"
max_index=${Math.max(outputPaths.length - 1, 0)}
if [ "$index" -gt "$max_index" ]; then
  index="$max_index"
fi

if [ "\${1:-}" = "--json" ]; then
  case "$index" in
${caseArms}  esac
else
  printf 'Commands:\n  ./scripts/gh-priority-order.sh --help'
fi
`,
    "utf8",
  );
  await chmod(path.join(repoDir, "scripts", "gh-priority-order.sh"), 0o755);

  return countPath;
}

async function installQueuePolicyFiles(repoDir: string): Promise<void> {
  await mkdir(path.join(repoDir, "scripts"), { recursive: true });
  await copyFile(path.join(repoRoot, "queue-policy.json"), path.join(repoDir, "queue-policy.json"));
  await copyFile(
    path.join(repoRoot, "scripts", "_queue-policy.sh"),
    path.join(repoDir, "scripts", "_queue-policy.sh"),
  );
  await chmod(path.join(repoDir, "scripts", "_queue-policy.sh"), 0o755);
}

async function installFakeGhBinary(ghBody: string): Promise<() => void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-umpire-gh-bin-"));
  tempDirs.push(tempDir);

  const binDir = path.join(tempDir, "bin");
  const ghPath = path.join(binDir, "gh");
  const previousPath = process.env.PATH;

  await mkdir(binDir, { recursive: true });
  await writeFile(ghPath, `#!/usr/bin/env node\n${ghBody.trim()}\n`, "utf8");
  await chmod(ghPath, 0o755);

  process.env.PATH = `${binDir}:${previousPath ?? ""}`;

  let restored = false;
  const restorePath = () => {
    if (restored) {
      return;
    }
    restored = true;

    if (previousPath === undefined) {
      delete process.env.PATH;
      return;
    }

    process.env.PATH = previousPath;
  };

  pathRestorers.push(restorePath);
  return restorePath;
}

async function installFakeGhIssueListSequence(
  readyIssuesByInvocation: readonly (readonly GhIssueListEntryFixture[])[],
): Promise<() => void> {
  const countPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "ai-umpire-gh-count-")),
    "issue-list-count.txt",
  );
  tempDirs.push(path.dirname(countPath));

  return installFakeGhBinary(`
const fs = require("node:fs");

const outputs = ${JSON.stringify(
    readyIssuesByInvocation.map((issues) => issues.map((issue) => {
      if (typeof issue === "number") {
        return { labels: [], number: issue };
      }

      return {
        labels: (issue.labels ?? []).map((name) => ({ name })),
        number: issue.number,
      };
    })),
  )};
const countPath = ${JSON.stringify(countPath)};
const args = process.argv.slice(2);

if (args[0] !== "issue" || args[1] !== "list") {
  process.stderr.write("Unexpected gh invocation: " + args.join(" ") + "\\n");
  process.exit(1);
}

let count = 0;
try {
  count = Number(fs.readFileSync(countPath, "utf8"));
  if (!Number.isFinite(count) || count < 0) {
    count = 0;
  }
} catch (error) {
  if (!error || error.code !== "ENOENT") {
    throw error;
  }
}

fs.writeFileSync(countPath, String(count + 1));
const index = Math.min(count, Math.max(outputs.length - 1, 0));
process.stdout.write(JSON.stringify(outputs[index] ?? []));
`);
}

function createContext(
  repoDir: string,
  prompts: PromptRecord[],
  todos: Array<{ content: string; id: string; priority: string; status: string }>,
  sessionInfoByID: Record<string, SessionInfoRecord | null> = {},
  overrides: ContextOverrides = {},
) {
  return {
    client: {
      app: {
        log: (input: { body: { level: "debug" | "error" | "info"; message: string } }) => {
          if (overrides.appLog !== undefined) {
            return overrides.appLog(input);
          }

          return undefined;
        },
      },
      session: {
        get: async (input: { path: { id: string }; query?: { directory?: string } }) => {
          const sessionID = input.path.id;
          if (overrides.get !== undefined) {
            return overrides.get(input);
          }

          const info = sessionInfoByID[sessionID];
          if (info === null) {
            return { error: { name: "NotFoundError" } };
          }

          return {
            data: info ?? { id: sessionID },
          };
        },
        messages: async (input: {
          path: { id: string };
          query?: { directory?: string; limit?: number };
        }) => {
          if (overrides.messages !== undefined) {
            return overrides.messages(input);
          }

          return { data: [] };
        },
        promptAsync: async (input: {
          body?: {
            agent?: string;
            model?: { modelID: string; providerID: string };
            parts?: Array<{ text: string }>;
          };
          path: { id: string };
          query?: { directory?: string };
        }) => {
          if (overrides.promptAsync !== undefined) {
            return overrides.promptAsync(input);
          }

          const [firstPart] = input.body?.parts ?? [];
          if (firstPart !== undefined) {
            prompts.push({
              agent: input.body?.agent,
              model: input.body?.model,
              sessionID: input.path.id,
              text: firstPart.text,
            });
          }

          return { data: undefined };
        },
        todo: async (input: { path: { id: string }; query?: { directory?: string } }) => {
          if (overrides.todo !== undefined) {
            return overrides.todo(input);
          }

          return { data: todos };
        },
      },
    },
    directory: repoDir,
    worktree: repoDir,
  };
}

function readQueuePolicy(repoDir: string): QueuePolicyFixture {
  return JSON.parse(readFileSync(path.join(repoDir, "queue-policy.json"), "utf8")) as QueuePolicyFixture;
}

function readQueuePolicyDocument(repoDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoDir, "queue-policy.json"), "utf8")) as Record<string, unknown>;
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

function readWhipState(repoDir: string) {
  return JSON.parse(
    readFileSync(path.join(repoDir, ".umpire", "whip.json"), "utf8"),
  ) as WhipState;
}

function readContinuationState(repoDir: string) {
  return JSON.parse(
    readFileSync(path.join(repoDir, ".umpire", "continuation-state.json"), "utf8"),
  ) as StoredContinuationState;
}

function readPriorityOrderInvocationCount(countPath: string): number {
  try {
    return Number(readFileSync(countPath, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return 0;
    }

    throw error;
  }
}

function maybeReadWhipState(repoDir: string) {
  try {
    return readWhipState(repoDir);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }

    throw error;
  }
}

function maybeReadContinuationState(repoDir: string) {
  try {
    return readContinuationState(repoDir);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }

    throw error;
  }
}

async function readContinuationLog(repoDir: string): Promise<string> {
  const logPath = path.join(repoDir, ".umpire", "continuation.log");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await readFile(logPath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        await waitForPollingTurn();
        continue;
      }

      throw error;
    }
  }

  return readFile(logPath, "utf8");
}

async function waitForContinuationLogToContain(repoDir: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const log = await readContinuationLog(repoDir);
    if (log.includes(text)) {
      return;
    }

    await waitForPollingTurn();
  }

  expect(await readContinuationLog(repoDir)).toContain(text);
}

async function waitForFileToExist(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await stat(filePath);
      return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        await waitForPollingTurn();
        continue;
      }

      throw error;
    }
  }

  await stat(filePath);
}

async function removePathEventually(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(targetPath, { force: true, recursive: true });
      return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOTEMPTY" || error.code === "EPERM")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }

      throw error;
    }
  }

  await rm(targetPath, { force: true, recursive: true });
}

async function waitForProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessRunning(pid)) {
      return;
    }

    await waitForPollingTurn();
  }

  expect(isProcessRunning(pid)).toBe(false);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }

    throw error;
  }
}

async function waitForPollingTurn(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
}

function expectPendingPromptFingerprint(continuationState: StoredContinuationState): string {
  if (continuationState.pendingPromptFingerprint === undefined) {
    throw new Error("Expected a pending prompt fingerprint in seeded continuation state.");
  }

  return continuationState.pendingPromptFingerprint;
}

function expectWhipTaskFromContinuationState(
  whipState: WhipState,
  continuationState: StoredContinuationState,
): WhipTask {
  const taskID = continuationState.activeWhipTaskID ?? continuationState.pendingWhipTaskID;
  if (taskID === undefined) {
    throw new Error("Expected an active or pending whip task id in continuation state.");
  }

  const task = whipState.tasks.find((candidate) => candidate.id === taskID);
  if (task === undefined) {
    throw new Error(`Expected whip state to include task ${taskID}.`);
  }

  return task;
}

async function emitIdle(plugin: TestPlugin, sessionID: string): Promise<void> {
  await plugin.event?.({
    event: {
      properties: { sessionID },
      type: "session.idle",
    },
  });
}

async function captureControllerStateDuringPrompt(
  repoDir: string,
  sessionID: string,
): Promise<{ continuationState: StoredContinuationState; whipState?: WhipState }> {
  let capturedContinuationState: StoredContinuationState | undefined;
  let capturedWhipState: WhipState | undefined;

  const plugin = await AiUmpireContinuationPlugin(
    createContext(repoDir, [], [], {}, {
      promptAsync: async () => {
        capturedContinuationState = readContinuationState(repoDir);
        capturedWhipState = maybeReadWhipState(repoDir);
        return { error: { name: "PromptError" } };
      },
    }),
  );

  await emitIdle(plugin, sessionID);

  if (capturedContinuationState === undefined) {
    throw new Error(`Failed to capture controller state during prompt for session ${sessionID}.`);
  }

  return {
    continuationState: capturedContinuationState,
    whipState: capturedWhipState,
  };
}

async function writeWhipState(repoDir: string, state: WhipState): Promise<void> {
  await mkdir(path.join(repoDir, ".umpire"), { recursive: true });
  await writeFile(
    path.join(repoDir, ".umpire", "whip.json"),
    JSON.stringify(state, null, 2).concat("\n"),
    "utf8",
  );
}

async function writeContinuationState(repoDir: string, state: StoredContinuationState): Promise<void> {
  await mkdir(path.join(repoDir, ".umpire"), { recursive: true });
  await writeFile(
    path.join(repoDir, ".umpire", "continuation-state.json"),
    JSON.stringify(state, null, 2).concat("\n"),
    "utf8",
  );
}

async function seedClaimedOwnershipState(
  repoDir: string,
  ownerSessionID: string,
): Promise<SeededFixtureState> {
  const capturedState = await captureControllerStateDuringPrompt(repoDir, ownerSessionID);

  return {
    capturedContinuationState: capturedState.continuationState,
    continuationState: readContinuationState(repoDir),
    whipState: capturedState.whipState,
  };
}

async function seedPendingIssueReservation(
  repoDir: string,
  pendingPromptUpdatedAt: string,
  ownerSessionID = "ses_root",
): Promise<SeededFixtureState> {
  const capturedState = await captureControllerStateDuringPrompt(repoDir, ownerSessionID);
  await writeContinuationState(repoDir, {
    ...capturedState.continuationState,
    pendingPromptUpdatedAt,
  });

  return {
    capturedContinuationState: capturedState.continuationState,
    continuationState: readContinuationState(repoDir),
    whipState: capturedState.whipState,
  };
}

async function seedPendingWhipReservation(
  repoDir: string,
  options: {
    ownerSessionID?: string;
    pendingPromptUpdatedAt?: string;
  } = {},
): Promise<SeededFixtureState> {
  const ownerSessionID = options.ownerSessionID ?? "ses_root";
  const capturedState = await captureControllerStateDuringPrompt(repoDir, ownerSessionID);
  const { continuationState, whipState } = capturedState;

  if (whipState === undefined) {
    throw new Error(`Failed to capture whip state during prompt for session ${ownerSessionID}.`);
  }

  await writeWhipState(repoDir, whipState);
  await writeContinuationState(repoDir, {
    ...continuationState,
    ...(options.pendingPromptUpdatedAt === undefined
      ? { pendingPromptUpdatedAt: undefined }
      : { pendingPromptUpdatedAt: options.pendingPromptUpdatedAt }),
  });

  return {
    capturedContinuationState: capturedState.continuationState,
    continuationState: readContinuationState(repoDir),
    whipState: readWhipState(repoDir),
  };
}

async function seedInProgressWhipState(repoDir: string): Promise<SeededFixtureState> {
  const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, [], []));
  await emitIdle(plugin, "ses_seed");
  const continuationState = readContinuationState(repoDir);
  const whipState = readWhipState(repoDir);
  await rm(path.join(repoDir, ".umpire", "continuation-state.json"), { force: true });

  return {
    capturedContinuationState: continuationState,
    continuationState,
    whipState,
  };
}

async function seedOwnedInProgressWhipState(
  repoDir: string,
  ownerSessionID: string,
  updatedAt?: string,
): Promise<SeededFixtureState> {
  const plugin = await AiUmpireContinuationPlugin(createContext(repoDir, [], [], {
    [ownerSessionID]: { id: ownerSessionID },
  }));
  await emitIdle(plugin, ownerSessionID);

  if (updatedAt !== undefined) {
    const continuationState = readContinuationState(repoDir);
    await writeContinuationState(repoDir, {
      ...continuationState,
      updatedAt,
    });
  }

  return {
    capturedContinuationState: readContinuationState(repoDir),
    continuationState: readContinuationState(repoDir),
    whipState: readWhipState(repoDir),
  };
}
