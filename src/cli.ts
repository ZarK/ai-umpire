import { createCli, createCommand, createSchemaCommand, runCli } from "@tjalve/qube-cli/runtime";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getAiuPackageRoot } from "./assets.js";
import {
  AIU_CONFIG_FILENAME,
  AIU_CONFIG_SCHEMA_VERSION,
  AIU_HOST_CAPABILITY_NAMES,
  AIU_HOSTS,
  AIU_PROMPT_SECTION_KINDS,
  formatConfigDiagnostics,
  getDefaultAiuConfig,
  loadAiuConfig,
} from "./config.js";
import { AIU_COMMAND_REGISTRY, configCommand, doctorCommand, hookStopCommand, initCommand, migrateCommand, pathsCommand, statusCommand, whipCommand } from "./command_registry.js";
import { AIU_DECISION_MODES, AIU_DECISION_PROMPT_KINDS } from "./decision.js";
import { formatAiuDoctorReport, formatAiuPaths, getAiuResolvedPaths, runAiuDoctor } from "./doctor.js";
import { AIU_HOST_CAPABILITY_SUPPORT, AIU_HOST_SUPPORT_LEVELS, getAllAiuHostCapabilityProfiles } from "./host_policy.js";
import { formatHookStopJson, readHookStopStdin, runAiuHookStop } from "./hook_stop.js";
import { applyAiuInitPlan, formatInitPlan, planAiuInit, type AiuInitTool } from "./init.js";
import { formatMigrationPlan, planAiuMigration } from "./migrate.js";
import { AIU_STATUS_ERROR_CODES, formatAiuStatusReport, runAiuStatus } from "./status.js";
import {
  AIU_REASON_CODE_CATALOG,
  AIU_QUALITY_TARGET_KINDS,
  AIU_STATE_CAPABILITY_SUPPORT,
  AIU_STATE_FRESHNESS_KINDS,
  AIU_STATE_VALUE_KINDS,
  AIU_TRUSTED_STATE_KINDS,
  AIU_TRUSTED_STATE_SCHEMA_VERSION,
  AIU_TRUST_LEVELS,
} from "./state.js";
import { AIU_TRUSTED_ADAPTER_ERROR_CODES } from "./trusted_adapter.js";
import { AIU_WHIP_ERROR_CODES, AIU_WHIP_STATE_SCHEMA_VERSION, AIU_WHIP_TASK_SOURCES, AIU_WHIP_TASK_STATUSES, formatAiuWhipReport, runAiuWhipCommand, type AiuWhipReport } from "./whip.js";

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

const packageJson = JSON.parse(readFileSync(path.join(getAiuPackageRoot(), "package.json"), "utf8")) as PackageJson;
let runtimeRegistry = AIU_COMMAND_REGISTRY;

export const aiuCli = createCli({
  bin: "aiu",
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  description: packageJson.description,
  registry: AIU_COMMAND_REGISTRY,
  commands: [
    createCommand(configCommand, (context) => {
      const configPath = typeof context.flags.config === "string" ? context.flags.config : undefined;
      const result = loadAiuConfig(configPath ? { configPath } : {});
      const human = [
        `selectedPath: ${result.selectedPath}`,
        `found: ${String(result.found)}`,
        `valid: ${String(result.ok)}`,
        "",
        formatConfigDiagnostics(result.diagnostics),
      ].join("\n");

      return {
        human,
        json: {
          config: {
            selectedPath: result.selectedPath,
            repoRoot: result.repoRoot,
            found: result.found,
            defaultsUsed: result.defaultsUsed,
            valid: result.ok,
            value: result.config,
            diagnostics: result.diagnostics,
          },
        },
      };
    }),
    createCommand(doctorCommand, (context) => {
      const configPath = typeof context.flags.config === "string" ? context.flags.config : undefined;
      const report = runAiuDoctor(configPath ? { configPath } : {});
      return {
        human: formatAiuDoctorReport(report),
        json: {
          doctor: report,
        },
      };
    }),
    createCommand(statusCommand, async (context) => {
      const configPath = typeof context.flags.config === "string" ? context.flags.config : undefined;
      const report = await runAiuStatus(configPath ? { configPath } : {});
      return {
        human: formatAiuStatusReport(report),
        json: {
          status: report,
        },
      };
    }),
    createCommand(initCommand, (context) => {
      const tool = typeof context.flags.tool === "string" ? (context.flags.tool as AiuInitTool) : undefined;
      const dryRun = context.flags["dry-run"] === true;
      const force = context.flags.force === true;
      const plan = applyAiuInitPlan(planAiuInit({ tool, dryRun, force }));
      return {
        human: formatInitPlan(plan),
        json: {
          init: plan,
        },
      };
    }),
    createCommand(hookStopCommand, async (context) => {
      const tool = readHookStopTool(context.flags.tool);
      if (tool === undefined) {
        return {
          stderr: `Invalid --tool value: ${String(context.flags.tool)}\n`,
          exitCode: 2,
        };
      }
      const result = await runAiuHookStop({ tool, stdin: await readHookStopStdin() });
      if (context.flags.json === true) {
        return {
          json: {
            hookStop: {
              tool: result.tool,
              decision: result.decision,
              reason: result.reason,
              inputBytes: result.inputBytes,
              stdoutJson: result.stdoutJson,
              diagnostics: result.diagnostics,
            },
          },
          stderr: result.stderr,
        };
      }
      return {
        stdout: formatHookStopJson(result),
        stderr: result.stderr,
      };
    }),
    createCommand(migrateCommand, (context) => {
      const dryRun = context.flags["dry-run"] === true;
      const plan = planAiuMigration({ dryRun });
      return {
        human: formatMigrationPlan(plan),
        json: {
          migrate: plan,
        },
      };
    }),
    createCommand(whipCommand, (context) => {
      const configPath = typeof context.flags.config === "string" ? context.flags.config : undefined;
      const configLoad = loadAiuConfig(configPath ? { configPath } : {});
      const action = readWhipAction(context.args.action);
      if (!action) {
        return {
          stderr: `Invalid whip action: ${String(context.args.action)}\n`,
          exitCode: 2,
        };
      }
      const report = runAiuWhipCommand({
        action,
        repoRoot: configLoad.repoRoot,
        config: configLoad.config,
        dryRun: context.flags["dry-run"] === true,
        id: typeof context.flags.id === "string" ? context.flags.id : undefined,
        title: typeof context.flags.title === "string" ? context.flags.title : undefined,
        prompt: typeof context.flags.prompt === "string" ? context.flags.prompt : undefined,
        priority: typeof context.flags.priority === "number" ? context.flags.priority : undefined,
        reason: typeof context.flags.reason === "string" ? context.flags.reason : undefined,
        evidence: typeof context.flags.evidence === "string" ? context.flags.evidence : undefined,
      });
      return {
        human: formatAiuWhipReport(report),
        json: {
          whip: report,
        },
        exitCode: report.errors.length > 0 ? 1 : 0,
      };
    }),
    createCommand(pathsCommand, (context) => {
      const configPath = typeof context.flags.config === "string" ? context.flags.config : undefined;
      const paths = getAiuResolvedPaths(configPath ? { configPath } : {});
      return {
        human: formatAiuPaths(paths),
        json: {
          paths,
        },
      };
    }),
    createSchemaCommand({
      registry: () => runtimeRegistry,
      bin: "aiu",
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      sections: {
        config: {
          schemaVersion: AIU_CONFIG_SCHEMA_VERSION,
          defaultPath: AIU_CONFIG_FILENAME,
          defaultConfig: getDefaultAiuConfig(),
          hostNames: AIU_HOSTS,
          hostCapabilityNames: AIU_HOST_CAPABILITY_NAMES,
          hostSupportLevels: AIU_HOST_SUPPORT_LEVELS,
          hostCapabilitySupport: AIU_HOST_CAPABILITY_SUPPORT,
          hostProfiles: getAllAiuHostCapabilityProfiles(),
          policyFields: ["hosts.enabled", "hosts.capabilities", "hosts.modes", "hosts.stopHookBlocking", "continuation.modes", "quality.enabled", "cooldowns.promptMs", "paths.stateDir", "paths.lockDir", "paths.logDir"],
          promptSectionKinds: AIU_PROMPT_SECTION_KINDS,
        },
        trustedState: {
          schemaVersion: AIU_TRUSTED_STATE_SCHEMA_VERSION,
          stateKinds: AIU_TRUSTED_STATE_KINDS,
          stateValueKinds: AIU_STATE_VALUE_KINDS,
          trustLevels: AIU_TRUST_LEVELS,
          freshnessKinds: AIU_STATE_FRESHNESS_KINDS,
          capabilitySupport: AIU_STATE_CAPABILITY_SUPPORT,
          reasonCodes: AIU_REASON_CODE_CATALOG,
          adapterErrorCodes: AIU_TRUSTED_ADAPTER_ERROR_CODES,
        },
        decision: {
          promptKinds: AIU_DECISION_PROMPT_KINDS,
          modes: AIU_DECISION_MODES,
          reasonCodes: AIU_REASON_CODE_CATALOG,
        },
        hookStop: {
          commands: ["aiu hook-stop --tool codex", "aiu hook-stop --tool claude-code"],
          tools: ["codex", "claude-code"],
          outputKinds: ["allow", "block"],
          stdoutShapes: [
            { decision: "allow", json: {} },
            { decision: "block", json: { decision: "block", reason: "string" } },
          ],
          stableErrorKinds: [
            "empty-hook-input",
            "malformed-hook-input",
            "config-invalid",
            "host-not-enabled",
            "stop-hook-blocking-disabled",
            "stop-hook-capability-disabled",
            "prompt-delivery-disabled",
            "trusted-state-unavailable",
            "trusted-state-load-failed",
          ],
        },
        continuationState: {
          schemaVersion: 1,
          files: {
            state: "continuation.json",
            lock: "continuation.lock",
            log: "continuation.jsonl",
          },
          ownershipFields: [
            "ownerSessionId",
            "targetSessionId",
            "selectedItem",
            "mode",
            "decisionKind",
            "reasonCodes",
            "lastPromptFingerprint",
            "pendingPromptFingerprint",
            "lastPromptAt",
            "pendingPromptAt",
            "updatedAt",
            "sourceSummaries",
          ],
          lockFields: ["ownerId", "eventType", "sessionId", "acquiredAt"],
          logFields: ["event", "observedAt", "eventType", "hostId", "sessionId", "selectedSessionId", "decisionId", "decisionKind", "mode", "reasonCodes", "promptFingerprint", "targetSessionId", "sourceSummaries", "adapterErrors", "suppressions", "elapsedMs", "message"],
          rotation: {
            maxLogBytes: 65536,
            maxLogEntryBytes: 8192,
          },
        },
        promptRendering: {
          fingerprintInputs: ["decisionKind", "selectedItem", "reasonCodes", "sourceTimestamps", "body"],
          customizableSections: ["work", "planning", "quality", "whip"],
          metadataShape: ["kind", "decisionKind", "selectedItem", "reasonCodes", "sourceTimestamps", "body", "fingerprint"],
        },
        status: {
          outputShape: ["config", "inputEnvelopes", "adapterRuns", "normalizedStateSummary", "decision", "prompt", "paths", "continuationState", "reasonLabels", "staleSources", "unknownSources", "errors", "warnings"],
          errorCodes: AIU_STATUS_ERROR_CODES,
        },
        quality: {
          enabledDefault: getDefaultAiuConfig().quality.enabled,
          targetKinds: AIU_QUALITY_TARGET_KINDS,
          stateFields: ["ready", "lastRunStatus", "stages", "findings", "failingChecks", "affectedPaths", "nextCommand", "rerunCommand", "selectedTarget", "humanApprovalRequired", "supplyChainApprovalRequired"],
          stageFields: ["id", "title", "status", "affectedPaths", "command", "rerunCommand"],
          findingFields: ["id", "title", "stageId", "status", "severity", "affectedPaths", "command", "rerunCommand", "humanApprovalRequired", "supplyChainApprovalRequired"],
          selectedTargetFields: ["kind", "id", "title", "stageId", "status", "affectedPaths", "command", "rerunCommand", "expectedEvidence"],
          stopReasons: ["stop-supply-chain-approval", "stop-human-input-required", "stop-malformed-input", "stop-stale-input", "stop-unknown-input", "stop-unsupported-input", "stop-untrusted-input"],
        },
        whip: {
          commands: ["aiu whip list", "aiu whip status", "aiu whip add", "aiu whip cancel", "aiu whip complete"],
          stateSchemaVersion: AIU_WHIP_STATE_SCHEMA_VERSION,
          taskStatuses: AIU_WHIP_TASK_STATUSES,
          taskSources: AIU_WHIP_TASK_SOURCES,
          statePathDefault: getDefaultAiuConfig().whip.statePath,
          taskFields: ["id", "title", "prompt", "priority", "status", "createdAt", "updatedAt", "source", "ownerSessionId", "selectedSessionId", "promptFingerprint", "promptedAt", "completionEvidence", "completedAt", "cancellationReason", "cancelledAt"],
          errorCodes: AIU_WHIP_ERROR_CODES,
        },
        doctor: {
          checkCategories: ["node", "package", "repository", "config", "host", "state", "trusted-command"],
          stableDiagnosticKinds: [
            "node-version-supported",
            "node-version-unsupported",
            "package-json-present",
            "package-json-missing",
            "package-name-valid",
            "package-name-invalid",
            "package-version-present",
            "package-version-missing",
            "package-bin-present",
            "package-bin-missing",
            "package-main-present",
            "package-main-missing",
            "package-types-present",
            "package-types-missing",
            "repository-root-found",
            "repository-root-not-found",
            "config-present",
            "config-missing",
            "config-valid",
            "config-invalid",
            "status-runtime-fixture-free",
            "stale-state-policy-strict",
            "stale-state-policy-relaxed",
            "host-runtime-disabled",
            "host-file-managed",
            "host-file-missing",
            "host-file-unmanaged",
            "host-file-unreadable",
            "host-entrypoint-package-backed",
            "host-entrypoint-unmanaged",
            "host-entrypoint-unreadable",
            "host-mode-supported",
            "host-capability-disabled",
            "host-capability-experimental",
            "host-capability-unsupported",
            "host-stop-hook-blocking-unsafe",
            "state-path-writable",
            "state-path-creatable",
            "state-path-not-directory",
            "state-path-not-writable",
            "trusted-command-found",
            "trusted-command-missing",
            "trusted-command-compatible",
          ],
        },
      },
    }),
  ],
});

function readHookStopTool(value: unknown): "codex" | "claude-code" | undefined {
  return value === "codex" || value === "claude-code" ? value : undefined;
}

function readWhipAction(value: unknown): AiuWhipReport["action"] | undefined {
  return value === "list" || value === "status" || value === "add" || value === "cancel" || value === "complete" ? value : undefined;
}

runtimeRegistry = aiuCli.registry;

export async function runAiuCli(input: readonly string[]): Promise<number> {
  const result = await runCli(aiuCli, input);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}
