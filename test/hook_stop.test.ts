import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type * as HookStop from "../src/hook_stop.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const observedAt = "2026-05-23T00:00:00.000Z";

describe("provider-neutral stop hooks", () => {
  it("blocks Codex stops with a concrete continuation prompt when policy allows it", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });

      assert.equal(result.decision, "block");
      assert.equal(result.stderr, "");
      assert.deepEqual(result.diagnostics, []);
      assert.equal("decision" in result.stdoutJson ? result.stdoutJson.decision : undefined, "block");
      assert.match("reason" in result.stdoutJson ? result.stdoutJson.reason : "", /Continue active work/);
      assert.equal(result.continuationDecision?.kind, "continue");
      assert.deepEqual(result.continuationDecision?.reasonCodes, ["continue-active-work"]);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("blocks Claude Code stops with the same host JSON shape", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "claude-code",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "claude-code",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "claude-session")),
      });

      assert.equal(result.decision, "block");
      assert.equal("decision" in result.stdoutJson ? result.stdoutJson.decision : undefined, "block");
      assert.match("reason" in result.stdoutJson ? result.stdoutJson.reason : "", /Continue active work/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("accepts Stop hook payloads that omit optional host fields", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: activeWorkState(),
    });
    try {
      const { transcript_path: _transcriptPath, last_assistant_message: _lastAssistantMessage, ...payload } = stopPayload(target, "codex-session");
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(payload),
      });

      assert.equal(result.decision, "block");
      assert.equal(result.stderr, "");
      assert.equal("decision" in result.stdoutJson ? result.stdoutJson.decision : undefined, "block");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("surfaces bounded trusted-state warnings without contaminating stdout JSON", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const state = activeWorkState();
    const stderrPayload = JSON.stringify("x".repeat(400));
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: undefined,
      trustedCommand: [
        process.execPath,
        "-e",
        `process.stderr.write(${stderrPayload}); process.stdout.write(${JSON.stringify(JSON.stringify(state))})`,
      ],
    });
    try {
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });

      assert.equal(result.decision, "block");
      assert.equal("decision" in result.stdoutJson ? result.stdoutJson.decision : undefined, "block");
      assert.equal(result.diagnostics[0]?.code, "trusted-command-stderr");
      assert.equal(result.diagnostics[0]?.message.length, 240);
      assert.match(result.stderr, /trusted-command-stderr/);
      assert.doesNotMatch(JSON.stringify(result.stdoutJson), /trusted-command-stderr/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("caps the total diagnostic lines written to stderr", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await mkdtemp(path.join(tmpdir(), "aiu-hook-stop-noisy-"));
    try {
      await mkdir(path.join(target, ".git"));
      await writeFile(path.join(target, "aiu.config.json"), JSON.stringify({
        version: 1,
        hosts: {
          enabled: ["codex"],
          stopHookBlocking: {
            codex: true,
          },
        },
        trustedStateCommands: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`1bad${index}`, {}])),
      }), "utf8");

      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });
      const lines = result.stderr.trim().split("\n");

      assert.equal(result.decision, "allow");
      assert.equal(result.reason, "config-invalid");
      assert.equal(lines.length, 8);
      assert.match(lines.at(-1) ?? "", /diagnostics-truncated/);
      assert.equal(result.diagnostics.length > 8, true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("allows when stop-hook blocking is not explicitly enabled", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: false,
      trustedState: activeWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });

      assert.equal(result.decision, "allow");
      assert.equal(result.reason, "stop-hook-blocking-disabled");
      assert.deepEqual(result.stdoutJson, {});
      assert.match(result.stderr, /stop-hook-blocking-disabled/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("blocks stop hooks with a shared whip prompt when higher-priority work is idle", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const target = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: emptyWorkState(),
    });
    try {
      const result = await runAiuHookStop({
        tool: "codex",
        cwd: target,
        observedAt,
        stdin: JSON.stringify(stopPayload(target, "codex-session")),
      });

      assert.equal(result.decision, "block");
      assert.equal(result.reason, "continue-whip-task");
      assert.equal(result.continuationDecision?.promptKind, "whip");
      assert.equal(result.prompt?.kind, "whip");
      assert.equal(result.prompt?.selectedItem?.id, "review-doc-command-examples");
      assert.match("reason" in result.stdoutJson ? result.stdoutJson.reason : "", /Prompt delivery does not complete the whip task/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("allows clean stop, wait, malformed input, and trusted-state failures", async () => {
    const { runAiuHookStop } = await loadHookStop();
    const clean = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: emptyWorkState(),
      whipEnabled: false,
    });
    const failing = await createRepo({
      tool: "codex",
      stopHookBlocking: true,
      trustedState: undefined,
      trustedCommand: [process.execPath, "-e", `process.stderr.write("token=${"ghp_" + "A".repeat(36)}"); process.exit(2)`],
    });
    try {
      const cleanResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify(stopPayload(clean, "codex-session")),
      });
      assert.equal(cleanResult.decision, "allow");
      assert.equal(cleanResult.reason, "stop-clean");
      assert.deepEqual(cleanResult.stdoutJson, {});

      const activeHookResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify({ ...stopPayload(clean, "codex-session"), stop_hook_active: true }),
      });
      assert.equal(activeHookResult.decision, "allow");
      assert.equal(activeHookResult.reason, "stop-hook-already-active");

      const emptyResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: "",
      });
      assert.equal(emptyResult.decision, "allow");
      assert.equal(emptyResult.reason, "empty-hook-input");
      assert.match(emptyResult.stderr, /empty-hook-input/);

      const malformedResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: "{",
      });
      assert.equal(malformedResult.decision, "allow");
      assert.equal(malformedResult.reason, "malformed-hook-input");
      assert.match(malformedResult.stderr, /malformed-hook-input/);

      const wrongEventResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify({ ...stopPayload(clean, "codex-session"), hook_event_name: "PreToolUse" }),
      });
      assert.equal(wrongEventResult.decision, "allow");
      assert.equal(wrongEventResult.reason, "malformed-hook-input");
      assert.match(wrongEventResult.stderr, /Unsupported hook event/);

      const missingRequiredResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify({ hook_event_name: "Stop" }),
      });
      assert.equal(missingRequiredResult.decision, "allow");
      assert.equal(missingRequiredResult.reason, "malformed-hook-input");
      assert.match(missingRequiredResult.stderr, /cwd must be a non-empty string/);

      const invalidOptionalResult = await runAiuHookStop({
        tool: "codex",
        cwd: clean,
        observedAt,
        stdin: JSON.stringify({ ...stopPayload(clean, "codex-session"), transcript_path: 123 }),
      });
      assert.equal(invalidOptionalResult.decision, "allow");
      assert.equal(invalidOptionalResult.reason, "malformed-hook-input");
      assert.match(invalidOptionalResult.stderr, /transcript_path must be a string or null/);

      const failingResult = await runAiuHookStop({
        tool: "codex",
        cwd: failing,
        observedAt,
        stdin: JSON.stringify(stopPayload(failing, "codex-session")),
      });
      assert.equal(failingResult.decision, "allow");
      assert.equal(failingResult.reason, "trusted-state-load-failed");
      assert.match(failingResult.stderr, /trusted-command-non-zero-exit/);
      assert.doesNotMatch(failingResult.stderr, /ghp_[A-Z0-9_]+/);
    } finally {
      await rm(clean, { recursive: true, force: true });
      await rm(failing, { recursive: true, force: true });
    }
  });
});

async function loadHookStop(): Promise<typeof HookStop> {
  return await import(path.join(repoRoot, "dist/src/hook_stop.js")) as typeof HookStop;
}

async function createRepo(options: {
  readonly tool: "codex" | "claude-code";
  readonly stopHookBlocking: boolean;
  readonly trustedState?: Record<string, unknown>;
  readonly trustedCommand?: readonly [string, ...string[]];
  readonly whipEnabled?: boolean;
}): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), "aiu-hook-stop-"));
  await mkdir(path.join(target, ".git"));
  const trustedCommand = options.trustedCommand ?? [
    process.execPath,
    "-e",
    `process.stdout.write(${JSON.stringify(JSON.stringify(options.trustedState ?? emptyWorkState()))})`,
  ] as const;
  await writeFile(path.join(target, "aiu.config.json"), JSON.stringify({
    version: 1,
    hosts: {
      enabled: [options.tool],
      capabilities: {
        [options.tool]: {
          stopHook: true,
          promptDelivery: "stdout",
        },
      },
      modes: {
        [options.tool]: ["stop"],
      },
      stopHookBlocking: options.stopHookBlocking ? { [options.tool]: true } : {},
    },
    trustedStateCommands: {
      work: {
        argv: trustedCommand,
        timeoutMs: 1_000,
        maxOutputBytes: 16_384,
      },
    },
    ...(options.whipEnabled === false ? { whip: { enabled: false } } : {}),
  }), "utf8");
  return target;
}

function stopPayload(cwd: string, sessionId: string) {
  return {
    cwd,
    hook_event_name: "Stop",
    last_assistant_message: "done",
    model: "test-model",
    permission_mode: "default",
    session_id: sessionId,
    stop_hook_active: false,
    transcript_path: null,
    turn_id: "turn-1",
  };
}

function activeWorkState(options: { readonly diagnostics?: readonly Record<string, unknown>[] } = {}) {
  return {
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
      activeItems: [{
        kind: "work-item",
        status: "pass",
        id: "66",
        title: "Implement stop hooks",
        lifecycle: "active",
        priority: "high",
        blockers: [],
      }],
      readyItems: [],
      blockedItems: [],
      unknownItems: [],
    },
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  };
}

function emptyWorkState() {
  return {
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
}
