import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

import { loadAiuConfig } from "./config.js";
import { getAllAiuHostCapabilityProfiles } from "./host_policy.js";

export interface AiuMigrationOptions {
  readonly cwd?: string;
  readonly dryRun?: boolean;
}

export interface AiuMigrationPlan {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly repoRoot: string;
  readonly repoLocalHooks: readonly AiuMigrationFinding[];
  readonly localCheckoutReferences: readonly AiuMigrationFinding[];
  readonly scanErrors: readonly AiuMigrationFinding[];
  readonly cleanupCandidates: readonly AiuMigrationFinding[];
  readonly managedSections: readonly AiuMigrationManagedSection[];
  readonly customizationPoints: readonly string[];
  readonly conflicts: readonly AiuMigrationFinding[];
  readonly statePreservation: AiuMigrationStatePreservation;
  readonly requiredTrustSteps: readonly string[];
  readonly plannedCommands: readonly string[];
  readonly recommendedNextCommand: string;
}

export interface AiuMigrationFinding {
  readonly relativePath: string;
  readonly category: string;
  readonly reason: string;
}

export interface AiuMigrationManagedSection {
  readonly relativePath: string;
  readonly owner: "@tjalve/aiu";
  readonly action: "create-or-update" | "review";
  readonly reason: string;
}

export interface AiuMigrationStatePreservation {
  readonly stateDir: string;
  readonly exists: boolean;
  readonly action: "preserve";
  readonly reason: string;
}

const HOST_FILE_PATHS = Object.freeze([
  path.join(".opencode", "plugins", "ai-umpire-continuation.ts"),
  path.join(".codex", "hooks", "ai-umpire-stop.json"),
  path.join(".claude", "hooks", "ai-umpire-stop.json"),
]);
const SEARCH_ROOTS = Object.freeze([".opencode", ".codex", ".claude"]);
const SEARCH_FILES = Object.freeze(["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "aiu.config.json"]);
const LOCAL_CHECKOUT_PATTERN = /(?:file:|link:|workspace:|(?:\.\.\/)+)[:./\\\w-]*ai-umpire|(?:^|["'\s])\/[^"'\s]*ai-umpire(?:\/|["'\s]|$)/i;

export function planAiuMigration(options: AiuMigrationOptions = {}): AiuMigrationPlan {
  const configLoad = loadAiuConfig({ cwd: options.cwd });
  const repoRoot = configLoad.repoRoot;
  const dryRun = options.dryRun !== false;
  const repoLocalHooks = findRepoLocalHooks(repoRoot);
  const scanErrors: AiuMigrationFinding[] = [];
  const localCheckoutReferences = findLocalCheckoutReferences(repoRoot, scanErrors);
  const conflicts = [
    ...repoLocalHooks.map((finding) => ({
      relativePath: finding.relativePath,
      category: "migration-review-required",
      reason: `Review ${finding.category} before replacing it with package-managed content.`,
    })),
    ...localCheckoutReferences.map((finding) => ({
      relativePath: finding.relativePath,
      category: "migration-review-required",
      reason: `Review ${finding.category} before replacing it with the package-backed aiu dependency.`,
    })),
    ...scanErrors.map((finding) => ({
      relativePath: finding.relativePath,
      category: "migration-scan-error",
      reason: finding.reason,
    })),
  ];
  const cleanupCandidates = [...repoLocalHooks, ...localCheckoutReferences].map((finding) => ({
    relativePath: finding.relativePath,
    category: "cleanup-candidate",
    reason: `Review after package-backed migration replaces ${finding.category}.`,
  }));
  const managedSections = HOST_FILE_PATHS.map((relativePath) => ({
    relativePath,
    owner: "@tjalve/aiu" as const,
    action: "create-or-update" as const,
    reason: "Package-owned host integration managed by aiu init or migrate apply.",
  }));
  const stateDir = configLoad.config.paths.stateDir;

  return Object.freeze({
    ok: conflicts.length === 0,
    dryRun,
    repoRoot,
    repoLocalHooks: Object.freeze(repoLocalHooks),
    localCheckoutReferences: Object.freeze(localCheckoutReferences),
    scanErrors: Object.freeze(scanErrors),
    cleanupCandidates: Object.freeze(cleanupCandidates),
    managedSections: Object.freeze(managedSections),
    customizationPoints: Object.freeze([
      "aiu.config.json trustedStateCommands argv arrays",
      "host trust settings outside package-managed files",
      "prompt text outside package-managed sections",
      ".umpire/ durable state",
    ]),
    conflicts: Object.freeze(conflicts),
    statePreservation: Object.freeze({
      stateDir,
      exists: existsSync(path.resolve(repoRoot, stateDir)),
      action: "preserve" as const,
      reason: "Migration preserves durable continuation state and does not delete .umpire data.",
    }),
    requiredTrustSteps: Object.freeze([...new Set(getAllAiuHostCapabilityProfiles().flatMap((profile) => profile.trustSteps))]),
    plannedCommands: Object.freeze(["aiu init --dry-run --json", "aiu init --tool all"]),
    recommendedNextCommand: "aiu init --dry-run --json",
  });
}

export function formatMigrationPlan(plan: AiuMigrationPlan): string {
  return [
    `repoRoot: ${plan.repoRoot}`,
    `mode: ${plan.dryRun ? "dry-run" : "audit"}`,
    "",
    formatFindingGroup("Repo-local hooks", plan.repoLocalHooks),
    formatFindingGroup("Local-checkout references", plan.localCheckoutReferences),
    formatFindingGroup("Scan errors", plan.scanErrors),
    formatFindingGroup("Cleanup candidates", plan.cleanupCandidates),
    formatFindingGroup("Conflicts", plan.conflicts),
    "Package-managed sections:",
    ...plan.managedSections.map((section) => `- ${section.relativePath}: ${section.reason}`),
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

function findRepoLocalHooks(repoRoot: string): AiuMigrationFinding[] {
  return HOST_FILE_PATHS.flatMap((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath) || !safeStat(absolutePath)?.isFile()) {
      return [];
    }

    const content = readText(absolutePath);
    if (content.includes("Managed by @tjalve/aiu") || content.includes('"managedBy": "@tjalve/aiu"')) {
      return [];
    }

    return [
      {
        relativePath,
        category: "repo-local-hook",
        reason: "Host integration file exists but is not package-managed by @tjalve/aiu.",
      },
    ];
  });
}

function findLocalCheckoutReferences(repoRoot: string, scanErrors: AiuMigrationFinding[]): AiuMigrationFinding[] {
  return candidateTextFiles(repoRoot, scanErrors).flatMap((relativePath) => {
    const content = readText(path.join(repoRoot, relativePath));
    if (!LOCAL_CHECKOUT_PATTERN.test(content)) {
      return [];
    }

    return [
      {
        relativePath,
        category: "local-checkout-reference",
        reason: "File appears to reference a local ai-umpire checkout or file/link package path.",
      },
    ];
  });
}

function candidateTextFiles(repoRoot: string, scanErrors: AiuMigrationFinding[]): string[] {
  const directFiles = SEARCH_FILES.filter((relativePath) => existsSync(path.join(repoRoot, relativePath)));
  const nestedFiles = SEARCH_ROOTS.flatMap((relativeRoot) => collectTextFiles(repoRoot, relativeRoot, scanErrors));
  return [...new Set([...directFiles, ...nestedFiles])];
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
    });
    return [];
  }

  return entries.flatMap((entry) => {
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

function isTextCandidate(relativePath: string): boolean {
  return [".json", ".jsonc", ".md", ".ts", ".js", ".mjs", ".cjs", ".yaml", ".yml", ".toml", ".txt"].includes(path.extname(relativePath));
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

function formatFindingGroup(title: string, findings: readonly AiuMigrationFinding[]): string {
  const body = findings.length === 0 ? ["- none"] : findings.map((finding) => `- ${finding.relativePath} [${finding.category}]: ${finding.reason}`);
  return [title, ...body, ""].join("\n");
}
