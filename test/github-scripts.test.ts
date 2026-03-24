import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("GitHub helper scripts", () => {
  it("passes issue numbers to gh as a single argument in gh-update-labels.sh", async () => {
    const env = await createGhEnv(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG_PATH, JSON.stringify(args) + "\\n");
`);

    const result = runScript("scripts/gh-update-labels.sh", ["12 13", "ready"], env);
    const invocations = await readJsonLines<string[]>(env.GH_LOG_PATH!);

    expect(result.status).toBe(0);
    expect(invocations).toEqual([
      ["issue", "edit", "12 13", "--remove-label", "S-Blocked,S-InProgress"],
      ["issue", "edit", "12 13", "--add-label", "S-Ready"],
    ]);
  });

  it("returns a non-zero exit code for invalid gh-update-labels.sh values", async () => {
    const env = await createGhEnv("process.exit(99);");

    const result = runScript("scripts/gh-update-labels.sh", ["14", "priority", "bad-value"], env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Invalid priority");
  });

  it("returns a non-zero exit code for unknown gh-update-labels.sh actions", async () => {
    const env = await createGhEnv("process.exit(99);");

    const result = runScript("scripts/gh-update-labels.sh", ["14", "unknown-action"], env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Unknown action");
  });

  it("prints a friendly error when gh-issue-start.sh cannot load the issue", async () => {
    const env = await createGhEnv(`
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "view") {
  process.exit(1);
}
process.exit(0);
`);

    const result = runScript("scripts/gh-issue-start.sh", ["999"], env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Issue #999 not found");
  });

  it("orders issues by computed score and preserves recommendation state in gh-priority-order.sh", async () => {
    const env = await createGhEnv(`
const args = process.argv.slice(2);
const joined = args.join(" ");
if (joined.includes("--label S-InProgress")) {
  process.stdout.write("#77\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify([
  { number: 42, title: "Medium blocked", priority: "P3-Medium", status: "S-Blocked", component: "", labels: [] },
  { number: 41, title: "Low but blocking", priority: "P4-Low", status: "S-Blocking", component: "", labels: [] },
  { number: 43, title: "High ready", priority: "P2-High", status: "S-Ready", component: "C-Infrastructure", labels: [] }
]));
`);

    const result = runScript("scripts/gh-priority-order.sh", [], env);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(result.status).toBe(0);
    expect(lines).toContain("1. #43: High ready [P2-High, C-Infrastructure, S-Ready]");
    expect(lines).toContain("2. #41: Low but blocking [P4-Low, S-Blocking]");
    expect(lines).toContain("3. #42: Medium blocked [P3-Medium, S-Blocked]");
    expect(lines.indexOf("1. #43: High ready [P2-High, C-Infrastructure, S-Ready]")).toBeLessThan(
      lines.indexOf("2. #41: Low but blocking [P4-Low, S-Blocking]"),
    );
    expect(lines.indexOf("2. #41: Low but blocking [P4-Low, S-Blocking]")).toBeLessThan(
      lines.indexOf("3. #42: Medium blocked [P3-Medium, S-Blocked]"),
    );
    expect(result.stdout).toContain("💡 Next recommended work: #43 (ready to start)");
    expect(result.stdout).toContain("🚫 Blocked issues: #42 (resolve dependencies first)");
    expect(result.stdout).toContain("🔄 Currently in progress: #77");
  });
});

async function createGhEnv(ghBody: string): Promise<NodeJS.ProcessEnv> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-umpire-gh-script-test-"));
  tempDirs.push(tempDir);

  const binDir = path.join(tempDir, "bin");
  const ghPath = path.join(binDir, "gh");
  const ghLogPath = path.join(tempDir, "gh.log");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    ghPath,
    `#!/usr/bin/env node\n${ghBody.trim()}\n`,
    "utf8",
  );
  await chmod(ghPath, 0o755);

  return {
    ...process.env,
    GH_LOG_PATH: ghLogPath,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
}

function runScript(scriptRelativePath: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [path.join(repoDir, scriptRelativePath), ...args], {
    cwd: repoDir,
    encoding: "utf8",
    env,
  });
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}
