import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  AIU_CONFIG_FILENAME,
  type AiuConfig,
  type AiuHost,
  getDefaultAiuConfig,
  loadAiuConfig,
} from "./config.js";
import {
  getAiuHostCapabilityProfiles,
  getDefaultHostCapabilityOverrides,
  getDefaultHostModes,
  type AiuHostCapabilityProfile,
  type AiuManagedHostFile,
} from "./host_policy.js";

export const AIU_INIT_TOOLS = ["opencode", "codex", "claude-code", "all"] as const;

export type AiuInitTool = (typeof AIU_INIT_TOOLS)[number];
export type AiuInitFileOperation = "create" | "update" | "skip" | "conflict";

export interface AiuInitOptions {
  readonly cwd?: string;
  readonly tool?: AiuInitTool;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export type { AiuHostCapabilityProfile, AiuManagedHostFile } from "./host_policy.js";

export interface AiuInitPlan {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly repoRoot: string;
  readonly configPath: string;
  readonly tools: readonly AiuHost[];
  readonly hostProfiles: readonly AiuHostCapabilityProfile[];
  readonly files: readonly AiuInitFileAction[];
  readonly config: AiuInitConfigAction;
  readonly conflicts: readonly AiuInitConflict[];
  readonly requiredTrustSteps: readonly string[];
  readonly recommendedNextCommand: string;
}

export interface AiuInitFileAction {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly description: string;
  readonly operation: AiuInitFileOperation;
  readonly reason: string;
  readonly content: string;
}

export interface AiuInitConfigAction {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly operation: AiuInitFileOperation;
  readonly reason: string;
  readonly content: string;
  readonly hosts: readonly AiuHost[];
  readonly trustedStateCommands: readonly string[];
}

export interface AiuInitConflict {
  readonly relativePath: string;
  readonly reason: string;
  readonly suggestedNextAction: string;
}

export function planAiuInit(options: AiuInitOptions = {}): AiuInitPlan {
  const configLoad = loadAiuConfig({ cwd: options.cwd });
  const repoRoot = configLoad.repoRoot;
  const tool = options.tool ?? "all";
  const tools = expandInitTools(tool);
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const hostProfiles = getAiuHostCapabilityProfiles(tools);
  const files = hostProfiles.flatMap((profile) => profile.managedFiles.map((file) => planFile(repoRoot, file, force)));
  const config = planConfig(repoRoot, configLoad.selectedPath, configLoad.config, tools, force);
  const conflicts = [
    ...files.filter((file) => file.operation === "conflict").map((file) => ({
      relativePath: file.relativePath,
      reason: file.reason,
      suggestedNextAction: `Review ${file.relativePath}, then rerun with --force if replacing it is intentional.`,
    })),
    ...(config.operation === "conflict"
      ? [
          {
            relativePath: config.relativePath,
            reason: config.reason,
            suggestedNextAction: `Fix ${AIU_CONFIG_FILENAME} or rerun with --force to replace it with package defaults.`,
          },
        ]
      : []),
  ];

  return Object.freeze({
    ok: conflicts.length === 0,
    dryRun,
    force,
    repoRoot,
    configPath: configLoad.selectedPath,
    tools: Object.freeze(tools),
    hostProfiles: Object.freeze(hostProfiles),
    files: Object.freeze(files),
    config,
    conflicts: Object.freeze(conflicts),
    requiredTrustSteps: Object.freeze([...new Set(hostProfiles.flatMap((profile) => profile.trustSteps))]),
    recommendedNextCommand: "aiu config --json",
  });
}

export function applyAiuInitPlan(plan: AiuInitPlan): AiuInitPlan {
  if (plan.dryRun || !plan.ok) {
    return plan;
  }

  const refreshed = planAiuInit({
    cwd: plan.repoRoot,
    tool: toolForPlan(plan.tools),
    force: plan.force,
  });
  if (!refreshed.ok) {
    return refreshed;
  }

  for (const file of [...refreshed.files, refreshed.config]) {
    if (file.operation === "create" || file.operation === "update") {
      mkdirSync(path.dirname(file.absolutePath), { recursive: true });
      writeFileSync(file.absolutePath, file.content, "utf8");
    }
  }

  return refreshed;
}

export function formatInitPlan(plan: AiuInitPlan): string {
  const sections = [
    `repoRoot: ${plan.repoRoot}`,
    `mode: ${plan.dryRun ? "dry-run" : "apply"}`,
    `tools: ${plan.tools.join(", ")}`,
    "",
    formatFileGroup("Created", plan, "create"),
    formatFileGroup("Updated", plan, "update"),
    formatFileGroup("Skipped", plan, "skip"),
    formatFileGroup("Conflicts", plan, "conflict"),
    "Config changes:",
    `- ${plan.config.relativePath}: hosts=${plan.config.hosts.join(", ") || "none"}; trustedStateCommands=${plan.config.trustedStateCommands.join(", ") || "none"}`,
    "",
    "Required trust steps:",
    ...plan.requiredTrustSteps.map((step) => `- ${step}`),
    "",
    `Recommended next command: ${plan.recommendedNextCommand}`,
  ];

  return `${sections.join("\n")}\n`;
}

function expandInitTools(tool: AiuInitTool): readonly AiuHost[] {
  return tool === "all" ? ["opencode", "codex", "claude-code"] : [tool];
}

function toolForPlan(tools: readonly AiuHost[]): AiuInitTool {
  return tools.length === 3 ? "all" : tools[0] ?? "all";
}

function planFile(repoRoot: string, file: AiuManagedHostFile, force: boolean): AiuInitFileAction {
  const absolutePath = path.join(repoRoot, file.relativePath);
  const existing = readExistingText(absolutePath);
  const planned = classifyTextWrite(existing, file.content, force);
  return Object.freeze({
    relativePath: file.relativePath,
    absolutePath,
    description: file.description,
    operation: planned.operation,
    reason: planned.reason,
    content: file.content,
  });
}

function planConfig(repoRoot: string, configPath: string, loadedConfig: AiuConfig, tools: readonly AiuHost[], force: boolean): AiuInitConfigAction {
  const relativePath = path.relative(repoRoot, configPath) || AIU_CONFIG_FILENAME;
  const existing = readExistingText(configPath);
  const existingRaw = existing.exists && existing.content !== undefined ? parseJsonObject(existing.content) : { ok: true, value: {} };
  const mergedConfig = mergeConfig(loadedConfig, existingRaw.ok ? existingRaw.value : {}, tools);
  const content = stableJson(mergedConfig);
  const planned = classifyConfigWrite(existing, existingRaw, content, force);

  return Object.freeze({
    relativePath,
    absolutePath: configPath,
    operation: planned.operation,
    reason: planned.reason,
    content,
    hosts: Object.freeze(readMergedHosts(mergedConfig)),
    trustedStateCommands: Object.freeze(readMergedTrustedStateCommandNames(mergedConfig)),
  });
}

function mergeConfig(config: AiuConfig, raw: Record<string, unknown>, tools: readonly AiuHost[]): Record<string, unknown> {
  const defaults = getDefaultAiuConfig();
  const enabled = [...new Set([...config.hosts.enabled, ...tools])];
  const capabilities = {
    ...config.hosts.capabilities,
    ...Object.fromEntries(
      tools.map((tool) => [
        tool,
        {
          ...getDefaultHostCapabilityOverrides(tool),
          ...(config.hosts.capabilities[tool] ?? {}),
        },
      ]),
    ),
  };
  const modes = {
    ...config.hosts.modes,
    ...Object.fromEntries(
      tools.map((tool) => [tool, config.hosts.modes[tool] ?? getDefaultHostModes(tool)]),
    ),
  };

  return {
    ...raw,
    version: 1,
    hosts: {
      ...(isRecord(raw.hosts) ? raw.hosts : {}),
      enabled,
      capabilities,
      modes,
    },
    trustedStateCommands: {
      ...config.trustedStateCommands,
      work: config.trustedStateCommands.work ?? {
        argv: ["aie", "status", "--json"],
        timeoutMs: defaults.timeouts.commandMs,
        maxOutputBytes: 1_048_576,
      },
    },
    continuation: {
      ...config.continuation,
      modes: config.continuation.modes,
      stopOnUnknownState: true,
      stopOnUnsafeState: true,
      stopOnSupplyChainApprovalBlock: true,
      allowProviderMutation: false,
      allowBackgroundScheduling: false,
      trustUnstructuredProse: false,
    },
    timeouts: config.timeouts,
    cooldowns: config.cooldowns,
    paths: config.paths,
    supplyChain: {
      ...config.supplyChain,
      stopOnApprovalRequired: true,
    },
  };
}

interface ExistingText {
  readonly exists: boolean;
  readonly content?: string;
  readonly error?: string;
}

function readExistingText(absolutePath: string): ExistingText {
  if (!existsSync(absolutePath)) {
    return { exists: false };
  }
  try {
    return { exists: true, content: readFileSync(absolutePath, "utf8") };
  } catch (error) {
    return {
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function classifyTextWrite(existing: ExistingText, desired: string, force: boolean): { readonly operation: AiuInitFileOperation; readonly reason: string } {
  if (!existing.exists) {
    return { operation: "create", reason: reasonForOperation("create") };
  }
  if (existing.error !== undefined) {
    return { operation: "conflict", reason: `Existing path could not be read: ${existing.error}` };
  }
  if (normalizeText(existing.content ?? "") === normalizeText(desired)) {
    return { operation: "skip", reason: reasonForOperation("skip") };
  }
  const operation = force ? "update" : "conflict";
  return { operation, reason: reasonForOperation(operation) };
}

function classifyConfigWrite(
  existing: ExistingText,
  existingRaw: ReturnType<typeof parseJsonObject>,
  desired: string,
  force: boolean,
): { readonly operation: AiuInitFileOperation; readonly reason: string } {
  if (!existing.exists) {
    return { operation: "create", reason: reasonForOperation("create") };
  }
  if (existing.error !== undefined) {
    return { operation: "conflict", reason: `Existing config could not be read: ${existing.error}` };
  }
  if (!existingRaw.ok) {
    const operation = force ? "update" : "conflict";
    return { operation, reason: operation === "update" ? "Existing config is invalid JSON and --force was provided." : "Existing config is not valid JSON." };
  }
  if (stableJson(existingRaw.value) === desired) {
    return { operation: "skip", reason: reasonForOperation("skip") };
  }
  const operation = force ? "update" : "conflict";
  return { operation, reason: reasonForOperation(operation) };
}

function reasonForOperation(operation: AiuInitFileOperation): string {
  if (operation === "create") return "Managed file does not exist yet.";
  if (operation === "update") return "Existing managed file differs and --force was provided.";
  if (operation === "skip") return "Existing managed file already matches the planned content.";
  return "Existing file differs; preserving it unless --force is provided.";
}

function formatFileGroup(title: string, plan: AiuInitPlan, operation: AiuInitFileOperation): string {
  const files = [...plan.files, plan.config].filter((file) => file.operation === operation);
  return [`${title}:`, ...(files.length === 0 ? ["- none"] : files.map((file) => `- ${file.relativePath}: ${file.reason}`)), ""].join("\n");
}

function parseJsonObject(raw: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function readMergedHosts(config: Record<string, unknown>): readonly AiuHost[] {
  const hosts = isRecord(config.hosts) && Array.isArray(config.hosts.enabled) ? config.hosts.enabled : [];
  return hosts.filter((host): host is AiuHost => typeof host === "string" && ["opencode", "codex", "claude-code"].includes(host));
}

function readMergedTrustedStateCommandNames(config: Record<string, unknown>): readonly string[] {
  return isRecord(config.trustedStateCommands) ? Object.keys(config.trustedStateCommands).sort() : [];
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
