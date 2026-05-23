import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

import { loadAiuConfig } from "./config.js";
import { getAllAiuHostCapabilityProfiles } from "./host_policy.js";
import { planAiuInit } from "./init.js";

export interface AiuMigrationOptions {
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export interface AiuMigrationPlan {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly repoRoot: string;
  readonly configPath: string;
  readonly packageBackedCommandPaths: readonly AiuMigrationPackageCommand[];
  readonly inventory: readonly AiuMigrationFinding[];
  readonly detectedCategories: readonly string[];
  readonly repoLocalHooks: readonly AiuMigrationFinding[];
  readonly localCheckoutReferences: readonly AiuMigrationFinding[];
  readonly copiedHelpers: readonly AiuMigrationFinding[];
  readonly commandWrappers: readonly AiuMigrationFinding[];
  readonly promptCustomizations: readonly AiuMigrationFinding[];
  readonly existingConfig: readonly AiuMigrationFinding[];
  readonly stateFindings: readonly AiuMigrationFinding[];
  readonly hostInstructionReferences: readonly AiuMigrationFinding[];
  readonly trustedCommandDescriptors: readonly AiuMigrationFinding[];
  readonly reviewRequired: readonly AiuMigrationFinding[];
  readonly scanErrors: readonly AiuMigrationFinding[];
  readonly cleanupCandidates: readonly AiuMigrationFinding[];
  readonly managedSections: readonly AiuMigrationManagedSection[];
  readonly filesToCreate: readonly AiuMigrationFileAction[];
  readonly filesToUpdate: readonly AiuMigrationFileAction[];
  readonly filesToPreserve: readonly AiuMigrationFileAction[];
  readonly customizationPoints: readonly string[];
  readonly conflicts: readonly AiuMigrationFinding[];
  readonly warnings: readonly string[];
  readonly statePreservation: AiuMigrationStatePreservation;
  readonly stateMigrations: readonly AiuMigrationStateMigration[];
  readonly requiredConfirmations: readonly string[];
  readonly requiredTrustSteps: readonly string[];
  readonly hostTrustSteps: readonly string[];
  readonly plannedCommands: readonly string[];
  readonly recommendedNextCommand: string;
}

export interface AiuMigrationFinding {
  readonly relativePath: string;
  readonly category: string;
  readonly reason: string;
  readonly confidence?: "high" | "medium" | "low";
  readonly fingerprint?: string;
  readonly sourceCommandSummary?: string;
  readonly requiredReview?: boolean;
  readonly host?: string;
  readonly evidence?: string;
}

export interface AiuMigrationManagedSection {
  readonly relativePath: string;
  readonly owner: "@tjalve/aiu";
  readonly action: "create-or-update" | "review";
  readonly reason: string;
}

export interface AiuMigrationFileAction {
  readonly relativePath: string;
  readonly action: "create" | "update" | "preserve" | "review";
  readonly category: string;
  readonly reason: string;
  readonly fingerprint?: string;
}

export interface AiuMigrationStateMigration {
  readonly relativePath: string;
  readonly action: "preserve";
  readonly recognized: boolean;
  readonly schemaVersion?: number | string;
  readonly reason: string;
  readonly fingerprint?: string;
}

export interface AiuMigrationStatePreservation {
  readonly stateDir: string;
  readonly exists: boolean;
  readonly action: "preserve";
  readonly reason: string;
}

export interface AiuMigrationPackageCommand {
  readonly id: string;
  readonly command: string;
  readonly host?: string;
  readonly reason: string;
}

export interface AiuMigrationApplyResult {
  readonly ok: boolean;
  readonly dryRun: false;
  readonly applied: true;
  readonly force: boolean;
  readonly repoRoot: string;
  readonly configPath: string;
  readonly plan: AiuMigrationPlan;
  readonly changed: readonly AiuMigrationApplyAction[];
  readonly preserved: readonly AiuMigrationApplyAction[];
  readonly skipped: readonly AiuMigrationApplyAction[];
  readonly conflicted: readonly AiuMigrationApplyAction[];
  readonly reviewRequired: readonly AiuMigrationApplyAction[];
  readonly warnings: readonly string[];
  readonly statePreservation: AiuMigrationStatePreservation;
  readonly requiredTrustSteps: readonly string[];
  readonly recommendedNextCommand: string;
}

export interface AiuMigrationApplyAction {
  readonly relativePath: string;
  readonly action: "create" | "update" | "preserve" | "skip" | "conflict" | "review";
  readonly category: string;
  readonly reason: string;
  readonly fingerprint?: string;
}

interface ManagedHostPath {
  readonly host: string;
  readonly relativePath: string;
  readonly content: string;
}

const SEARCH_ROOTS = Object.freeze([".opencode", ".agents", "plugins", ".claude", ".codex", "scripts", ".umpire"]);
const SEARCH_FILES = Object.freeze(["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "aiu.config.json", "AGENTS.md", "CLAUDE.md", "README.md"]);
const MANIFEST_FILE_NAMES = new Set(["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"]);
const RECURSIVE_SCAN_IGNORES = new Set([".git", "node_modules", "dist", "coverage", ".turbo", ".next", ".cache"]);
const LOCAL_CHECKOUT_PATTERN = /(?:file:|link:|workspace:|(?:\.\.\/)+)[:./\\\w-]*(?:ai-umpire|@tjalve\/aiu)|(?:^|["'\s])\/[^"'\s]*(?:ai-umpire|@tjalve\/aiu)(?:\/|["'\s]|$)/i;
const AIU_TEXT_PATTERN = /\b(?:aiu|ai-umpire|umpire)\b/i;
const PACKAGE_BACKED_COMMANDS: readonly AiuMigrationPackageCommand[] = Object.freeze([
  Object.freeze({ id: "aiu", command: "pnpm exec aiu", reason: "Package-backed CLI entrypoint for repository commands." }),
  Object.freeze({ id: "opencode-plugin", command: "import { createAiuOpenCodePlugin } from \"@tjalve/aiu/opencode\"", host: "opencode", reason: "Package-backed OpenCode plugin wrapper import." }),
  Object.freeze({ id: "codex-stop-hook", command: "pnpm exec aiu hook-stop --tool codex", host: "codex", reason: "Package-backed Codex Stop hook command." }),
  Object.freeze({ id: "claude-code-stop-hook", command: "pnpm exec aiu hook-stop --tool claude-code", host: "claude-code", reason: "Package-backed Claude Code Stop hook command." }),
]);

export function planAiuMigration(options: AiuMigrationOptions = {}): AiuMigrationPlan {
  const configLoad = loadAiuConfig({ cwd: options.cwd });
  const repoRoot = configLoad.repoRoot;
  const dryRun = options.dryRun !== false;
  const scanErrors: AiuMigrationFinding[] = [];
  const candidates = candidateTextFiles(repoRoot, scanErrors);
  const managedHostPaths = getManagedHostPaths();
  const managedPathSet = new Set(managedHostPaths.map((file) => file.relativePath));
  const managedState = inspectManagedHostPaths(repoRoot, managedHostPaths);
  const repoLocalHooks = uniqueFindings([
    ...managedState.repoLocalHooks,
    ...findOldHookEntries(repoRoot, candidates, managedPathSet),
  ]);
  const localCheckoutReferences = findLocalCheckoutReferences(repoRoot, candidates);
  const copiedHelpers = findCopiedHelpers(repoRoot, candidates);
  const commandWrappers = findCommandWrappers(repoRoot, candidates);
  const promptCustomizations = findPromptCustomizations(repoRoot, configLoad.selectedPath, candidates);
  const existingConfig = findExistingConfig(repoRoot, configLoad.selectedPath);
  const { stateFindings, stateMigrations } = findState(repoRoot);
  const hostInstructionReferences = findHostInstructionReferences(repoRoot, candidates);
  const trustedCommandDescriptors = findTrustedCommandDescriptors(configLoad.selectedPath, configLoad.config.trustedStateCommands);
  const knownPaths = new Set([
    ...managedPathSet,
    ...localCheckoutReferences.map((finding) => finding.relativePath),
    ...copiedHelpers.map((finding) => finding.relativePath),
    ...commandWrappers.map((finding) => finding.relativePath),
    ...promptCustomizations.map((finding) => finding.relativePath),
    ...existingConfig.map((finding) => finding.relativePath),
    ...stateFindings.map((finding) => finding.relativePath),
    ...hostInstructionReferences.map((finding) => finding.relativePath),
    ...trustedCommandDescriptors.map((finding) => finding.relativePath),
  ]);
  const unknownFiles = findUnknownAiuFiles(repoRoot, candidates, knownPaths);
  const inventory = uniqueFindings([
    ...repoLocalHooks,
    ...localCheckoutReferences,
    ...copiedHelpers,
    ...commandWrappers,
    ...promptCustomizations,
    ...existingConfig,
    ...stateFindings,
    ...hostInstructionReferences,
    ...trustedCommandDescriptors,
    ...unknownFiles,
    ...scanErrors,
  ]);
  const reviewRequired = inventory.filter((finding) => finding.requiredReview === true || finding.category === "scan-error");
  const cleanupCandidates = conservativeCleanupCandidates([
    ...repoLocalHooks,
    ...localCheckoutReferences,
    ...copiedHelpers,
    ...commandWrappers,
  ]);
  const conflicts = reviewRequired.map((finding) => findingFrom(finding, {
    category: finding.category === "scan-error" ? "migration-scan-error" : "migration-review-required",
    reason: finding.category === "scan-error"
      ? finding.reason
      : `Review ${finding.category} before any package-backed migration apply step.`,
  }));
  const managedSections = managedHostPaths.map((file) => ({
    relativePath: file.relativePath,
    owner: "@tjalve/aiu" as const,
    action: repoLocalHooks.some((finding) => finding.relativePath === file.relativePath) ? "review" as const : "create-or-update" as const,
    reason: "Package-owned host integration managed by aiu init or migrate apply.",
  }));
  const filesToCreate = managedHostPaths
    .filter((file) => !existsSync(path.join(repoRoot, file.relativePath)))
    .map((file) => fileAction(file.relativePath, "create", "package-managed-host-file", "Create package-backed host integration content."));
  const filesToUpdate = [
    ...repoLocalHooks.map((finding) => fileAction(finding.relativePath, "update", finding.category, "Replace reviewed repo-local host content with package-backed managed content.", finding.fingerprint)),
    ...localCheckoutReferences.map((finding) => fileAction(finding.relativePath, "update", finding.category, "Replace repo-local package or command path references with package-backed commands.", finding.fingerprint)),
  ];
  const filesToPreserve = [
    ...existingConfig.map((finding) => fileAction(finding.relativePath, "preserve", finding.category, "Preserve existing repository config and merge only explicit future changes.", finding.fingerprint)),
    ...promptCustomizations.map((finding) => fileAction(finding.relativePath, "preserve", finding.category, "Preserve prompt customization for explicit review.", finding.fingerprint)),
    ...stateFindings.map((finding) => fileAction(finding.relativePath, "preserve", finding.category, "Preserve durable local state.", finding.fingerprint)),
    ...unknownFiles.map((finding) => fileAction(finding.relativePath, "review", finding.category, "Unknown AI Umpire-related file is preserved until explicit cleanup confirmation.", finding.fingerprint)),
    ...managedState.packageBackedFiles.map((finding) => fileAction(finding.relativePath, "preserve", finding.category, "Existing package-backed managed content is already in target shape.", finding.fingerprint)),
  ];
  const stateDir = configLoad.config.paths.stateDir;
  const requiredTrustSteps = [...new Set(getAllAiuHostCapabilityProfiles().flatMap((profile) => profile.trustSteps))];

  return Object.freeze({
    ok: conflicts.length === 0,
    dryRun,
    repoRoot,
    configPath: configLoad.selectedPath,
    packageBackedCommandPaths: Object.freeze([...PACKAGE_BACKED_COMMANDS]),
    inventory: Object.freeze(inventory),
    detectedCategories: Object.freeze([...new Set(inventory.map((finding) => finding.category))].sort()),
    repoLocalHooks: Object.freeze(repoLocalHooks),
    localCheckoutReferences: Object.freeze(localCheckoutReferences),
    copiedHelpers: Object.freeze(copiedHelpers),
    commandWrappers: Object.freeze(commandWrappers),
    promptCustomizations: Object.freeze(promptCustomizations),
    existingConfig: Object.freeze(existingConfig),
    stateFindings: Object.freeze(stateFindings),
    hostInstructionReferences: Object.freeze(hostInstructionReferences),
    trustedCommandDescriptors: Object.freeze(trustedCommandDescriptors),
    reviewRequired: Object.freeze(reviewRequired),
    scanErrors: Object.freeze(scanErrors),
    cleanupCandidates: Object.freeze(cleanupCandidates),
    managedSections: Object.freeze(managedSections),
    filesToCreate: Object.freeze(filesToCreate),
    filesToUpdate: Object.freeze(filesToUpdate),
    filesToPreserve: Object.freeze(filesToPreserve),
    customizationPoints: Object.freeze([
      "aiu.config.json trustedStateCommands argv arrays",
      "host trust settings outside package-managed files",
      "prompt text outside package-managed sections",
      ".umpire/ durable state",
    ]),
    conflicts: Object.freeze(conflicts),
    warnings: Object.freeze(conflicts.map((finding) => finding.reason)),
    statePreservation: Object.freeze({
      stateDir,
      exists: existsSync(path.resolve(repoRoot, stateDir)),
      action: "preserve" as const,
      reason: "Migration preserves durable continuation state and does not delete .umpire data.",
    }),
    stateMigrations: Object.freeze(stateMigrations),
    requiredConfirmations: Object.freeze([
      "Review each migration-review-required item before apply.",
      "Confirm host trust settings after managed host files are written.",
      "Confirm cleanup candidates explicitly in the later cleanup command before deleting files.",
    ]),
    requiredTrustSteps: Object.freeze(requiredTrustSteps),
    hostTrustSteps: Object.freeze(requiredTrustSteps),
    plannedCommands: Object.freeze(["aiu migrate --dry-run --json", "aiu init --dry-run --json", "aiu init --tool all"]),
    recommendedNextCommand: "aiu init --dry-run --json",
  });
}

export function applyAiuMigration(options: AiuMigrationOptions = {}): AiuMigrationApplyResult {
  const force = options.force === true;
  const plan = planAiuMigration({ cwd: options.cwd, dryRun: false });
  const managedHostPaths = getManagedHostPaths();
  const managedPathSet = new Set(managedHostPaths.map((file) => file.relativePath));
  const changed: AiuMigrationApplyAction[] = [];
  const preserved: AiuMigrationApplyAction[] = [];
  const skipped: AiuMigrationApplyAction[] = [];
  const conflicted: AiuMigrationApplyAction[] = [];
  const unresolvedReview = plan.reviewRequired
    .filter((finding) => !(force && managedPathSet.has(finding.relativePath)))
    .map((finding) => applyAction(finding.relativePath, "review", finding.category, finding.reason, finding.fingerprint));
  const unresolvedPlanConflicts = plan.conflicts
    .filter((finding) => !(force && managedPathSet.has(finding.relativePath)))
    .map((finding) => applyAction(finding.relativePath, "conflict", finding.category, finding.reason, finding.fingerprint));

  collectPreservedApplyDiagnostics(plan, preserved);
  skipped.push(...plan.cleanupCandidates.map((finding) => applyAction(finding.relativePath, "skip", "cleanup-candidate", "Cleanup is intentionally deferred to the explicit cleanup command.", finding.fingerprint)));

  if (unresolvedReview.length > 0 || unresolvedPlanConflicts.length > 0) {
    skipped.push(...plan.filesToCreate.map((item) => applyAction(item.relativePath, "skip", item.category, "Apply is blocked until review-required migration paths are resolved.", item.fingerprint)));
    skipped.push(...plan.filesToUpdate.map((item) => applyAction(item.relativePath, "skip", item.category, "Apply is blocked until review-required migration paths are resolved.", item.fingerprint)));
    skipped.push(...unresolvedReview.map((action) => applyAction(action.relativePath, "skip", action.category, "Review-required path was preserved without mutation.", action.fingerprint)));
    return finalizeApplyResult(plan, force, managedPathSet, changed, preserved, skipped, unresolvedPlanConflicts, unresolvedReview);
  }

  applyConfig(plan, changed, preserved, conflicted);

  for (const file of managedHostPaths) {
    const absolutePath = path.join(plan.repoRoot, file.relativePath);
    const existing = readExistingManagedText(absolutePath);
    if (!existing.exists) {
      const writeError = tryWriteManagedText(absolutePath, file.content);
      if (writeError !== undefined) {
        conflicted.push(applyAction(file.relativePath, "conflict", "package-managed-host-file", `Managed host file could not be written: ${writeError}`));
        continue;
      }
      changed.push(applyAction(file.relativePath, "create", "package-managed-host-file", "Created package-backed host integration content."));
      continue;
    }
    if (existing.error !== undefined) {
      conflicted.push(applyAction(file.relativePath, "conflict", "package-managed-host-file", `Existing managed host file could not be read: ${existing.error}`));
      continue;
    }
    if (isPackageBackedManagedContent(existing.content ?? "", file.content)) {
      preserved.push(applyAction(file.relativePath, "preserve", "package-backed-host-file", "Existing package-backed managed content already matches the target shape.", fingerprintText(existing.content ?? "")));
      continue;
    }
    if (force) {
      const writeError = tryWriteManagedText(absolutePath, file.content);
      if (writeError !== undefined) {
        conflicted.push(applyAction(file.relativePath, "conflict", "package-managed-host-file", `Managed host file could not be written: ${writeError}`, fingerprintText(existing.content ?? "")));
        continue;
      }
      changed.push(applyAction(file.relativePath, "update", "package-managed-host-file", "Replaced differing managed host file because --force was provided.", fingerprintText(existing.content ?? "")));
      continue;
    }
    conflicted.push(applyAction(file.relativePath, "conflict", "package-managed-host-file", "Existing managed host file differs; preserving it unless --force is provided.", fingerprintText(existing.content ?? "")));
  }

  return finalizeApplyResult(plan, force, managedPathSet, changed, preserved, skipped, conflicted, []);
}

function finalizeApplyResult(
  plan: AiuMigrationPlan,
  force: boolean,
  managedPathSet: ReadonlySet<string>,
  changed: readonly AiuMigrationApplyAction[],
  preserved: readonly AiuMigrationApplyAction[],
  skipped: readonly AiuMigrationApplyAction[],
  conflicted: readonly AiuMigrationApplyAction[],
  reviewRequired: readonly AiuMigrationApplyAction[],
): AiuMigrationApplyResult {
  const allConflicted = uniqueApplyActions(conflicted);
  const allReviewRequired = uniqueApplyActions(reviewRequired);
  const warnings = uniqueStrings([
    ...allConflicted.map((item) => `${item.relativePath}: ${item.reason}`),
    ...allReviewRequired.map((item) => `${item.relativePath}: ${item.reason}`),
  ]);
  const recommendedNextCommand = recommendApplyNextCommand(allConflicted, allReviewRequired, managedPathSet, force);

  return Object.freeze({
    ok: allConflicted.length === 0 && allReviewRequired.length === 0,
    dryRun: false as const,
    applied: true as const,
    force,
    repoRoot: plan.repoRoot,
    configPath: plan.configPath,
    plan,
    changed: Object.freeze(uniqueApplyActions(changed)),
    preserved: Object.freeze(uniqueApplyActions(preserved)),
    skipped: Object.freeze(uniqueApplyActions(skipped)),
    conflicted: Object.freeze(allConflicted),
    reviewRequired: Object.freeze(allReviewRequired),
    warnings: Object.freeze(warnings),
    statePreservation: plan.statePreservation,
    requiredTrustSteps: plan.requiredTrustSteps,
    recommendedNextCommand,
  });
}

function collectPreservedApplyDiagnostics(plan: AiuMigrationPlan, preserved: AiuMigrationApplyAction[]): void {
  for (const item of plan.stateMigrations) {
    preserved.push(applyAction(item.relativePath, "preserve", "state-file", item.reason, item.fingerprint));
  }
  for (const finding of [...plan.existingConfig, ...plan.promptCustomizations, ...plan.trustedCommandDescriptors]) {
    preserved.push(applyAction(finding.relativePath, "preserve", finding.category, finding.reason, finding.fingerprint));
  }
}

export function formatMigrationPlan(plan: AiuMigrationPlan): string {
  return [
    `repoRoot: ${plan.repoRoot}`,
    `mode: ${plan.dryRun ? "dry-run" : "audit"}`,
    "",
    formatFindingGroup("Repo-local hooks", plan.repoLocalHooks),
    formatFindingGroup("Local-checkout references", plan.localCheckoutReferences),
    formatFindingGroup("Copied helpers", plan.copiedHelpers),
    formatFindingGroup("Command wrappers", plan.commandWrappers),
    formatFindingGroup("Prompt customizations", plan.promptCustomizations),
    formatFindingGroup("Existing config", plan.existingConfig),
    formatFindingGroup("State", plan.stateFindings),
    formatFindingGroup("Host instruction references", plan.hostInstructionReferences),
    formatFindingGroup("Trusted command descriptors", plan.trustedCommandDescriptors),
    formatFindingGroup("Review-required files", plan.reviewRequired),
    formatFindingGroup("Scan errors", plan.scanErrors),
    formatFindingGroup("Cleanup candidates", plan.cleanupCandidates),
    formatFindingGroup("Conflicts", plan.conflicts),
    "Package-backed commands:",
    ...plan.packageBackedCommandPaths.map((command) => `- ${command.id}: ${command.command}`),
    "",
    "Package-managed sections:",
    ...plan.managedSections.map((section) => `- ${section.relativePath}: ${section.reason}`),
    "",
    "Files to create:",
    ...formatFileActions(plan.filesToCreate),
    "",
    "Files to update:",
    ...formatFileActions(plan.filesToUpdate),
    "",
    "Files to preserve:",
    ...formatFileActions(plan.filesToPreserve),
    "",
    "Repo-local customization points:",
    ...plan.customizationPoints.map((point) => `- ${point}`),
    "",
    `State preservation: ${plan.statePreservation.stateDir} (${plan.statePreservation.exists ? "present" : "not present"})`,
    "",
    "Required trust steps:",
    ...plan.requiredTrustSteps.map((step) => `- ${step}`),
    "",
    `Recommended next command: ${plan.recommendedNextCommand}`,
    "",
  ].join("\n");
}

export function formatMigrationApplyResult(result: AiuMigrationApplyResult): string {
  return [
    `repoRoot: ${result.repoRoot}`,
    `mode: apply${result.force ? " --force" : ""}`,
    "",
    "Changed:",
    ...formatApplyActions(result.changed),
    "",
    "Preserved:",
    ...formatApplyActions(result.preserved),
    "",
    "Skipped:",
    ...formatApplyActions(result.skipped),
    "",
    "Conflicted:",
    ...formatApplyActions(result.conflicted),
    "",
    "Review-required:",
    ...formatApplyActions(result.reviewRequired),
    "",
    `State preservation: ${result.statePreservation.stateDir} (${result.statePreservation.exists ? "present" : "not present"})`,
    "",
    "Required trust steps:",
    ...result.requiredTrustSteps.map((step) => `- ${step}`),
    "",
    `Recommended next command: ${result.recommendedNextCommand}`,
    "",
  ].join("\n");
}

function getManagedHostPaths(): readonly ManagedHostPath[] {
  return Object.freeze(getAllAiuHostCapabilityProfiles().flatMap((profile) => {
    return profile.managedFiles.map((file) => ({
      host: profile.tool,
      relativePath: file.relativePath,
      content: file.content,
    }));
  }));
}

function inspectManagedHostPaths(repoRoot: string, managedHostPaths: readonly ManagedHostPath[]) {
  const repoLocalHooks: AiuMigrationFinding[] = [];
  const packageBackedFiles: AiuMigrationFinding[] = [];
  for (const managedFile of managedHostPaths) {
    const { relativePath } = managedFile;
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath) || !safeStat(absolutePath)?.isFile()) {
      continue;
    }

    const content = readText(absolutePath);
    const fingerprint = fingerprintText(content);
    if (isPackageBackedManagedContent(content, managedFile.content)) {
      packageBackedFiles.push({
        relativePath,
        category: "package-backed-host-file",
        reason: "Host integration file already matches package-backed managed content.",
        confidence: "high",
        fingerprint,
        host: managedFile.host,
      });
      continue;
    }

    repoLocalHooks.push({
      relativePath,
      category: content.includes("hook-stop") || content.includes("Stop") ? "old-hook-entry" : "repo-local-hook",
      reason: "Host integration file exists but is not package-managed by @tjalve/aiu.",
      confidence: "high",
      fingerprint,
      requiredReview: true,
      host: managedFile.host,
      evidence: summarizeContent(content),
    });
  }
  return { repoLocalHooks, packageBackedFiles };
}

function findLocalCheckoutReferences(repoRoot: string, candidates: readonly string[]): AiuMigrationFinding[] {
  return candidates.flatMap((relativePath) => {
    const content = readText(path.join(repoRoot, relativePath));
    if (!LOCAL_CHECKOUT_PATTERN.test(content)) {
      return [];
    }

    return [
      {
        relativePath,
        category: "local-checkout-reference",
        reason: "File references a repo-local package path or local command path that should be replaced by package-backed aiu usage.",
        confidence: "high" as const,
        fingerprint: fingerprintText(content),
        requiredReview: true,
        evidence: summarizeContent(content),
      },
    ];
  });
}

function findOldHookEntries(repoRoot: string, candidates: readonly string[], managedPathSet: ReadonlySet<string>): AiuMigrationFinding[] {
  return candidates.flatMap((relativePath) => {
    if (managedPathSet.has(relativePath)) {
      return [];
    }
    const normalized = relativePath.split(path.sep).join("/");
    if (!normalized.includes("hook") && !normalized.endsWith("settings.json")) {
      return [];
    }
    const content = readText(path.join(repoRoot, relativePath));
    if (!/(?:Stop|hook-stop|aiu|ai-umpire)/i.test(content)) {
      return [];
    }
    return [{
      relativePath,
      category: "old-hook-entry",
      reason: "Host hook entry appears related to old Umpire execution and requires review before replacement.",
      confidence: "medium" as const,
      fingerprint: fingerprintText(content),
      requiredReview: true,
      evidence: summarizeContent(content),
    }];
  });
}

function findCopiedHelpers(repoRoot: string, candidates: readonly string[]): AiuMigrationFinding[] {
  return candidates.flatMap((relativePath) => {
    const normalized = relativePath.split(path.sep).join("/");
    if (!normalized.startsWith("scripts/") && !normalized.startsWith("plugins/ai-umpire/")) {
      return [];
    }
    const content = readText(path.join(repoRoot, relativePath));
    if (!AIU_TEXT_PATTERN.test(content) && !/hook-stop|continuation|trustedStateCommands/.test(content)) {
      return [];
    }
    return [{
      relativePath,
      category: "copied-helper",
      reason: "Repository-local helper or plugin file appears related to old Umpire execution and requires review before cleanup.",
      confidence: "medium" as const,
      fingerprint: fingerprintText(content),
      requiredReview: true,
      evidence: summarizeContent(content),
    }];
  });
}

function findCommandWrappers(repoRoot: string, candidates: readonly string[]): AiuMigrationFinding[] {
  return candidates.flatMap((relativePath) => {
    const normalized = relativePath.split(path.sep).join("/");
    if (!normalized.startsWith(".opencode/commands/") && !normalized.startsWith(".agents/commands/") && !normalized.includes("/commands/")) {
      return [];
    }
    const content = readText(path.join(repoRoot, relativePath));
    if (!AIU_TEXT_PATTERN.test(content)) {
      return [];
    }
    return [{
      relativePath,
      category: "command-wrapper",
      reason: "Host command wrapper references AI Umpire behavior and should be preserved for review or moved outside managed sections.",
      confidence: "medium" as const,
      fingerprint: fingerprintText(content),
      requiredReview: true,
      evidence: summarizeContent(content),
    }];
  });
}

function findPromptCustomizations(repoRoot: string, configPath: string, candidates: readonly string[]): AiuMigrationFinding[] {
  const findings: AiuMigrationFinding[] = [];
  const configRelativePath = relativeToRepo(repoRoot, configPath);
  const config = readJsonObject(configPath);
  if (config && isRecord(config.prompts)) {
    findings.push({
      relativePath: configRelativePath,
      category: "prompt-customization",
      reason: "Config contains prompt customization that migration must preserve.",
      confidence: "high",
      fingerprint: fileFingerprint(configPath),
      requiredReview: false,
    });
  }
  for (const relativePath of candidates) {
    const normalized = relativePath.split(path.sep).join("/");
    if (!normalized.startsWith(".opencode/commands/") && !normalized.startsWith(".agents/commands/")) {
      continue;
    }
    const content = readText(path.join(repoRoot, relativePath));
    if (/prompt|instruction|continue|review/i.test(content)) {
      findings.push({
        relativePath,
        category: "prompt-customization",
        reason: "Host prompt or command text is repository-authored and preserved for review.",
        confidence: "medium",
        fingerprint: fingerprintText(content),
        requiredReview: false,
      });
    }
  }
  return uniqueFindings(findings);
}

function findExistingConfig(repoRoot: string, configPath: string): AiuMigrationFinding[] {
  if (!existsSync(configPath)) {
    return [];
  }
  return [{
    relativePath: relativeToRepo(repoRoot, configPath),
    category: "existing-config",
    reason: "Existing aiu.config.json is preserved and future apply steps should merge rather than replace repository policy.",
    confidence: "high",
    fingerprint: fileFingerprint(configPath),
  }];
}

function findState(repoRoot: string): { stateFindings: readonly AiuMigrationFinding[]; stateMigrations: readonly AiuMigrationStateMigration[] } {
  const stateRoot = path.join(repoRoot, ".umpire");
  if (!existsSync(stateRoot) || !safeStat(stateRoot)?.isDirectory()) {
    return { stateFindings: [], stateMigrations: [] };
  }
  const files = collectTextFiles(repoRoot, ".umpire", []);
  const stateFindings = files.map((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    const content = readText(absolutePath);
    const parsed = readJsonObject(absolutePath);
    return {
      relativePath,
      category: "state-file",
      reason: parsed && "schemaVersion" in parsed ? "Recognized durable local state file with schemaVersion; preserve during migration." : "Durable local state file is preserved for review.",
      confidence: parsed && "schemaVersion" in parsed ? "high" as const : "medium" as const,
      fingerprint: fingerprintText(content),
      requiredReview: false,
      evidence: parsed && "schemaVersion" in parsed ? `schemaVersion=${String(parsed.schemaVersion)}` : undefined,
    };
  });
  const stateMigrations = stateFindings.map((finding) => {
    const parsed = readJsonObject(path.join(repoRoot, finding.relativePath));
    return {
      relativePath: finding.relativePath,
      action: "preserve" as const,
      recognized: parsed !== null && "schemaVersion" in parsed,
      ...(parsed && "schemaVersion" in parsed ? { schemaVersion: readSchemaVersion(parsed.schemaVersion) } : {}),
      reason: "M5.1 dry-run inventory never rewrites or deletes durable local state.",
      ...(finding.fingerprint ? { fingerprint: finding.fingerprint } : {}),
    };
  });
  return { stateFindings: Object.freeze(stateFindings), stateMigrations: Object.freeze(stateMigrations) };
}

function findHostInstructionReferences(repoRoot: string, candidates: readonly string[]): AiuMigrationFinding[] {
  return candidates.flatMap((relativePath) => {
    const base = path.basename(relativePath);
    const normalized = relativePath.split(path.sep).join("/");
    if (!["AGENTS.md", "CLAUDE.md", "README.md"].includes(base) && !normalized.startsWith(".opencode/")) {
      return [];
    }
    const content = readText(path.join(repoRoot, relativePath));
    if (!LOCAL_CHECKOUT_PATTERN.test(content)) {
      return [];
    }
    return [{
      relativePath,
      category: "host-instruction-reference",
      reason: "Host-facing instructions mention repo-local Umpire paths and should be updated to package-backed commands.",
      confidence: "medium" as const,
      fingerprint: fingerprintText(content),
      requiredReview: true,
      evidence: summarizeContent(content),
    }];
  });
}

function findTrustedCommandDescriptors(configPath: string, trustedStateCommands: Readonly<Record<string, { readonly argv: readonly string[] }>>): AiuMigrationFinding[] {
  return Object.entries(trustedStateCommands).map(([sourceId, descriptor]) => ({
    relativePath: relativeToRepo(path.dirname(configPath), configPath),
    category: "trusted-command-descriptor",
    reason: `Trusted state command descriptor ${sourceId} is preserved as repository policy.`,
    confidence: "high" as const,
    sourceCommandSummary: descriptor.argv.join(" "),
    requiredReview: false,
  }));
}

function findUnknownAiuFiles(repoRoot: string, candidates: readonly string[], knownPaths: ReadonlySet<string>): AiuMigrationFinding[] {
  return candidates.flatMap((relativePath) => {
    if (knownPaths.has(relativePath) || MANIFEST_FILE_NAMES.has(path.basename(relativePath)) || ["README.md", "AGENTS.md", "CLAUDE.md"].includes(relativePath)) {
      return [];
    }
    const content = readText(path.join(repoRoot, relativePath));
    if (!AIU_TEXT_PATTERN.test(content)) {
      return [];
    }
    return [{
      relativePath,
      category: "unknown-aiu-file",
      reason: "Unknown AI Umpire-related file is review-required and preserved by dry-run migration.",
      confidence: "low" as const,
      fingerprint: fingerprintText(content),
      requiredReview: true,
      evidence: summarizeContent(content),
    }];
  });
}

function candidateTextFiles(repoRoot: string, scanErrors: AiuMigrationFinding[]): string[] {
  const directFiles = SEARCH_FILES.filter((relativePath) => existsSync(path.join(repoRoot, relativePath)));
  const nestedManifestFiles = collectManifestFiles(repoRoot, ".", scanErrors);
  const nestedFiles = SEARCH_ROOTS.flatMap((relativeRoot) => collectTextFiles(repoRoot, relativeRoot, scanErrors));
  return [...new Set([...directFiles, ...nestedManifestFiles, ...nestedFiles])].sort(comparePath);
}

function collectTextFiles(repoRoot: string, relativeRoot: string, scanErrors: AiuMigrationFinding[]): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot) || !safeStat(absoluteRoot)?.isDirectory()) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(absoluteRoot, { withFileTypes: true });
  } catch {
    scanErrors.push({
      relativePath: relativeRoot,
      category: "scan-error",
      reason: "Directory could not be read during migration audit; review permissions before trusting the migration plan.",
      confidence: "low",
      requiredReview: true,
    });
    return [];
  }

  return entries.sort(compareDirent).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      return collectTextFiles(repoRoot, relativePath, scanErrors);
    }
    if (!entry.isFile()) {
      return [];
    }
    return isTextCandidate(relativePath) ? [relativePath] : [];
  });
}

function collectManifestFiles(repoRoot: string, relativeRoot: string, scanErrors: AiuMigrationFinding[]): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot) || !safeStat(absoluteRoot)?.isDirectory()) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(absoluteRoot, { withFileTypes: true });
  } catch {
    scanErrors.push({
      relativePath: relativeRoot,
      category: "scan-error",
      reason: "Directory could not be read during migration manifest scan; review permissions before trusting the migration plan.",
      confidence: "low",
      requiredReview: true,
    });
    return [];
  }

  return entries.sort(compareDirent).flatMap((entry) => {
    const relativePath = relativeRoot === "." ? entry.name : path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      return RECURSIVE_SCAN_IGNORES.has(entry.name) ? [] : collectManifestFiles(repoRoot, relativePath, scanErrors);
    }
    if (!entry.isFile()) {
      return [];
    }
    return MANIFEST_FILE_NAMES.has(entry.name) ? [relativePath] : [];
  });
}

function isTextCandidate(relativePath: string): boolean {
  return [".json", ".jsonc", ".md", ".ts", ".js", ".mjs", ".cjs", ".yaml", ".yml", ".toml", ".txt"].includes(path.extname(relativePath));
}

function compareDirent(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

function comparePath(left: string, right: string): number {
  return left.localeCompare(right);
}

function safeStat(absolutePath: string) {
  try {
    return statSync(absolutePath);
  } catch {
    return null;
  }
}

function readText(absolutePath: string): string {
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      return "";
    }
    return readFileSync(absolutePath, "utf8");
  } catch {
    return "";
  }
}

interface ExistingManagedText {
  readonly exists: boolean;
  readonly content?: string;
  readonly error?: string;
}

function readExistingManagedText(absolutePath: string): ExistingManagedText {
  if (!existsSync(absolutePath)) {
    return { exists: false };
  }
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      return { exists: true, error: "Path exists but is not a file." };
    }
    return { exists: true, content: readFileSync(absolutePath, "utf8") };
  } catch (error) {
    return { exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function writeManagedText(absolutePath: string, content: string): void {
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function tryWriteManagedText(absolutePath: string, content: string): string | undefined {
  try {
    writeManagedText(absolutePath, content);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function applyConfig(
  plan: AiuMigrationPlan,
  changed: AiuMigrationApplyAction[],
  preserved: AiuMigrationApplyAction[],
  conflicted: AiuMigrationApplyAction[],
): void {
  const relativePath = relativeToRepo(plan.repoRoot, plan.configPath);
  const existing = readExistingManagedText(plan.configPath);
  if (!existing.exists) {
    const initPlan = planAiuInit({ cwd: plan.repoRoot, tool: "all" });
    const writeError = tryWriteManagedText(plan.configPath, initPlan.config.content);
    if (writeError !== undefined) {
      conflicted.push(applyAction(relativePath, "conflict", "package-config", `Config could not be written: ${writeError}`));
      return;
    }
    changed.push(applyAction(relativePath, "create", "package-config", "Created package-backed aiu.config.json defaults."));
    return;
  }
  if (existing.error !== undefined) {
    conflicted.push(applyAction(relativePath, "conflict", "existing-config", `Existing config could not be read: ${existing.error}`));
    return;
  }
  if (readJsonObject(plan.configPath) === null) {
    conflicted.push(applyAction(relativePath, "conflict", "existing-config", "Existing config is not valid JSON; preserving it until repaired."));
    return;
  }
  preserved.push(applyAction(relativePath, "preserve", "existing-config", "Existing repository config and policy choices were preserved.", fingerprintText(existing.content ?? "")));
}

function readJsonObject(absolutePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readText(absolutePath)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPackageBackedManagedContent(content: string, expectedContent: string): boolean {
  return normalizeText(content) === normalizeText(expectedContent);
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function fingerprintText(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function fileFingerprint(absolutePath: string): string | undefined {
  const content = readText(absolutePath);
  return content === "" ? undefined : fingerprintText(content);
}

function summarizeContent(content: string): string | undefined {
  const line = content.split(/\r?\n/).find((item) => item.trim().length > 0);
  return line ? line.trim().slice(0, 120) : undefined;
}

function findingFrom(finding: AiuMigrationFinding, override: Pick<AiuMigrationFinding, "category" | "reason">): AiuMigrationFinding {
  return {
    ...finding,
    category: override.category,
    reason: override.reason,
  };
}

function conservativeCleanupCandidates(findings: readonly AiuMigrationFinding[]): readonly AiuMigrationFinding[] {
  return Object.freeze(findings.map((finding) => findingFrom(finding, {
    category: "cleanup-candidate",
    reason: `Review after package-backed migration replaces ${finding.category}; deletion requires an explicit later cleanup confirmation.`,
  })));
}

function fileAction(relativePath: string, action: AiuMigrationFileAction["action"], category: string, reason: string, fingerprint?: string): AiuMigrationFileAction {
  return {
    relativePath,
    action,
    category,
    reason,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function uniqueFindings(findings: readonly AiuMigrationFinding[]): AiuMigrationFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.category}\0${finding.relativePath}\0${finding.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function relativeToRepo(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath === "" ? path.basename(absolutePath) : relativePath;
}

function readSchemaVersion(value: unknown): number | string | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function applyAction(relativePath: string, action: AiuMigrationApplyAction["action"], category: string, reason: string, fingerprint?: string): AiuMigrationApplyAction {
  return {
    relativePath,
    action,
    category,
    reason,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function uniqueApplyActions(actions: readonly AiuMigrationApplyAction[]): AiuMigrationApplyAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.action}\0${action.category}\0${action.relativePath}\0${action.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function recommendApplyNextCommand(
  conflicted: readonly AiuMigrationApplyAction[],
  reviewRequired: readonly AiuMigrationApplyAction[],
  managedPathSet: ReadonlySet<string>,
  force: boolean,
): string {
  if (conflicted.length === 0 && reviewRequired.length === 0) {
    return "aiu doctor --json";
  }
  const unresolved = [...conflicted, ...reviewRequired];
  const onlyManagedHostConflicts = unresolved.every((action) => managedPathSet.has(action.relativePath));
  if (!force && onlyManagedHostConflicts) {
    return "aiu migrate --apply --force --json";
  }
  return "Review reported paths, then rerun aiu migrate --dry-run --json.";
}

function formatFindingGroup(title: string, findings: readonly AiuMigrationFinding[]): string {
  const body = findings.length === 0 ? ["- none"] : findings.map((finding) => {
    const confidence = finding.confidence ? ` confidence=${finding.confidence}` : "";
    const fingerprint = finding.fingerprint ? ` ${finding.fingerprint}` : "";
    return `- ${finding.relativePath} [${finding.category}${confidence}]: ${finding.reason}${fingerprint}`;
  });
  return [title, ...body, ""].join("\n");
}

function formatFileActions(actions: readonly AiuMigrationFileAction[]): string[] {
  return actions.length === 0 ? ["- none"] : actions.map((action) => `- ${action.relativePath} [${action.action}/${action.category}]: ${action.reason}`);
}

function formatApplyActions(actions: readonly AiuMigrationApplyAction[]): string[] {
  return actions.length === 0 ? ["- none"] : actions.map((action) => `- ${action.relativePath} [${action.action}/${action.category}]: ${action.reason}`);
}
