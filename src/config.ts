import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { evaluateAiuHostRuntimePolicy } from "./host_policy.js";

export const AIU_CONFIG_FILENAME = "aiu.config.json";
export const AIU_CONFIG_SCHEMA_VERSION = 1;
export const AIU_HOSTS = ["opencode", "codex", "claude-code"] as const;
export const AIU_HOST_CAPABILITY_NAMES = ["idleEvents", "stopHook", "todoRead", "sessionState", "promptDelivery", "selectedSession", "modelTargeting", "userActivity", "projectTrust"] as const;
export const AIU_CONTINUATION_MODES = ["continue", "repair", "wait", "stop"] as const;
export const AIU_PROMPT_SECTION_KINDS = ["work", "planning", "quality", "whip"] as const;

export type AiuHost = (typeof AIU_HOSTS)[number];
export type AiuHostCapabilityName = (typeof AIU_HOST_CAPABILITY_NAMES)[number];
export type AiuContinuationMode = (typeof AIU_CONTINUATION_MODES)[number];
export type AiuPromptSectionKind = (typeof AIU_PROMPT_SECTION_KINDS)[number];
export type AiuDiagnosticSeverity = "error" | "warning";

export interface AiuConfig {
  readonly version: typeof AIU_CONFIG_SCHEMA_VERSION;
  readonly hosts: AiuHostsConfig;
  readonly trustedStateCommands: Readonly<Record<string, AiuTrustedStateCommandDescriptor>>;
  readonly continuation: AiuContinuationPolicy;
  readonly timeouts: AiuTimeoutsConfig;
  readonly cooldowns: AiuCooldownsConfig;
  readonly paths: AiuPathsConfig;
  readonly supplyChain: AiuSupplyChainPolicy;
  readonly prompts: AiuPromptPolicy;
  readonly quality: AiuQualityPolicy;
  readonly whip: AiuWhipPolicy;
}

export interface AiuHostsConfig {
  readonly enabled: readonly AiuHost[];
  readonly capabilities: Readonly<Partial<Record<AiuHost, Readonly<Partial<Record<AiuHostCapabilityName, boolean | "none" | "stdout" | "host">>>>>>;
  readonly modes: Readonly<Partial<Record<AiuHost, readonly AiuContinuationMode[]>>>;
  readonly stopHookBlocking: Readonly<Partial<Record<AiuHost, boolean>>>;
}

export interface AiuTrustedStateCommandDescriptor {
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface AiuContinuationPolicy {
  readonly modes: readonly AiuContinuationMode[];
  readonly stopOnUnknownState: boolean;
  readonly stopOnUnsafeState: boolean;
  readonly stopOnSupplyChainApprovalBlock: boolean;
  readonly allowProviderMutation: boolean;
  readonly allowBackgroundScheduling: boolean;
  readonly trustUnstructuredProse: boolean;
}

export interface AiuTimeoutsConfig {
  readonly commandMs: number;
  readonly hostMs: number;
}

export interface AiuCooldownsConfig {
  readonly promptMs: number;
}

export interface AiuPathsConfig {
  readonly stateDir: string;
  readonly lockDir: string;
  readonly logDir: string;
}

export interface AiuSupplyChainPolicy {
  readonly stopOnApprovalRequired: boolean;
}

export interface AiuPromptPolicy {
  readonly sections: Readonly<Partial<Record<AiuPromptSectionKind, AiuPromptSectionCustomization>>>;
}

export interface AiuPromptSectionCustomization {
  readonly prepend: readonly string[];
  readonly append: readonly string[];
  readonly replacement?: string;
}

export interface AiuWhipPolicy {
  readonly enabled: boolean;
  readonly usePackageDefaults: boolean;
  readonly tasks: readonly AiuWhipTaskDefinition[];
  readonly statePath: string;
}

export interface AiuQualityPolicy {
  readonly enabled: boolean;
}

export interface AiuWhipTaskDefinition {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly priority: number;
}

export interface AiuConfigDiagnostic {
  readonly severity: AiuDiagnosticSeverity;
  readonly kind: string;
  readonly path: string;
  readonly message: string;
  readonly suggestedNextAction: string;
}

export interface LoadAiuConfigOptions {
  readonly cwd?: string;
  readonly configPath?: string;
}

export interface AiuConfigLoadResult {
  readonly ok: boolean;
  readonly repoRoot: string;
  readonly selectedPath: string;
  readonly found: boolean;
  readonly defaultsUsed: boolean;
  readonly config: AiuConfig;
  readonly diagnostics: readonly AiuConfigDiagnostic[];
}

const DEFAULT_CONFIG: AiuConfig = Object.freeze({
  version: AIU_CONFIG_SCHEMA_VERSION,
  hosts: Object.freeze({
    enabled: Object.freeze([]),
    capabilities: Object.freeze({}),
    modes: Object.freeze({}),
    stopHookBlocking: Object.freeze({}),
  }),
  trustedStateCommands: Object.freeze({}),
  continuation: Object.freeze({
    modes: Object.freeze(["continue", "repair", "wait", "stop"] satisfies AiuContinuationMode[]),
    stopOnUnknownState: true,
    stopOnUnsafeState: true,
    stopOnSupplyChainApprovalBlock: true,
    allowProviderMutation: false,
    allowBackgroundScheduling: false,
    trustUnstructuredProse: false,
  }),
  timeouts: Object.freeze({
    commandMs: 30_000,
    hostMs: 5_000,
  }),
  cooldowns: Object.freeze({
    promptMs: 600_000,
  }),
  paths: Object.freeze({
    stateDir: ".umpire/state",
    lockDir: ".umpire/locks",
    logDir: ".umpire/logs",
  }),
  supplyChain: Object.freeze({
    stopOnApprovalRequired: true,
  }),
  prompts: Object.freeze({
    sections: Object.freeze({}),
  }),
  quality: Object.freeze({
    enabled: true,
  }),
  whip: Object.freeze({
    enabled: true,
    usePackageDefaults: true,
    tasks: Object.freeze([]),
    statePath: ".umpire/whip.json",
  }),
});

export function getDefaultAiuConfig(): AiuConfig {
  return cloneConfig(DEFAULT_CONFIG);
}

export function loadAiuConfig(options: LoadAiuConfigOptions = {}): AiuConfigLoadResult {
  const repoRoot = findRepositoryRoot(path.resolve(options.cwd ?? process.cwd()));
  const selectedPath = options.configPath
    ? path.resolve(repoRoot, options.configPath)
    : path.join(repoRoot, AIU_CONFIG_FILENAME);
  const found = existsSync(selectedPath);
  const diagnostics: AiuConfigDiagnostic[] = [];
  let rawConfig: unknown = {};

  if (found) {
    try {
      rawConfig = JSON.parse(readFileSync(selectedPath, "utf8")) as unknown;
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "invalid-json",
          "$",
          `Could not parse ${AIU_CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
          "Fix the JSON syntax before running Umpire commands.",
        ),
      );
      rawConfig = {};
    }
  }

  const normalized = normalizeAiuConfig(rawConfig, repoRoot);
  diagnostics.push(...normalized.diagnostics);

  return Object.freeze({
    ok: diagnostics.every((item) => item.severity !== "error"),
    repoRoot,
    selectedPath,
    found,
    defaultsUsed: !found,
    config: normalized.config,
    diagnostics: Object.freeze(diagnostics),
  });
}

export function formatConfigDiagnostics(diagnostics: readonly AiuConfigDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "Config is valid.\n";
  }

  return `${diagnostics
    .map((item) => `${item.severity.toUpperCase()} ${item.kind} at ${item.path}: ${item.message}\nNext: ${item.suggestedNextAction}`)
    .join("\n\n")}\n`;
}

function normalizeAiuConfig(rawConfig: unknown, repoRoot: string): { readonly config: AiuConfig; readonly diagnostics: readonly AiuConfigDiagnostic[] } {
  const diagnostics: AiuConfigDiagnostic[] = [];
  const raw = isRecord(rawConfig) ? rawConfig : {};

  if (!isRecord(rawConfig)) {
    diagnostics.push(diagnostic("config-not-object", "$", "Config root must be a JSON object.", "Replace the file with an object that matches schema version 1."));
  }

  const version = normalizeVersion(raw.version, diagnostics);
  const hosts = normalizeHosts(raw.hosts, diagnostics);
  const trustedStateCommands = normalizeTrustedStateCommands(raw.trustedStateCommands, diagnostics);
  const continuation = normalizeContinuation(raw.continuation, diagnostics);
  const timeouts = normalizeTimeouts(raw.timeouts, diagnostics);
  const cooldowns = normalizeCooldowns(raw.cooldowns, diagnostics);
  const pathsConfig = normalizePaths(raw.paths, diagnostics);
  const supplyChain = normalizeSupplyChain(raw.supplyChain, diagnostics);
  const prompts = normalizePrompts(raw.prompts, diagnostics);
  const quality = normalizeQuality(raw.quality, diagnostics);
  const whip = normalizeWhip(raw.whip, diagnostics);

  validateNoLegacyFallback(raw, "$", diagnostics);
  if (isRecord(raw.continuation)) {
    validateNoLegacyFallback(raw.continuation, "$.continuation", diagnostics);
  }
  validatePolicy(continuation, supplyChain, diagnostics);
  validateHostRuntimePolicy(hosts, continuation, diagnostics);
  validateWritablePath("stateDir", pathsConfig.stateDir, repoRoot, diagnostics);
  validateWritablePath("lockDir", pathsConfig.lockDir, repoRoot, diagnostics);
  validateWritablePath("logDir", pathsConfig.logDir, repoRoot, diagnostics);
  if (whip.enabled) {
    validateWritableFilePath("whip.statePath", whip.statePath, repoRoot, "$.whip.statePath", diagnostics);
  }

  return {
    config: Object.freeze({
      version,
      hosts,
      trustedStateCommands,
      continuation,
      timeouts,
      cooldowns,
      paths: pathsConfig,
      supplyChain,
      prompts,
      quality,
      whip,
    }),
    diagnostics: Object.freeze(diagnostics),
  };
}

function normalizeVersion(value: unknown, diagnostics: AiuConfigDiagnostic[]): typeof AIU_CONFIG_SCHEMA_VERSION {
  if (value === undefined) {
    return AIU_CONFIG_SCHEMA_VERSION;
  }
  if (value !== AIU_CONFIG_SCHEMA_VERSION) {
    diagnostics.push(diagnostic("unsupported-config-version", "$.version", "Config version must be 1.", "Set version to 1 or migrate the config before using this package version."));
  }
  return AIU_CONFIG_SCHEMA_VERSION;
}

function normalizeHosts(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuHostsConfig {
  if (value === undefined) {
    return DEFAULT_CONFIG.hosts;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-hosts", "$.hosts", "hosts must be an object.", "Use { \"enabled\": [] } with supported host names."));
    return DEFAULT_CONFIG.hosts;
  }

  const enabled = normalizeStringArray(value.enabled, "$.hosts.enabled", "invalid-hosts", diagnostics)
    .filter((host): host is AiuHost => validateHost(host, "$.hosts.enabled", diagnostics));
  const capabilities = normalizeHostCapabilities(value.capabilities, diagnostics);
  const modes = normalizeHostModes(value.modes, diagnostics);
  const stopHookBlocking = normalizeHostStopHookBlocking(value.stopHookBlocking, diagnostics);
  return Object.freeze({
    enabled: Object.freeze([...new Set(enabled)]),
    capabilities,
    modes,
    stopHookBlocking,
  });
}

function normalizeHostCapabilities(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuHostsConfig["capabilities"] {
  if (value === undefined) {
    return DEFAULT_CONFIG.hosts.capabilities;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-host-capabilities", "$.hosts.capabilities", "host capabilities must be an object keyed by host.", "Use supported host names and capability names only."));
    return DEFAULT_CONFIG.hosts.capabilities;
  }

  const output: Partial<Record<AiuHost, Partial<Record<AiuHostCapabilityName, boolean | "none" | "stdout" | "host">>>> = {};
  for (const [host, capabilities] of Object.entries(value)) {
    if (!validateHost(host, "$.hosts.capabilities", diagnostics)) {
      continue;
    }
    if (!isRecord(capabilities)) {
      diagnostics.push(diagnostic("invalid-host-capabilities", `$.hosts.capabilities.${host}`, "host capability overrides must be objects.", "Use stopHook, sessionState, or promptDelivery overrides."));
      continue;
    }

    const normalized: Partial<Record<AiuHostCapabilityName, boolean | "none" | "stdout" | "host">> = {};
    for (const [capability, capabilityValue] of Object.entries(capabilities)) {
      if (!isHostCapability(capability)) {
        diagnostics.push(diagnostic("invalid-host-capability", `$.hosts.capabilities.${host}.${capability}`, `Unsupported host capability "${capability}".`, "Use stopHook, sessionState, or promptDelivery."));
        continue;
      }
      if (typeof capabilityValue !== "boolean" && capabilityValue !== "none" && capabilityValue !== "stdout" && capabilityValue !== "host") {
        diagnostics.push(diagnostic("invalid-host-capability", `$.hosts.capabilities.${host}.${capability}`, "Capability overrides must be boolean or one of none, stdout, host.", "Use a supported value for the capability override."));
        continue;
      }
      normalized[capability] = capabilityValue;
    }
    output[host] = Object.freeze(normalized);
  }

  return Object.freeze(output);
}

function normalizeHostModes(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuHostsConfig["modes"] {
  if (value === undefined) {
    return DEFAULT_CONFIG.hosts.modes;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-host-modes", "$.hosts.modes", "host modes must be an object keyed by host.", "Use supported host names with arrays of continue, repair, wait, or stop."));
    return DEFAULT_CONFIG.hosts.modes;
  }

  const output: Partial<Record<AiuHost, readonly AiuContinuationMode[]>> = {};
  for (const [host, modes] of Object.entries(value)) {
    if (!validateHost(host, "$.hosts.modes", diagnostics)) {
      continue;
    }
    const normalizedModes = normalizeStringArray(modes, `$.hosts.modes.${host}`, "unsupported-mode", diagnostics).filter((mode): mode is AiuContinuationMode => {
      if (isContinuationMode(mode)) {
        return true;
      }
      diagnostics.push(diagnostic("unsupported-mode", `$.hosts.modes.${host}`, `Unsupported continuation mode "${mode}".`, "Use continue, repair, wait, or stop."));
      return false;
    });
    output[host] = Object.freeze([...new Set(normalizedModes)]);
  }
  return Object.freeze(output);
}

function normalizeHostStopHookBlocking(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuHostsConfig["stopHookBlocking"] {
  if (value === undefined) {
    return DEFAULT_CONFIG.hosts.stopHookBlocking;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-stop-hook-blocking", "$.hosts.stopHookBlocking", "stopHookBlocking must be an object keyed by host.", "Use boolean values for supported host names."));
    return DEFAULT_CONFIG.hosts.stopHookBlocking;
  }

  const output: Partial<Record<AiuHost, boolean>> = {};
  for (const [host, enabled] of Object.entries(value)) {
    if (!validateHost(host, "$.hosts.stopHookBlocking", diagnostics)) {
      continue;
    }
    output[host] = normalizeBoolean(enabled, false, `$.hosts.stopHookBlocking.${host}`, diagnostics);
  }
  return Object.freeze(output);
}

function normalizeTrustedStateCommands(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuConfig["trustedStateCommands"] {
  if (value === undefined) {
    return DEFAULT_CONFIG.trustedStateCommands;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-trusted-commands", "$.trustedStateCommands", "trustedStateCommands must be an object keyed by source id.", "Configure each trusted state source as an argv descriptor."));
    return DEFAULT_CONFIG.trustedStateCommands;
  }

  const commands: Record<string, AiuTrustedStateCommandDescriptor> = {};
  for (const [sourceId, descriptor] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/i.test(sourceId)) {
      diagnostics.push(diagnostic("invalid-command-source", `$.trustedStateCommands.${sourceId}`, "Trusted command source ids must be simple stable identifiers.", "Use letters, digits, and dashes, starting with a letter."));
      continue;
    }
    const normalized = normalizeCommandDescriptor(sourceId, descriptor, diagnostics);
    if (normalized) {
      commands[sourceId] = normalized;
    }
  }
  return Object.freeze(commands);
}

function normalizeCommandDescriptor(sourceId: string, value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuTrustedStateCommandDescriptor | undefined {
  const basePath = `$.trustedStateCommands.${sourceId}`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-command-descriptor", basePath, "Trusted command descriptors must be objects.", "Use an argv array descriptor such as { \"argv\": [\"tool\", \"status\", \"--json\"] }."));
    return undefined;
  }
  if ("shell" in value || typeof value.command === "string" || typeof value.argv === "string") {
    diagnostics.push(diagnostic("unsafe-command-descriptor", basePath, "Trusted commands must not be shell strings.", "Represent commands as argv arrays so no shell synthesis is required."));
    return undefined;
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((item) => typeof item === "string")) {
    diagnostics.push(diagnostic("missing-command-path", `${basePath}.argv`, "Trusted commands require a non-empty argv string array.", "Set argv to the executable plus fixed arguments."));
    return undefined;
  }

  const [executable, ...args] = value.argv;
  if (!isSafeExecutableToken(executable)) {
    diagnostics.push(diagnostic("unsafe-command-descriptor", `${basePath}.argv[0]`, "The executable token must be a single non-empty command or path.", "Put arguments in later argv entries, not in the executable token."));
    return undefined;
  }
  const unsafeArgIndex = args.findIndex((item) => item.length === 0 || item.includes("\0"));
  if (unsafeArgIndex !== -1) {
    diagnostics.push(diagnostic("unsafe-command-descriptor", `${basePath}.argv[${unsafeArgIndex + 1}]`, "argv entries must be non-empty strings without NUL bytes.", "Remove empty or unsafe argv entries."));
    return undefined;
  }

  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 && !value.cwd.includes("\0") ? value.cwd : undefined;
  const timeoutMs = typeof value.timeoutMs === "number" && isPositiveInteger(value.timeoutMs) ? value.timeoutMs : undefined;
  const maxOutputBytes = typeof value.maxOutputBytes === "number" && isPositiveInteger(value.maxOutputBytes) ? value.maxOutputBytes : undefined;

  if (value.cwd !== undefined && cwd === undefined) {
    diagnostics.push(diagnostic("invalid-command-cwd", `${basePath}.cwd`, "Command cwd must be a non-empty string without NUL bytes.", "Use a safe repository-relative or absolute cwd path."));
  }
  validateDuration(value.timeoutMs, `${basePath}.timeoutMs`, "invalid-duration", diagnostics);
  validatePositiveInteger(value.maxOutputBytes, `${basePath}.maxOutputBytes`, "invalid-output-limit", "Output limits must be positive integer byte counts.", diagnostics);

  const output: AiuTrustedStateCommandDescriptor = {
    argv: Object.freeze([executable, ...args]) as readonly [string, ...string[]],
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  };

  return Object.freeze(output);
}

function normalizeContinuation(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuContinuationPolicy {
  if (value === undefined) {
    return DEFAULT_CONFIG.continuation;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-continuation-policy", "$.continuation", "continuation must be an object.", "Use supported continuation policy fields."));
    return DEFAULT_CONFIG.continuation;
  }

  const modes = normalizeStringArray(value.modes, "$.continuation.modes", "unsupported-mode", diagnostics)
    .filter((mode): mode is AiuContinuationMode => {
      if (isContinuationMode(mode)) {
        return true;
      }
      diagnostics.push(diagnostic("unsupported-mode", "$.continuation.modes", `Unsupported continuation mode "${mode}".`, "Use continue, repair, wait, or stop."));
      return false;
    });

  return Object.freeze({
    modes: Object.freeze(modes.length > 0 ? [...new Set(modes)] : [...DEFAULT_CONFIG.continuation.modes]),
    stopOnUnknownState: normalizeBoolean(value.stopOnUnknownState, DEFAULT_CONFIG.continuation.stopOnUnknownState, "$.continuation.stopOnUnknownState", diagnostics),
    stopOnUnsafeState: normalizeBoolean(value.stopOnUnsafeState, DEFAULT_CONFIG.continuation.stopOnUnsafeState, "$.continuation.stopOnUnsafeState", diagnostics),
    stopOnSupplyChainApprovalBlock: normalizeBoolean(value.stopOnSupplyChainApprovalBlock, DEFAULT_CONFIG.continuation.stopOnSupplyChainApprovalBlock, "$.continuation.stopOnSupplyChainApprovalBlock", diagnostics),
    allowProviderMutation: normalizeBoolean(value.allowProviderMutation, DEFAULT_CONFIG.continuation.allowProviderMutation, "$.continuation.allowProviderMutation", diagnostics),
    allowBackgroundScheduling: normalizeBoolean(value.allowBackgroundScheduling, DEFAULT_CONFIG.continuation.allowBackgroundScheduling, "$.continuation.allowBackgroundScheduling", diagnostics),
    trustUnstructuredProse: normalizeBoolean(value.trustUnstructuredProse, DEFAULT_CONFIG.continuation.trustUnstructuredProse, "$.continuation.trustUnstructuredProse", diagnostics),
  });
}

function normalizeTimeouts(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuTimeoutsConfig {
  if (value === undefined || !isRecord(value)) {
    if (value !== undefined) {
      diagnostics.push(diagnostic("invalid-timeouts", "$.timeouts", "timeouts must be an object.", "Use positive integer millisecond timeout values."));
    }
    return DEFAULT_CONFIG.timeouts;
  }
  const commandMs = normalizeDuration(value.commandMs, DEFAULT_CONFIG.timeouts.commandMs, "$.timeouts.commandMs", diagnostics);
  const hostMs = normalizeDuration(value.hostMs, DEFAULT_CONFIG.timeouts.hostMs, "$.timeouts.hostMs", diagnostics);
  return Object.freeze({ commandMs, hostMs });
}

function normalizeCooldowns(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuCooldownsConfig {
  if (value === undefined || !isRecord(value)) {
    if (value !== undefined) {
      diagnostics.push(diagnostic("invalid-cooldowns", "$.cooldowns", "cooldowns must be an object.", "Use positive integer millisecond cooldown values."));
    }
    return DEFAULT_CONFIG.cooldowns;
  }
  return Object.freeze({
    promptMs: normalizeDuration(value.promptMs, DEFAULT_CONFIG.cooldowns.promptMs, "$.cooldowns.promptMs", diagnostics),
  });
}

function normalizePaths(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuPathsConfig {
  if (value === undefined || !isRecord(value)) {
    if (value !== undefined) {
      diagnostics.push(diagnostic("invalid-paths", "$.paths", "paths must be an object.", "Use stateDir, lockDir, and logDir string paths."));
    }
    return DEFAULT_CONFIG.paths;
  }

  return Object.freeze({
    stateDir: normalizePathValue(value.stateDir, DEFAULT_CONFIG.paths.stateDir, "$.paths.stateDir", diagnostics),
    lockDir: normalizePathValue(value.lockDir, DEFAULT_CONFIG.paths.lockDir, "$.paths.lockDir", diagnostics),
    logDir: normalizePathValue(value.logDir, DEFAULT_CONFIG.paths.logDir, "$.paths.logDir", diagnostics),
  });
}

function normalizeSupplyChain(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuSupplyChainPolicy {
  if (value === undefined || !isRecord(value)) {
    if (value !== undefined) {
      diagnostics.push(diagnostic("invalid-supply-chain-policy", "$.supplyChain", "supplyChain must be an object.", "Use supported supply-chain policy fields."));
    }
    return DEFAULT_CONFIG.supplyChain;
  }
  return Object.freeze({
    stopOnApprovalRequired: normalizeBoolean(value.stopOnApprovalRequired, DEFAULT_CONFIG.supplyChain.stopOnApprovalRequired, "$.supplyChain.stopOnApprovalRequired", diagnostics),
  });
}

function normalizePrompts(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuPromptPolicy {
  if (value === undefined) {
    return DEFAULT_CONFIG.prompts;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-prompts", "$.prompts", "prompts must be an object.", "Use { \"sections\": { ... } } with supported prompt section names."));
    return DEFAULT_CONFIG.prompts;
  }
  const sections = normalizePromptSections(value.sections, diagnostics);
  return Object.freeze({
    sections: Object.freeze(sections),
  });
}

function normalizePromptSections(value: unknown, diagnostics: AiuConfigDiagnostic[]): Partial<Record<AiuPromptSectionKind, AiuPromptSectionCustomization>> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-prompt-sections", "$.prompts.sections", "prompts.sections must be an object.", "Use work, planning, quality, or whip section customization objects."));
    return {};
  }

  const sections: Partial<Record<AiuPromptSectionKind, AiuPromptSectionCustomization>> = {};
  for (const [kind, section] of Object.entries(value)) {
    const fieldPath = `$.prompts.sections.${kind}`;
    if (!isPromptSectionKind(kind)) {
      diagnostics.push(diagnostic("invalid-prompt-section-kind", fieldPath, `Unsupported prompt section "${kind}".`, "Use work, planning, quality, or whip."));
      continue;
    }
    const normalized = normalizePromptSection(section, fieldPath, diagnostics);
    if (normalized !== undefined) {
      sections[kind] = normalized;
    }
  }
  return sections;
}

function normalizePromptSection(value: unknown, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): AiuPromptSectionCustomization | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-prompt-section", fieldPath, "Prompt section customizations must be objects.", "Use prepend, append, and optional replacement string fields."));
    return undefined;
  }
  const prepend = normalizePromptTextList(value.prepend, `${fieldPath}.prepend`, diagnostics);
  const append = normalizePromptTextList(value.append, `${fieldPath}.append`, diagnostics);
  const replacement = normalizeOptionalPromptText(value.replacement, `${fieldPath}.replacement`, diagnostics);
  return Object.freeze({
    prepend: Object.freeze(prepend),
    append: Object.freeze(append),
    ...(replacement !== undefined ? { replacement } : {}),
  });
}

function normalizePromptTextList(value: unknown, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic("invalid-prompt-text-list", fieldPath, "Prompt additions must be string arrays.", "Use an array of non-empty prompt section strings."));
    return [];
  }
  const output: string[] = [];
  value.forEach((item, index) => {
    const normalized = normalizeOptionalPromptText(item, `${fieldPath}[${index}]`, diagnostics);
    if (normalized !== undefined) {
      output.push(normalized);
    }
  });
  return output;
}

function normalizeOptionalPromptText(value: unknown, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    diagnostics.push(diagnostic("invalid-prompt-text", fieldPath, "Prompt text must be a non-empty string without NUL bytes.", "Use concrete repository-owned prompt text."));
    return undefined;
  }
  return value.trim();
}

function normalizeQuality(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuQualityPolicy {
  if (value === undefined) {
    return DEFAULT_CONFIG.quality;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-quality-policy", "$.quality", "quality must be an object.", "Use { \"enabled\": false } to disable quality idle continuation."));
    return DEFAULT_CONFIG.quality;
  }
  return Object.freeze({
    enabled: normalizeBoolean(value.enabled, DEFAULT_CONFIG.quality.enabled, "$.quality.enabled", diagnostics),
  });
}

function normalizeWhip(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuWhipPolicy {
  if (value === undefined) {
    return DEFAULT_CONFIG.whip;
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-whip-policy", "$.whip", "whip must be an object.", "Use { \"enabled\": false } or configure concrete whip tasks."));
    return DEFAULT_CONFIG.whip;
  }
  const enabled = normalizeBoolean(value.enabled, DEFAULT_CONFIG.whip.enabled, "$.whip.enabled", diagnostics);

  return Object.freeze({
    enabled,
    usePackageDefaults: normalizeBoolean(value.usePackageDefaults, DEFAULT_CONFIG.whip.usePackageDefaults, "$.whip.usePackageDefaults", diagnostics),
    tasks: Object.freeze(normalizeWhipTasks(value.tasks, diagnostics)),
    statePath: enabled ? normalizePathValue(value.statePath, DEFAULT_CONFIG.whip.statePath, "$.whip.statePath", diagnostics) : normalizeDisabledWhipStatePath(value.statePath),
  });
}

function normalizeDisabledWhipStatePath(value: unknown): string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") ? value : DEFAULT_CONFIG.whip.statePath;
}

function normalizeWhipTasks(value: unknown, diagnostics: AiuConfigDiagnostic[]): AiuWhipTaskDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic("invalid-whip-tasks", "$.whip.tasks", "whip.tasks must be an array.", "Use concrete task objects with id, title, prompt, and optional priority."));
    return [];
  }

  const tasks: AiuWhipTaskDefinition[] = [];
  for (const [index, task] of value.entries()) {
    const fieldPath = `$.whip.tasks[${index}]`;
    if (!isRecord(task)) {
      diagnostics.push(diagnostic("invalid-whip-task", fieldPath, "Whip tasks must be objects.", "Use { \"id\": \"...\", \"title\": \"...\", \"prompt\": \"...\" }."));
      continue;
    }
    const id = normalizeWhipTaskString(task.id, `${fieldPath}.id`, "invalid-whip-task-id", /^[a-z][a-z0-9-]*$/i, diagnostics);
    const title = normalizeWhipTaskString(task.title, `${fieldPath}.title`, "invalid-whip-task-title", /[\S]/, diagnostics);
    const prompt = normalizeWhipTaskString(task.prompt, `${fieldPath}.prompt`, "invalid-whip-task-prompt", /[\S]/, diagnostics);
    const priority = task.priority === undefined ? 100 : normalizeWhipTaskPriority(task.priority, `${fieldPath}.priority`, diagnostics);
    if (id && title && prompt && priority !== undefined) {
      tasks.push(Object.freeze({ id, title, prompt, priority }));
    }
  }

  return [...new Map(tasks.map((task) => [task.id, task])).values()];
}

function normalizeWhipTaskString(value: unknown, fieldPath: string, kind: string, pattern: RegExp, diagnostics: AiuConfigDiagnostic[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || !pattern.test(value)) {
    diagnostics.push(diagnostic(kind, fieldPath, "Whip task fields must be non-empty safe strings.", "Use a stable id and concrete title/prompt text."));
    return undefined;
  }
  return value.trim();
}

function normalizeWhipTaskPriority(value: unknown, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    diagnostics.push(diagnostic("invalid-whip-task-priority", fieldPath, "Whip task priority must be a non-negative integer.", "Use a non-negative integer priority."));
    return undefined;
  }
  return value;
}

function validatePolicy(continuation: AiuContinuationPolicy, supplyChain: AiuSupplyChainPolicy, diagnostics: AiuConfigDiagnostic[]): void {
  if (!continuation.modes.includes("stop")) {
    diagnostics.push(diagnostic("contradictory-policy", "$.continuation.modes", "Continuation modes must include stop so safety blocks have a terminal outcome.", "Add stop to continuation.modes."));
  }
  if (continuation.stopOnSupplyChainApprovalBlock !== supplyChain.stopOnApprovalRequired) {
    diagnostics.push(diagnostic("contradictory-policy", "$.supplyChain.stopOnApprovalRequired", "Supply-chain approval block policy conflicts with continuation policy.", "Keep both supply-chain approval stop settings aligned."));
  }
  if (continuation.allowBackgroundScheduling) {
    diagnostics.push(diagnostic("unsafe-policy", "$.continuation.allowBackgroundScheduling", "Background scheduling is not supported by the config foundation.", "Set allowBackgroundScheduling to false."));
  }
  if (continuation.trustUnstructuredProse) {
    diagnostics.push(diagnostic("unsafe-policy", "$.continuation.trustUnstructuredProse", "Unstructured prose must not be trusted as continuation authority.", "Set trustUnstructuredProse to false and use trusted structured state commands."));
  }
}

function validateHostRuntimePolicy(hosts: AiuHostsConfig, continuation: AiuContinuationPolicy, diagnostics: AiuConfigDiagnostic[]): void {
  const report = evaluateAiuHostRuntimePolicy(hosts, continuation.modes);
  for (const item of report.errors) {
    diagnostics.push(diagnostic(item.kind, `$.hosts.modes.${item.host}`, item.message, item.suggestedNextAction));
  }
  for (const item of report.warnings) {
    diagnostics.push(diagnostic(item.kind, `$.hosts.modes.${item.host}`, item.message, item.suggestedNextAction, "warning"));
  }
  for (const [host, blocking] of Object.entries(hosts.stopHookBlocking) as Array<[AiuHost, boolean]>) {
    const profile = report.profiles.find((item) => item.tool === host);
    if (blocking && !hosts.enabled.includes(host)) {
      diagnostics.push(diagnostic("host-stop-hook-blocking-unsafe", `$.hosts.stopHookBlocking.${host}`, `${host} stop-hook blocking requires the host to be enabled.`, `Add ${host} to hosts.enabled or set hosts.stopHookBlocking.${host} to false.`));
    } else if (blocking && profile?.stopHook.blocksByDefault !== true) {
      diagnostics.push(diagnostic("host-stop-hook-blocking-unsafe", `$.hosts.stopHookBlocking.${host}`, `${host} stop-hook blocking is not supported by the current runtime profile.`, `Set hosts.stopHookBlocking.${host} to false until the host profile supports blocking.`));
    }
  }
}

function validateNoLegacyFallback(value: Record<string, unknown>, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): void {
  for (const key of ["legacyHelperMode", "runtimeFallback", "fallbackCli", "legacyFallback"]) {
    if (key in value) {
      diagnostics.push(diagnostic("legacy-fallback-unsupported", `${fieldPath}.${key}`, "Runtime fallback and legacy helper modes are not supported.", "Remove fallback settings and configure package-backed trusted commands instead."));
    }
  }
}

function normalizeStringArray(value: unknown, fieldPath: string, kind: string, diagnostics: AiuConfigDiagnostic[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    diagnostics.push(diagnostic(kind, fieldPath, "Expected an array of strings.", "Replace the value with a string array."));
    return [];
  }
  return value;
}

function normalizeBoolean(value: unknown, defaultValue: boolean, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    diagnostics.push(diagnostic("invalid-boolean", fieldPath, "Expected a boolean value.", "Use true or false."));
    return defaultValue;
  }
  return value;
}

function normalizeDuration(value: unknown, defaultValue: number, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!isPositiveInteger(value)) {
    diagnostics.push(diagnostic("invalid-duration", fieldPath, "Durations must be positive integer millisecond values.", "Use a positive integer number of milliseconds."));
    return defaultValue;
  }
  return value;
}

function validateDuration(value: unknown, fieldPath: string, kind: string, diagnostics: AiuConfigDiagnostic[]): void {
  if (value !== undefined && !isPositiveInteger(value)) {
    diagnostics.push(diagnostic(kind, fieldPath, "Durations must be positive integer millisecond values.", "Use a positive integer number of milliseconds."));
  }
}

function validatePositiveInteger(value: unknown, fieldPath: string, kind: string, message: string, diagnostics: AiuConfigDiagnostic[]): void {
  if (value !== undefined && !isPositiveInteger(value)) {
    diagnostics.push(diagnostic(kind, fieldPath, message, "Use a positive integer."));
  }
}

function normalizePathValue(value: unknown, defaultValue: string, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): string {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    diagnostics.push(diagnostic("invalid-path", fieldPath, "Paths must be non-empty strings without NUL bytes.", "Use a safe repository-relative or absolute path."));
    return defaultValue;
  }
  return value;
}

function validateWritablePath(name: keyof AiuPathsConfig, configuredPath: string, repoRoot: string, diagnostics: AiuConfigDiagnostic[]): void {
  const resolved = path.resolve(repoRoot, configuredPath);
  try {
    if (existsSync(resolved)) {
      const stat = statSync(resolved);
      if (!stat.isDirectory()) {
        diagnostics.push(diagnostic("path-not-directory", `$.paths.${name}`, `${name} resolves to a file, not a directory.`, "Choose a directory path for Umpire state."));
        return;
      }
      accessSync(resolved, constants.W_OK | constants.X_OK);
      return;
    }

    accessSync(findExistingDirectoryAncestor(resolved), constants.W_OK | constants.X_OK);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "path-not-writable",
        `$.paths.${name}`,
        `${name} is not writable or cannot be created: ${error instanceof Error ? error.message : String(error)}`,
        "Choose a writable repository-local path or fix directory permissions.",
      ),
    );
  }
}

function validateWritableFilePath(name: string, configuredPath: string, repoRoot: string, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): void {
  const resolved = path.resolve(repoRoot, configuredPath);
  try {
    if (existsSync(resolved)) {
      const stat = statSync(resolved);
      if (stat.isDirectory()) {
        diagnostics.push(diagnostic("path-not-writable", fieldPath, `${name} resolves to a directory, not a file.`, "Choose a writable file path for Umpire state."));
        return;
      }
      accessSync(resolved, constants.W_OK);
      return;
    }

    accessSync(findExistingDirectoryAncestor(path.dirname(resolved)), constants.W_OK | constants.X_OK);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "path-not-writable",
        fieldPath,
        `${name} is not writable or cannot be created: ${error instanceof Error ? error.message : String(error)}`,
        "Choose a writable repository-local file path or fix directory permissions.",
      ),
    );
  }
}

function findExistingDirectoryAncestor(targetPath: string): string {
  let current = targetPath;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return parent;
    }
    current = parent;
  }
  const stat = statSync(current);
  if (!stat.isDirectory()) {
    throw new Error(`Existing ancestor is not a directory: ${current}`);
  }
  return current;
}

function findRepositoryRoot(startDir: string): string {
  let current = startDir;
  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

function validateHost(value: string, fieldPath: string, diagnostics: AiuConfigDiagnostic[]): value is AiuHost {
  if (isHost(value)) {
    return true;
  }
  diagnostics.push(diagnostic("invalid-host", fieldPath, `Unsupported host "${value}".`, "Use opencode, codex, or claude-code."));
  return false;
}

function isSafeExecutableToken(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && !/\s/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHost(value: string): value is AiuHost {
  return (AIU_HOSTS as readonly string[]).includes(value);
}

function isHostCapability(value: string): value is AiuHostCapabilityName {
  return (AIU_HOST_CAPABILITY_NAMES as readonly string[]).includes(value);
}

function isContinuationMode(value: string): value is AiuContinuationMode {
  return (AIU_CONTINUATION_MODES as readonly string[]).includes(value);
}

function isPromptSectionKind(value: string): value is AiuPromptSectionKind {
  return (AIU_PROMPT_SECTION_KINDS as readonly string[]).includes(value);
}

function cloneConfig(config: AiuConfig): AiuConfig {
  return Object.freeze({
    version: config.version,
    hosts: Object.freeze({
      enabled: Object.freeze([...config.hosts.enabled]),
      capabilities: Object.freeze({ ...config.hosts.capabilities }),
      modes: Object.freeze(Object.fromEntries(Object.entries(config.hosts.modes).map(([host, modes]) => [host, Object.freeze([...(modes ?? [])])]))) as AiuHostsConfig["modes"],
      stopHookBlocking: Object.freeze({ ...config.hosts.stopHookBlocking }),
    }),
    trustedStateCommands: Object.freeze({ ...config.trustedStateCommands }),
    continuation: Object.freeze({
      ...config.continuation,
      modes: Object.freeze([...config.continuation.modes]),
    }),
    timeouts: Object.freeze({ ...config.timeouts }),
    cooldowns: Object.freeze({ ...config.cooldowns }),
    paths: Object.freeze({ ...config.paths }),
    supplyChain: Object.freeze({ ...config.supplyChain }),
    quality: Object.freeze({ ...config.quality }),
    prompts: Object.freeze({
      sections: Object.freeze(
        Object.fromEntries(
          Object.entries(config.prompts.sections).map(([kind, section]) => [
            kind,
            Object.freeze({
              prepend: Object.freeze([...(section?.prepend ?? [])]),
              append: Object.freeze([...(section?.append ?? [])]),
              ...(section?.replacement !== undefined ? { replacement: section.replacement } : {}),
            }),
          ]),
        ),
      ),
    }),
    whip: Object.freeze({
      ...config.whip,
      tasks: Object.freeze(config.whip.tasks.map((task) => Object.freeze({ ...task }))),
    }),
  });
}

function diagnostic(kind: string, fieldPath: string, message: string, suggestedNextAction: string, severity: AiuDiagnosticSeverity = "error"): AiuConfigDiagnostic {
  return Object.freeze({
    severity,
    kind,
    path: fieldPath,
    message,
    suggestedNextAction,
  });
}
