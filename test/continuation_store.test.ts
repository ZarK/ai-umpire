import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  appendAiuContinuationLog,
  resolveAiuContinuationPaths,
} from "../dist/src/continuation_store.js";
import { getDefaultAiuConfig } from "../dist/src/config.js";

describe("continuation persistence store", () => {
  it("redacts token-like values in bounded continuation logs", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "aiu-continuation-log-"));
    try {
      const paths = resolveAiuContinuationPaths(target, getDefaultAiuConfig());
      appendAiuContinuationLog(paths, {
        event: "decision",
        observedAt: "2026-05-23T12:00:00.000Z",
        adapterErrors: [`token=${"ghp_" + "A".repeat(36)}`],
      });

      const log = await readFile(paths.logPath, "utf8");
      assert.match(log, /token=\[redacted\]/);
      assert.doesNotMatch(log, /ghp_[A-Za-z0-9_]+/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("rotates continuation logs before they grow without bound", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "aiu-continuation-rotate-"));
    try {
      const paths = resolveAiuContinuationPaths(target, getDefaultAiuConfig());
      for (let index = 0; index < 80; index += 1) {
        appendAiuContinuationLog(paths, {
          event: "decision",
          observedAt: "2026-05-23T12:00:00.000Z",
          message: "x".repeat(1_000),
        });
      }

      const current = await stat(paths.logPath);
      const rotated = await stat(`${paths.logPath}.1`);
      assert.ok(current.size <= 64 * 1024);
      assert.ok(rotated.size <= 64 * 1024);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
