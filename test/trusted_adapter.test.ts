import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type * as TrustedAdapter from "../src/trusted_adapter.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const observedAt = "2026-05-23T00:00:00.000Z";

describe("trusted command adapters", () => {
  it("executes explicit argv descriptors and normalizes trusted state envelopes", async () => {
    const { runAiuTrustedStateAdapter } = await loadTrustedAdapter();
    const payload = {
      schemaVersion: 1,
      sourceId: "work",
      observedAt,
      trustLevel: "trusted",
      capabilities: {
        work: "supported",
      },
      freshness: {
        kind: "fresh",
        observedAt,
      },
      value: {
        kind: "work-queue",
        status: "pass",
        activeItems: [],
        readyItems: [],
        blockedItems: [],
        unknownItems: [],
      },
    };
    const result = await runAiuTrustedStateAdapter("work", {
      argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`],
      timeoutMs: 1_000,
      maxOutputBytes: 16_384,
    }, { observedAt });

    assert.equal(result.ok, true);
    assert.equal(result.record.sourceId, "work");
    assert.deepEqual(result.record.command.argv.slice(1, 2), ["-e"]);
    assert.equal(result.record.parsedSchemaVersion, 1);
    assert.equal(result.states[0]?.stateKind, "work-queue");
    assert.equal(result.states[0]?.value.status, "pass");
  });

  it("records non-zero exits and redacts token-like stderr", async () => {
    const { executeAiuTrustedCommand } = await loadTrustedAdapter();
    const token = `ghp_${"A".repeat(36)}`;
    const result = await executeAiuTrustedCommand("work", {
      argv: [process.execPath, "-e", `process.stderr.write(${JSON.stringify(token)}); process.exit(7)`],
      timeoutMs: 1_000,
      maxOutputBytes: 16_384,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "trusted-command-non-zero-exit");
    assert.equal(result.record.exitCode, 7);
    assert.doesNotMatch(result.record.stderrSummary, /ghp_[A-Z0-9_]+/);
  });

  it("distinguishes spawn failure, timeout, and output limits", async () => {
    const { executeAiuTrustedCommand } = await loadTrustedAdapter();
    const spawnFailure = await executeAiuTrustedCommand("missing", {
      argv: ["/__aiu_missing_executable__"],
      timeoutMs: 1_000,
      maxOutputBytes: 16_384,
    });
    assert.equal(spawnFailure.ok, false);
    assert.equal(spawnFailure.error.code, "trusted-command-spawn-failed");

    const timeout = await executeAiuTrustedCommand("slow", {
      argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 20,
      maxOutputBytes: 16_384,
    });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.error.code, "trusted-command-timeout");
    assert.equal(timeout.record.timedOut, true);

    const outputLimit = await executeAiuTrustedCommand("noisy", {
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(1000))"],
      timeoutMs: 1_000,
      maxOutputBytes: 10,
    });
    assert.equal(outputLimit.ok, false);
    assert.equal(outputLimit.error.code, "trusted-command-output-limit");
    assert.equal(outputLimit.record.outputLimitExceeded, true);
  });

  it("hard-bounds timeout promises when a child ignores SIGTERM", async () => {
    const { executeAiuTrustedCommand } = await loadTrustedAdapter();
    const result = await executeAiuTrustedCommand("stubborn", {
      argv: [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      timeoutMs: 200,
      maxOutputBytes: 16_384,
    }, { killGraceMs: 20 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "trusted-command-timeout");
    assert.equal(result.record.signal, "SIGKILL");
    assert.equal(result.record.elapsedMs < 2_000, true);
  });

  it("normalizes invalid execution option limits to safe defaults", async () => {
    const { executeAiuTrustedCommand } = await loadTrustedAdapter();
    const result = await executeAiuTrustedCommand("limits", {
      argv: [process.execPath, "-e", "process.stdout.write('ok')"],
      timeoutMs: Number.NaN,
      maxOutputBytes: Number.NaN,
    }, { killGraceMs: -1 });

    assert.equal(result.ok, true);
    assert.equal(result.record.timeoutMs, 30_000);
    assert.equal(result.record.maxOutputBytes, 1_048_576);
  });

  it("returns stable parse errors for malformed JSON and unknown schemas", async () => {
    const { parseAiuTrustedStateJson, toAiuTrustedStateCommandRef } = await loadTrustedAdapter();
    const command = toAiuTrustedStateCommandRef("work", { argv: ["fixture"] });
    const malformed = parseAiuTrustedStateJson({
      sourceId: "work",
      command,
      stdout: "{",
      observedAt,
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, "trusted-command-malformed-json");

    const unknownSchema = parseAiuTrustedStateJson({
      sourceId: "work",
      command,
      stdout: JSON.stringify({ schemaVersion: 999, states: [] }),
      observedAt,
    });
    assert.equal(unknownSchema.ok, false);
    assert.equal(unknownSchema.error.code, "trusted-command-unknown-schema");
    assert.equal(unknownSchema.record.parsedSchemaVersion, 999);
  });

  it("treats unsupported capabilities and stale state as structured errors", async () => {
    const { parseAiuTrustedStateJson, toAiuTrustedStateCommandRef } = await loadTrustedAdapter();
    const command = toAiuTrustedStateCommandRef("repository", { argv: ["fixture"] });
    const unsupported = parseAiuTrustedStateJson({
      sourceId: "repository",
      command,
      stdout: JSON.stringify({
        schemaVersion: 1,
        observedAt,
        capabilities: {
          repository: "unsupported",
        },
        value: repositoryState("pass"),
      }),
      observedAt,
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error.code, "trusted-command-unsupported-capability");

    const stale = parseAiuTrustedStateJson({
      sourceId: "repository",
      command,
      stdout: JSON.stringify({
        schemaVersion: 1,
        observedAt,
        freshness: {
          kind: "stale",
          observedAt,
        },
        value: repositoryState("pass"),
      }),
      observedAt,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "trusted-command-stale-state");
  });

  it("normalizes generic core-state JSON shapes into envelopes", async () => {
    const { parseAiuTrustedStateJson, toAiuTrustedStateCommandRef } = await loadTrustedAdapter();
    const command = toAiuTrustedStateCommandRef("repository", { argv: ["fixture"] });
    const result = parseAiuTrustedStateJson({
      sourceId: "repository",
      command,
      stdout: JSON.stringify({
        schemaVersion: 1,
        observedAt,
        ...repositoryState("pass"),
      }),
      observedAt,
    });

    assert.equal(result.ok, true);
    assert.equal(result.states[0]?.sourceId, "repository");
    assert.equal(result.states[0]?.stateKind, "repository");
    assert.equal(result.states[0]?.command.argv[0], "fixture");
    assert.equal(result.states[0]?.value.status, "pass");
  });

  it("normalizes Bootstrap planning actions, questions, artifacts, and providers", async () => {
    const { parseAiuTrustedStateJson, toAiuTrustedStateCommandRef } = await loadTrustedAdapter();
    const command = toAiuTrustedStateCommandRef("planning", { argv: ["fixture"] });
    const result = parseAiuTrustedStateJson({
      sourceId: "planning",
      command,
      stdout: JSON.stringify({
        schemaVersion: 1,
        observedAt,
        value: {
          kind: "planning",
          status: "pass",
          needsPlanning: true,
          humanInputRequired: false,
          currentPhase: "milestone-draft",
          decisions: [{ id: "scope", status: "decided", summary: "Keep this to planning continuation." }],
          unresolvedQuestions: [{
            id: "provider-schema",
            category: "provider-schema",
            status: "fail",
            requiresHuman: true,
            affectedPaths: ["docs/spec.md", 42],
          }],
          draftPaths: ["docs/M4-whip-tasks-quality-idle-work-and-planning-continuation.md"],
          artifacts: [{ path: "docs/spec.md", kind: "spec", status: "pass" }],
          providers: [{ id: "github", kind: "issues", status: "unknown" }],
          nextAction: {
            id: "bootstrap-plan",
            title: "Refresh Bootstrap plan",
            kind: "artifact-update",
            status: "pass",
            command: { id: "bootstrap-plan", argv: ["bootstrap", "plan"], timeoutMs: 1000 },
            artifactChecks: ["docs/spec.md"],
            draftPaths: ["docs/spec.md"],
            expectedEvidence: "Updated planning artifacts.",
          },
          stopCondition: {
            id: "human-schema",
            category: "human-question",
            status: "fail",
            requiresHuman: true,
            affectedPaths: ["docs/spec.md"],
          },
          supplyChainApprovalRequired: "unknown",
        },
      }),
      observedAt,
    });

    assert.equal(result.ok, true);
    const value = result.states[0]?.value;
    assert.equal(value?.kind, "planning");
    assert.equal(value?.kind === "planning" ? value.currentPhase : undefined, "milestone-draft");
    assert.deepEqual(value?.kind === "planning" ? value.draftPaths : [], ["docs/M4-whip-tasks-quality-idle-work-and-planning-continuation.md"]);
    assert.equal(value?.kind === "planning" ? value.nextAction?.command?.argv.join(" ") : "", "bootstrap plan");
    assert.equal(value?.kind === "planning" ? value.nextAction?.command?.timeoutMs : undefined, 1000);
    assert.deepEqual(value?.kind === "planning" ? value.nextAction?.artifactChecks : [], ["docs/spec.md"]);
    assert.equal(value?.kind === "planning" ? value.unresolvedQuestions[0]?.requiresHuman : false, true);
    assert.deepEqual(value?.kind === "planning" ? value.unresolvedQuestions[0]?.affectedPaths : [], ["docs/spec.md"]);
    assert.equal(value?.kind === "planning" ? value.providers[0]?.status : undefined, "unknown");
    assert.equal(value?.kind === "planning" ? value.stopCondition?.category : undefined, "human-question");
    assert.equal(value?.kind === "planning" ? value.supplyChainApprovalRequired : undefined, "unknown");

    const incomplete = parseAiuTrustedStateJson({
      sourceId: "planning",
      command,
      stdout: JSON.stringify({
        schemaVersion: 1,
        observedAt,
        value: {
          kind: "planning",
          status: "pass",
          needsPlanning: true,
        },
      }),
      observedAt,
    });
    assert.equal(incomplete.ok, true);
    assert.equal(incomplete.states[0]?.value.kind === "planning" ? incomplete.states[0].value.humanInputRequired : undefined, "unknown");
  });

  it("normalizes quality stages, findings, commands, and approval blocks", async () => {
    const { parseAiuTrustedStateJson, toAiuTrustedStateCommandRef } = await loadTrustedAdapter();
    const command = toAiuTrustedStateCommandRef("quality", { argv: ["fixture"] });
    const result = parseAiuTrustedStateJson({
      sourceId: "quality",
      command,
      stdout: JSON.stringify({
        schemaVersion: 1,
        observedAt,
        value: {
          kind: "quality",
          status: "pass",
          ready: true,
          lastRunStatus: "fail",
          stages: [{
            id: "typecheck",
            title: "Typecheck",
            status: "fail",
            affectedPaths: ["src/state.ts", 42],
            command: { id: "quality-typecheck", argv: ["pnpm", "run", "typecheck"], timeoutMs: 10.5, maxOutputBytes: -1 },
            rerunCommand: { id: "quality-typecheck", argv: ["pnpm", "run", "typecheck"], timeoutMs: 1000, maxOutputBytes: 16384 },
          }],
          findings: [{
            id: "supply-chain-risk",
            status: "fail",
            severity: "critical",
            affectedPaths: ["package.json"],
            supplyChainApprovalRequired: true,
          }],
          selectedTarget: {
            kind: "stage",
            id: "incomplete-selection",
            affectedPaths: ["src/state.ts"],
          },
          failingChecks: ["typecheck"],
          affectedPaths: ["src/state.ts"],
        },
      }),
      observedAt,
    });

    assert.equal(result.ok, true);
    const value = result.states[0]?.value;
    assert.equal(value?.kind, "quality");
    assert.equal(value?.kind === "quality" ? value.stages[0]?.command?.argv.join(" ") : "", "pnpm run typecheck");
    assert.equal(value?.kind === "quality" ? value.stages[0]?.command?.timeoutMs : undefined, undefined);
    assert.equal(value?.kind === "quality" ? value.stages[0]?.command?.maxOutputBytes : undefined, undefined);
    assert.equal(value?.kind === "quality" ? value.stages[0]?.rerunCommand?.timeoutMs : undefined, 1000);
    assert.equal(value?.kind === "quality" ? value.stages[0]?.rerunCommand?.maxOutputBytes : undefined, 16384);
    assert.deepEqual(value?.kind === "quality" ? value.stages[0]?.affectedPaths : [], ["src/state.ts"]);
    assert.equal(value?.kind === "quality" ? value.findings[0]?.supplyChainApprovalRequired : false, true);
    assert.equal(value?.kind === "quality" ? value.selectedTarget?.status : undefined, "unknown");
    assert.deepEqual(value?.kind === "quality" ? value.failingChecks : [], ["typecheck"]);
    assert.deepEqual(value?.kind === "quality" ? value.affectedPaths : [], ["src/state.ts"]);
  });
});

async function loadTrustedAdapter(): Promise<typeof TrustedAdapter> {
  return await import(path.join(repoRoot, "dist/src/trusted_adapter.js")) as typeof TrustedAdapter;
}

function repositoryState(status: "pass" | "stale") {
  return {
    kind: "repository",
    status,
    dirty: "pass",
    baseFreshness: status,
    syncStatus: "in-sync",
  };
}
