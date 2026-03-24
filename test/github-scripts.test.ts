import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type QueuePolicyFixture = {
  components: {
    labels: Array<{ description: string; name: string }>;
    prefix: string;
  };
  defaults: {
    priorityKey: string;
    statusKey: string;
  };
  priorities: Array<{ description: string; key: string; name: string; score: number }>;
  statuses: Array<{ description: string; key: string; name: string; scoreModifier: number }>;
  transitions: Record<string, { add: string; remove: string[] }>;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("GitHub helper scripts", () => {
  it("passes issue numbers to gh as a single argument in gh-update-labels.sh", async () => {
    const repoDir = await createScriptRepo(["gh-update-labels.sh"]);
    const env = await createGhEnv(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG_PATH, JSON.stringify(args) + "\\n");
`);

    const result = runScript(repoDir, "scripts/gh-update-labels.sh", ["12 13", "ready"], env);
    const invocations = await readJsonLines<string[]>(env.GH_LOG_PATH!);
    const queuePolicy = readQueuePolicy(repoDir);

    expect(result.status).toBe(0);
    expect(invocations).toEqual([
      [
        "issue",
        "edit",
        "12 13",
        "--remove-label",
        queuePolicy.transitions.ready.remove.map((statusKey) => getStatusName(queuePolicy, statusKey)).join(","),
      ],
      ["issue", "edit", "12 13", "--add-label", getStatusName(queuePolicy, queuePolicy.transitions.ready.add)],
    ]);
  });

  it("returns a non-zero exit code for invalid gh-update-labels.sh values", async () => {
    const repoDir = await createScriptRepo(["gh-update-labels.sh"]);
    const env = await createGhEnv("process.exit(99);");

    const result = runScript(repoDir, "scripts/gh-update-labels.sh", ["14", "priority", "bad-value"], env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Invalid priority");
  });

  it("returns a non-zero exit code for unknown gh-update-labels.sh actions", async () => {
    const repoDir = await createScriptRepo(["gh-update-labels.sh"]);
    const env = await createGhEnv("process.exit(99);");

    const result = runScript(repoDir, "scripts/gh-update-labels.sh", ["14", "unknown-action"], env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Unknown action");
  });

  it("uses repo-local policy-driven transition labels for gh-update-labels.sh start", async () => {
    const repoDir = await createScriptRepo(["gh-update-labels.sh"]);
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
      }
    }

    await writeFile(
      path.join(repoDir, "queue-policy.json"),
      JSON.stringify(customPolicy, null, 2).concat("\n"),
      "utf8",
    );

    const env = await createGhEnv(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG_PATH, JSON.stringify(args) + "\\n");
`);

    const result = runScript(repoDir, "scripts/gh-update-labels.sh", ["14", "start"], env);
    const invocations = await readJsonLines<string[]>(env.GH_LOG_PATH!);
    const queuePolicy = readQueuePolicy(repoDir);
    const startTransition = queuePolicy.transitions.start;

    expect(result.status).toBe(0);
    expect(invocations).toEqual([
      [
        "issue",
        "edit",
        "14",
        "--remove-label",
        startTransition.remove.map((statusKey) => getStatusName(queuePolicy, statusKey)).join(","),
      ],
      ["issue", "edit", "14", "--add-label", getStatusName(queuePolicy, startTransition.add)],
    ]);
    const renderedInvocations = JSON.stringify(invocations);
    expect(renderedInvocations).toContain("Doing-Now");
    expect(renderedInvocations).toContain("Ready-Now");
    expect(renderedInvocations).toContain("Blocked-Later");
  });

  it("prints a friendly error when gh-issue-start.sh cannot load the issue", async () => {
    const repoDir = await createScriptRepo(["gh-issue-start.sh"]);
    const env = await createGhEnv(`
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "view") {
  process.exit(1);
}
process.exit(0);
`);

    const result = runScript(repoDir, "scripts/gh-issue-start.sh", ["999"], env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Issue #999 not found");
  });

  it("orders issues by computed score and preserves recommendation state in gh-priority-order.sh", async () => {
    const repoDir = await createScriptRepo(["gh-priority-order.sh"]);
    const env = await createGhEnv(`
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify([
  { number: 42, title: "Medium blocked", labels: [{ name: "P3-Medium" }, { name: "S-Blocked" }] },
  { number: 41, title: "Low but blocking", labels: [{ name: "P4-Low" }, { name: "S-Blocking" }] },
  { number: 77, title: "High in progress", labels: [{ name: "P2-High" }, { name: "S-InProgress" }] },
  { number: 43, title: "High ready", labels: [{ name: "P2-High" }, { name: "C-Infrastructure" }, { name: "S-Ready" }] }
]));
`);

    const result = runScript(repoDir, "scripts/gh-priority-order.sh", [], env);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(result.status).toBe(0);
    expect(lines).toContain("1. #43: High ready [P2-High, C-Infrastructure, S-Ready]");
    expect(lines).toContain("2. #77: High in progress [P2-High, S-InProgress]");
    expect(lines).toContain("3. #41: Low but blocking [P4-Low, S-Blocking]");
    expect(lines).toContain("4. #42: Medium blocked [P3-Medium, S-Blocked]");
    expect(lines.indexOf("1. #43: High ready [P2-High, C-Infrastructure, S-Ready]")).toBeLessThan(
      lines.indexOf("2. #77: High in progress [P2-High, S-InProgress]"),
    );
    expect(lines.indexOf("2. #77: High in progress [P2-High, S-InProgress]")).toBeLessThan(
      lines.indexOf("3. #41: Low but blocking [P4-Low, S-Blocking]"),
    );
    expect(lines.indexOf("3. #41: Low but blocking [P4-Low, S-Blocking]")).toBeLessThan(
      lines.indexOf("4. #42: Medium blocked [P3-Medium, S-Blocked]"),
    );
    expect(result.stdout).toContain("💡 Next recommended work: #43 (ready to start)");
    expect(result.stdout).toContain("🚫 Blocked issues: #42 (resolve dependencies first)");
    expect(result.stdout).toContain("🔄 Currently in progress: #77");
  });

  it("emits structured queue data in --json mode for automation consumers", async () => {
    const repoDir = await createScriptRepo(["gh-priority-order.sh"]);
    const env = await createGhEnv(`
process.stdout.write(JSON.stringify([
  { number: 42, title: "Medium blocked", labels: [{ name: "P3-Medium" }, { name: "S-Blocked" }] },
  { number: 41, title: "Low but blocking", labels: [{ name: "P4-Low" }, { name: "S-Blocking" }] },
  { number: 77, title: "High in progress", labels: [{ name: "P2-High" }, { name: "S-InProgress" }] },
  { number: 43, title: "High ready", labels: [{ name: "P2-High" }, { name: "C-Infrastructure" }, { name: "S-Ready" }] }
]));
`);

    const result = runScript(repoDir, "scripts/gh-priority-order.sh", ["--json"], env);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      blockedIssues: [42],
      inProgress: [77],
      issues: [
        {
          component: "C-Infrastructure",
          labels: ["P2-High", "C-Infrastructure", "S-Ready"],
          number: 43,
          priority: "P2-High",
          score: 550,
          status: "S-Ready",
          title: "High ready",
        },
        {
          component: "",
          labels: ["P2-High", "S-InProgress"],
          number: 77,
          priority: "P2-High",
          score: 525,
          status: "S-InProgress",
          title: "High in progress",
        },
        {
          component: "",
          labels: ["P4-Low", "S-Blocking"],
          number: 41,
          priority: "P4-Low",
          score: 210,
          status: "S-Blocking",
          title: "Low but blocking",
        },
        {
          component: "",
          labels: ["P3-Medium", "S-Blocked"],
          number: 42,
          priority: "P3-Medium",
          score: 0,
          status: "S-Blocked",
          title: "Medium blocked",
        },
      ],
      nextIssue: 43,
      readyIssues: [43],
      version: 1,
    });
  });

  it("prints policy-driven labeling help in gh-priority-order.sh --help", async () => {
    const repoDir = await createScriptRepo(["gh-priority-order.sh"]);
    const env = await createGhEnv("process.stdout.write(JSON.stringify([]));");
    const queuePolicy = readQueuePolicy(repoDir);

    const result = runScript(repoDir, "scripts/gh-priority-order.sh", ["--help"], env);

    expect(result.status).toBe(0);
    for (const priority of queuePolicy.priorities) {
      expect(result.stdout).toContain(priority.name);
      expect(result.stdout).toContain(priority.description);
    }

    for (const status of queuePolicy.statuses) {
      expect(result.stdout).toContain(status.name);
      expect(result.stdout).toContain(status.description);
    }

    if (queuePolicy.components.labels.length === 0) {
      expect(result.stdout).toContain("No stable component labels configured for this repository.");
    }
  });

  it("prints policy-driven usage guidance and disabled component messaging", async () => {
    const repoDir = await createScriptRepo(["gh-update-labels.sh"]);
    const env = await createGhEnv("process.exit(99);");
    const queuePolicy = readQueuePolicy(repoDir);

    const result = runScript(repoDir, "scripts/gh-update-labels.sh", [], env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `priority <${queuePolicy.priorities.map((priority) => priority.name).join("|")}>`,
    );
    expect(result.stdout).toContain(
      `status <${queuePolicy.statuses.map((status) => status.name).join("|")}>`,
    );
    if (queuePolicy.components.labels.length === 0) {
      expect(result.stdout).toContain(
        `component <${queuePolicy.components.prefix}label>  # disabled: no stable component labels configured`,
      );
    }
  });

  it("fails cleanly when helper scripts cannot find queue-policy.json", async () => {
    const repoDir = await createScriptRepo(["gh-update-labels.sh"]);
    const env = await createGhEnv("process.exit(99);");

    await rm(path.join(repoDir, "queue-policy.json"), { force: true });

    const result = runScript(repoDir, "scripts/gh-update-labels.sh", ["14", "ready"], env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Queue policy file not found");
  });

  it("fails cleanly when helper scripts load an invalid queue policy", async () => {
    const repoDir = await createScriptRepo(["gh-priority-order.sh"]);
    const env = await createGhEnv("process.stdout.write(JSON.stringify([]));");
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

    const result = runScript(repoDir, "scripts/gh-priority-order.sh", ["--help"], env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required status key: ready");
  });
});

async function createScriptRepo(scriptNames: string[]): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "ai-umpire-gh-script-test-"));
  tempDirs.push(repoDir);
  await installQueuePolicyFiles(repoDir);
  await installScriptFiles(repoDir, scriptNames);
  return repoDir;
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

async function installScriptFiles(repoDir: string, scriptNames: string[]): Promise<void> {
  for (const scriptName of scriptNames) {
    const sourcePath = path.join(repoRoot, "scripts", scriptName);
    const targetPath = path.join(repoDir, "scripts", scriptName);
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, 0o755);
  }
}

async function createGhEnv(ghBody: string): Promise<NodeJS.ProcessEnv> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-umpire-gh-bin-"));
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

function runScript(
  repoDir: string,
  scriptRelativePath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  return spawnSync("bash", [path.join(repoDir, scriptRelativePath), ...args], {
    cwd: repoDir,
    encoding: "utf8",
    env,
  });
}

function readQueuePolicy(repoDir: string): QueuePolicyFixture {
  return JSON.parse(readFileSync(path.join(repoDir, "queue-policy.json"), "utf8")) as QueuePolicyFixture;
}

function readQueuePolicyDocument(repoDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoDir, "queue-policy.json"), "utf8")) as Record<string, unknown>;
}

function getStatusName(queuePolicy: QueuePolicyFixture, statusKey: string): string {
  const status = queuePolicy.statuses.find((candidate) => candidate.key === statusKey);
  if (status === undefined) {
    throw new Error(`Missing queue status key in fixture: ${statusKey}`);
  }

  return status.name;
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}
