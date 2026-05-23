import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type * as Config from "../src/config.ts";
import type * as State from "../src/state.ts";
import type * as Status from "../src/status.ts";
import type { AiuTrustedStateAdapterResult, AiuTrustedCommandExecutionRecord } from "../src/trusted_adapter.ts";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const aiuBin = path.join(repoRoot, "dist/src/bin/aiu.js");
const observedAt = "2026-05-23T00:00:00.000Z";

describe("status reporting", () => {
  it("renders typed reports for continue, repair, wait, and stop decisions", async () => {
    const { createAiuStatusReport } = await loadStatus();

    const cases = [
      {
        name: "continue",
        states: [envelope("work", workQueueState({ activeItems: [workItem("47", "active")] }))],
        expectedKind: "continue",
        expectedPrompt: "work",
      },
      {
        name: "repair",
        states: [envelope("repository", repositoryState({ dirty: "fail" }))],
        expectedKind: "repair",
        expectedPrompt: "repair",
      },
      {
        name: "wait",
        states: [envelope("host", hostSessionState({ sessionStatus: "busy", canPrompt: false }))],
        expectedKind: "wait",
        expectedPrompt: "wait",
      },
      {
        name: "stop",
        states: [envelope("planning", planningState({ humanInputRequired: true }))],
        expectedKind: "stop",
        expectedPrompt: "stop",
      },
    ] as const;

    for (const item of cases) {
      const report = createAiuStatusReport(await configLoad(), await Promise.all(item.states.map(successResult)));

      assert.equal(report.decision.kind, item.expectedKind, item.name);
      assert.equal(report.prompt.kind, item.expectedPrompt, item.name);
      assert.equal(report.errors.length, 0, item.name);
      assert.equal(report.reasonLabels.length, report.decision.reasonCodes.length, item.name);
      assert.equal(report.prompt.fingerprint.length, 64, item.name);
    }
  });

  it("surfaces malformed, stale, unknown, and safety-block inputs in structured output", async () => {
    const { createAiuStatusReport } = await loadStatus();
    const malformed = createAiuStatusReport(await configLoad(), [await successResult(envelope("bad", workItem("bad", "active", "malformed")))]);
    const unknown = createAiuStatusReport(await configLoad(), [await successResult(envelope("unknown", workItem("unknown", "active", "unknown")))]);
    const stale = createAiuStatusReport(await configLoad(), [await successResult(envelope("work", workItem("stale", "active", "stale"), { freshness: "stale" }))]);
    const safety = createAiuStatusReport(await configLoad({ modes: ["stop"] }), [
      await successResult(envelope("work", workQueueState({ activeItems: [workItem("blocked-mode", "active")] }))),
    ]);

    assert.deepEqual(malformed.decision.reasonCodes, ["stop-malformed-input"]);
    assert.deepEqual(unknown.decision.reasonCodes, ["stop-unknown-input"]);
    assert.deepEqual(stale.decision.reasonCodes, ["stop-stale-input"]);
    assert.deepEqual(stale.staleSources.map((source) => source.sourceId), ["work"]);
    assert.deepEqual(safety.decision.reasonCodes, ["stop-safety-block"]);
  });

  it("blocks continuation when any configured adapter fails", async () => {
    const { createAiuStatusReport } = await loadStatus();
    const report = createAiuStatusReport(await configLoad(), [
      await successResult(envelope("work", workQueueState({ activeItems: [workItem("active", "active")] }))),
      failureResult("review", "trusted-command-timeout"),
    ]);

    assert.deepEqual(report.decision.reasonCodes, ["stop-malformed-input"]);
    assert.ok(report.errors.some((error) => error.code === "status-trusted-command-failed"));
    assert.ok(report.errors.some((error) => error.code === "trusted-command-timeout"));
  });

  it("emits clean status JSON and records adapter errors without live providers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aiu-status-"));
    try {
      const configPath = path.join(dir, "aiu.config.json");
      await writeFile(configPath, JSON.stringify({
        version: 1,
        trustedStateCommands: {
          malformed: {
            argv: [process.execPath, "-e", "process.stdout.write('{')"],
            timeoutMs: 1_000,
            maxOutputBytes: 16_384,
          },
        },
      }));

      const result = await runCli(["status", "--config", configPath, "--json"]);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        command: string;
        status: Status.AiuStatusReport;
      };

      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.equal(parsed.ok, true);
      assert.equal(parsed.command, "status");
      assert.equal(parsed.status.adapterRuns[0]?.ok, false);
      assert.ok(parsed.status.errors.some((error) => error.code === "status-trusted-command-failed"));
      assert.ok(parsed.status.errors.some((error) => error.code === "trusted-command-malformed-json"));
      assert.deepEqual(parsed.status.decision.reasonCodes, ["stop-malformed-input"]);
      assert.equal(parsed.status.inputEnvelopes.length, 0);
      assert.equal(parsed.status.paths.stateDir, path.join(repoRoot, ".umpire", "state"));
      assert.equal(parsed.status.paths.lockDir, path.join(repoRoot, ".umpire", "locks"));
      assert.equal(parsed.status.paths.logDir, path.join(repoRoot, ".umpire", "logs"));
      assert.match(parsed.status.paths.continuationState, /continuation\.json$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces quality idle targets in status and prompt output", async () => {
    const { createAiuStatusReport } = await loadStatus();
    const report = createAiuStatusReport(await configLoad(), [
      await successResult(envelope("quality", qualityState({
        ready: true,
        lastRunStatus: "fail",
        stages: [{
          id: "typecheck",
          status: "fail",
          affectedPaths: ["src/state.ts"],
          command: { id: "quality-typecheck", argv: ["pnpm", "run", "typecheck"] },
          rerunCommand: { id: "quality-typecheck", argv: ["pnpm", "run", "typecheck"] },
        }],
        failingChecks: ["typecheck"],
        affectedPaths: ["src/state.ts"],
      }))),
    ]);

    assert.deepEqual(report.decision.reasonCodes, ["continue-quality"]);
    assert.equal(report.decision.selectedItem?.id, "typecheck");
    assert.equal(report.decision.selectedItem?.targetKind, "stage");
    assert.equal(report.normalizedStateSummary.quality[0]?.selectedTarget, undefined);
    assert.deepEqual(report.normalizedStateSummary.quality[0]?.failingChecks, ["typecheck"]);
    assert.deepEqual(report.normalizedStateSummary.quality[0]?.affectedPaths, ["src/state.ts"]);
    assert.match(report.prompt.body, /Next configured command: "pnpm" "run" "typecheck"/);
    assert.match(report.prompt.body, /Do not treat agent narration/);

    const disabled = createAiuStatusReport(await configLoad({ qualityEnabled: false, whipEnabled: false }), [
      await successResult(envelope("quality", qualityState({
        ready: true,
        lastRunStatus: "fail",
        stages: [{ id: "typecheck", status: "fail", affectedPaths: [] }],
      }))),
    ]);
    assert.deepEqual(disabled.decision.reasonCodes, ["stop-clean"]);
  });

  it("surfaces Bootstrap planning actions in status and prompt output", async () => {
    const { createAiuStatusReport } = await loadStatus();
    const report = createAiuStatusReport(await configLoad(), [
      await successResult(envelope("planning", planningState({
        needsPlanning: true,
        currentPhase: "milestone-draft",
        draftPaths: ["docs/spec.md"],
        artifacts: [{ path: "docs/spec.md", status: "pass" }],
        providers: [{ id: "github", status: "pass" }],
        nextAction: {
          id: "bootstrap-plan",
          status: "pass",
          command: { id: "bootstrap-plan", argv: ["bootstrap", "plan"] },
          artifactChecks: ["docs/spec.md"],
          draftPaths: ["docs/M4-whip-tasks-quality-idle-work-and-planning-continuation.md"],
          expectedEvidence: "Updated Bootstrap planning artifacts.",
        },
      }))),
    ]);

    assert.deepEqual(report.decision.reasonCodes, ["continue-planning"]);
    assert.equal(report.decision.selectedItem?.id, "bootstrap-plan");
    assert.deepEqual(report.decision.selectedItem?.artifactChecks, ["docs/spec.md"]);
    assert.equal(report.normalizedStateSummary.planning[0]?.currentPhase, "milestone-draft");
    assert.equal(report.normalizedStateSummary.planning[0]?.selectedAction, "bootstrap-plan");
    assert.deepEqual(report.normalizedStateSummary.planning[0]?.draftPaths, ["docs/spec.md"]);
    assert.equal(report.normalizedStateSummary.planning[0]?.artifactCount, 1);
    assert.equal(report.normalizedStateSummary.planning[0]?.providerCount, 1);
    assert.match(report.prompt.body, /Continue planning/);
    assert.match(report.prompt.body, /do not start implementation work/i);
    assert.match(report.prompt.body, /"bootstrap" "plan"/);

    const disabled = createAiuStatusReport(await configLoad({ planningEnabled: false, whipEnabled: false }), [
      await successResult(envelope("planning", planningState({
        needsPlanning: true,
        nextAction: {
          id: "bootstrap-plan",
          status: "pass",
          artifactChecks: ["docs/spec.md"],
          draftPaths: [],
        },
      }))),
    ]);
    assert.deepEqual(disabled.decision.reasonCodes, ["stop-clean"]);
  });

  it("surfaces whip tasks in status and prompt output without completing them", async () => {
    const { createAiuStatusReport } = await loadStatus();
    const report = createAiuStatusReport(await configLoad({
      whipUsePackageDefaults: false,
      whipTasks: [{
        id: "repo-docs",
        title: "Review repo docs",
        prompt: "Review repository docs for stale aiu examples.",
        priority: 5,
      }],
    }), []);

    assert.deepEqual(report.decision.reasonCodes, ["continue-whip-task"]);
    assert.equal(report.decision.promptKind, "whip");
    assert.equal(report.decision.selectedItem?.id, "repo-docs");
    assert.equal(report.decision.selectedItem?.prompt, "Review repository docs for stale aiu examples.");
    assert.equal(report.prompt.kind, "whip");
    assert.equal(report.prompt.selectedItem?.id, "repo-docs");
    assert.match(report.prompt.body, /Prompt delivery does not complete the whip task/);
    assert.equal(report.whip.outcome, "prompt");
    assert.equal(report.whip.selectedTask?.id, "repo-docs");
    assert.equal(report.whip.promptDeliveryCompletesTask, false);
  });

  it("hard-stops malformed whip state before selecting idle work", async () => {
    const { createAiuStatusReport } = await loadStatus();
    const target = await mkdtemp(path.join(tmpdir(), "aiu-status-whip-malformed-"));
    try {
      await mkdir(path.join(target, ".umpire"), { recursive: true });
      await writeFile(path.join(target, ".umpire", "whip.json"), "{", "utf8");

      const report = createAiuStatusReport(await configLoad({ repoRoot: target }), []);

      assert.deepEqual(report.decision.reasonCodes, ["stop-malformed-input"]);
      assert.equal(report.decision.selectedItem?.kind, "whip");
      assert.equal(report.decision.selectedItem?.status, "malformed");
      assert.equal(report.whip.outcome, "prompt");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("emits concise human status output from the typed report", async () => {
    const result = await runCli(["status"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /decision: continue/);
    assert.match(result.stdout, /mode: continue/);
    assert.match(result.stdout, /stateDir: /);
    assert.match(result.stdout, /pendingPrompt: /);
    assert.match(result.stdout, /whip: prompt review-doc-command-examples/);
    assert.match(result.stdout, /reasons: continue-whip-task/);
    assert.match(result.stdout, /next: Continue: use the ready whip task slot\./);
  });
});

async function loadStatus(): Promise<typeof Status> {
  return await import(pathToFileURL(path.join(repoRoot, "dist/src/status.js")).href) as typeof Status;
}

async function loadState(): Promise<typeof State> {
  return await import(pathToFileURL(path.join(repoRoot, "dist/src/state.js")).href) as typeof State;
}

async function loadConfig(): Promise<typeof Config> {
  return await import(pathToFileURL(path.join(repoRoot, "dist/src/config.js")).href) as typeof Config;
}

async function envelope(sourceId: string, value: State.AiuTrustedStatePayload, options: { readonly freshness?: State.AiuStateFreshnessKind } = {}): Promise<State.AiuTrustedStateEnvelope> {
  const { createAiuTrustedStateEnvelope } = await loadState();
  return createAiuTrustedStateEnvelope({
    sourceId,
    command: { id: sourceId, argv: ["fixture"] },
    observedAt,
    trustLevel: "trusted",
    capabilities: {},
    freshness: {
      kind: options.freshness ?? "fresh",
      observedAt,
    },
    value,
  });
}

async function configLoad(options: {
  readonly supplyChainApprovalRequired?: boolean;
  readonly modes?: Config.AiuContinuationMode[];
  readonly planningEnabled?: boolean;
  readonly qualityEnabled?: boolean;
  readonly whipEnabled?: boolean;
  readonly whipUsePackageDefaults?: boolean;
  readonly whipTasks?: Config.AiuWhipTaskDefinition[];
  readonly repoRoot?: string;
} = {}): Promise<Config.AiuConfigLoadResult> {
  const { getDefaultAiuConfig } = await loadConfig();
  const config = getDefaultAiuConfig();
  return {
    ok: true,
    repoRoot: options.repoRoot ?? repoRoot,
    selectedPath: path.join(options.repoRoot ?? repoRoot, "aiu.config.json"),
    found: false,
    defaultsUsed: true,
    config: {
      ...config,
      supplyChain: {
        ...config.supplyChain,
        stopOnApprovalRequired: options.supplyChainApprovalRequired ?? config.supplyChain.stopOnApprovalRequired,
      },
      continuation: {
        ...config.continuation,
        modes: options.modes ?? config.continuation.modes,
      },
      planning: {
        ...config.planning,
        enabled: options.planningEnabled ?? config.planning.enabled,
      },
      quality: {
        ...config.quality,
        enabled: options.qualityEnabled ?? config.quality.enabled,
      },
      whip: {
        ...config.whip,
        enabled: options.whipEnabled ?? config.whip.enabled,
        usePackageDefaults: options.whipUsePackageDefaults ?? config.whip.usePackageDefaults,
        tasks: options.whipTasks ?? config.whip.tasks,
      },
    },
    diagnostics: [],
  };
}

async function successResult(state: Promise<State.AiuTrustedStateEnvelope> | State.AiuTrustedStateEnvelope): Promise<AiuTrustedStateAdapterResult> {
  const resolved = await state;
  return {
    ok: true,
    record: record(resolved.sourceId),
    states: [resolved],
  };
}

function record(sourceId: string): AiuTrustedCommandExecutionRecord {
  return {
    sourceId,
    command: { id: sourceId, argv: ["fixture"] },
    timeoutMs: 1_000,
    maxOutputBytes: 16_384,
    stdoutBytes: 0,
    stderrBytes: 0,
    stderrSummary: "",
    elapsedMs: 0,
    timedOut: false,
    outputLimitExceeded: false,
  };
}

function failureResult(sourceId: string, code: "trusted-command-timeout"): AiuTrustedStateAdapterResult {
  return {
    ok: false,
    record: record(sourceId),
    error: {
      code,
      message: `Trusted command ${sourceId} failed.`,
    },
  };
}

function workQueueState(overrides: Partial<State.AiuWorkQueueState> = {}): State.AiuWorkQueueState {
  return {
    kind: "work-queue",
    status: "pass",
    activeItems: [],
    readyItems: [],
    blockedItems: [],
    unknownItems: [],
    ...overrides,
  };
}

function workItem(id: string, lifecycle: State.AiuWorkItemState["lifecycle"], status: State.AiuStateValueKind = "pass"): State.AiuWorkItemState {
  return {
    kind: "work-item",
    id,
    title: `Issue ${id}`,
    status,
    lifecycle,
    priority: "high",
    blockers: [],
  };
}

function repositoryState(overrides: Partial<State.AiuRepositoryState> = {}): State.AiuRepositoryState {
  return {
    kind: "repository",
    status: "pass",
    dirty: "pass",
    baseFreshness: "pass",
    syncStatus: "in-sync",
    ...overrides,
  };
}

function hostSessionState(overrides: Partial<State.AiuHostSessionState> = {}): State.AiuHostSessionState {
  return {
    kind: "host-session",
    status: "pass",
    hostId: "codex",
    sessionStatus: "idle",
    canPrompt: true,
    ...overrides,
  };
}

function planningState(overrides: Partial<State.AiuPlanningState> = {}): State.AiuPlanningState {
  return {
    kind: "planning",
    status: "pass",
    needsPlanning: false,
    humanInputRequired: false,
    decisions: [],
    unresolvedQuestions: [],
    draftPaths: [],
    artifacts: [],
    providers: [],
    ...overrides,
  };
}

function qualityState(overrides: Partial<State.AiuQualityState> = {}): State.AiuQualityState {
  return {
    kind: "quality",
    status: "pass",
    ready: false,
    lastRunStatus: "pass",
    stages: [],
    findings: [],
    failingChecks: [],
    affectedPaths: [],
    ...overrides,
  };
}

function policyState(overrides: Partial<State.AiuContinuationPolicyState> = {}): State.AiuContinuationPolicyState {
  return {
    kind: "continuation-policy",
    status: "pass",
    allowedModes: ["continue", "repair", "wait", "stop"],
    stopOnUnknownState: true,
    stopOnStaleState: true,
    stopOnSupplyChainApprovalBlock: true,
    allowProviderMutation: false,
    allowBackgroundScheduling: false,
    ...overrides,
  };
}

async function runCli(input: readonly string[]) {
  try {
    const result = await execFileAsync(process.execPath, [aiuBin, ...input], {
      cwd: repoRoot,
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    assert(error !== null && typeof error === "object");
    const failed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}
