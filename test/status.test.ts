import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits concise human status output from the typed report", async () => {
    const result = await runCli(["status"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /decision: stop/);
    assert.match(result.stdout, /mode: stop/);
    assert.match(result.stdout, /reasons: stop-clean/);
    assert.match(result.stdout, /next: Stop: no continuation, repair, or wait condition remains\./);
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

async function configLoad(options: { readonly supplyChainApprovalRequired?: boolean; readonly modes?: Config.AiuContinuationMode[] } = {}): Promise<Config.AiuConfigLoadResult> {
  const { getDefaultAiuConfig } = await loadConfig();
  const config = getDefaultAiuConfig();
  return {
    ok: true,
    repoRoot,
    selectedPath: path.join(repoRoot, "aiu.config.json"),
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
