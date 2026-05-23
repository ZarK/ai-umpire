import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadAiuConfig } from "../dist/src/config.js";
import {
  evaluateAiuHostRuntimePolicy,
  getAiuHostCapabilityProfile,
  getAllAiuHostCapabilityProfiles,
  getDefaultHostCapabilityOverrides,
  getDefaultHostModes,
} from "../dist/src/host_policy.js";

describe("host runtime policy", () => {
  it("exposes provider-neutral profiles and explicit support states", () => {
    const profiles = getAllAiuHostCapabilityProfiles();

    assert.deepEqual(profiles.map((profile) => profile.tool), ["opencode", "codex", "claude-code"]);
    assert.deepEqual(profiles.map((profile) => profile.supportLevel), ["supported", "experimental", "experimental"]);
    assert.equal(getAiuHostCapabilityProfile("opencode").capabilities.promptDelivery.support, "supported");
    assert.equal(getAiuHostCapabilityProfile("codex").stopHook.blocksByDefault, true);
    assert.equal(getAiuHostCapabilityProfile("claude-code").capabilities.stopHook.support, "experimental");
  });

  it("uses safe init defaults for host modes and capability overrides", () => {
    assert.deepEqual(getDefaultHostModes("opencode"), ["continue", "repair", "wait", "stop"]);
    assert.deepEqual(getDefaultHostModes("codex"), ["stop"]);
    assert.equal(getDefaultHostCapabilityOverrides("opencode").promptDelivery, "host");
    assert.equal(getDefaultHostCapabilityOverrides("codex").promptDelivery, "stdout");
    assert.equal(Object.hasOwn(getDefaultHostCapabilityOverrides("codex"), "userActivity"), false);
  });

  it("reports disabled and experimental host mode policy distinctly", () => {
    const disabled = evaluateAiuHostRuntimePolicy(
      {
        enabled: ["opencode"],
        capabilities: { opencode: { promptDelivery: "none" } },
        modes: { opencode: ["continue"] },
        stopHookBlocking: {},
      },
      ["continue", "repair", "wait", "stop"],
    );
    const experimental = evaluateAiuHostRuntimePolicy(
      {
        enabled: ["codex"],
        capabilities: {},
        modes: { codex: ["continue"] },
        stopHookBlocking: {},
      },
      ["continue", "repair", "wait", "stop"],
    );

    assert.equal(disabled.errors[0]?.kind, "host-capability-disabled");
    assert.equal(experimental.warnings[0]?.kind, "host-capability-experimental");
  });

  it("falls back to global continuation modes when host modes are not explicit", () => {
    const report = evaluateAiuHostRuntimePolicy(
      {
        enabled: ["codex"],
        capabilities: {},
        modes: {},
        stopHookBlocking: {},
      },
      ["continue", "stop"],
    );

    assert.deepEqual(report.modeChecks.map((item) => item.mode), ["continue", "stop"]);
    assert.equal(report.warnings[0]?.kind, "host-capability-experimental");
  });

  it("preserves explicit empty host modes as disabled for that host", () => {
    const report = evaluateAiuHostRuntimePolicy(
      {
        enabled: ["codex"],
        capabilities: {},
        modes: { codex: [] },
        stopHookBlocking: {},
      },
      ["continue", "stop"],
    );

    assert.deepEqual(report.modeChecks, []);
  });

  it("surfaces host policy diagnostics during config validation", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "aiu-host-policy-"));
    try {
      await writeFile(path.join(repoRoot, "aiu.config.json"), JSON.stringify({
        version: 1,
        hosts: {
          enabled: ["opencode", "codex"],
          capabilities: {
            opencode: {
              promptDelivery: "none",
            },
          },
          modes: {
            opencode: ["continue", "stop"],
            codex: ["continue"],
          },
          stopHookBlocking: {},
        },
      }));

      const result = loadAiuConfig({ cwd: repoRoot });

      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((item) => item.kind === "host-capability-disabled" && item.severity === "error"));
      assert.ok(result.diagnostics.some((item) => item.kind === "host-capability-experimental" && item.severity === "warning"));
      assert.equal(result.diagnostics.some((item) => item.kind === "host-stop-hook-blocking-unsafe"), false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
