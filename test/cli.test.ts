import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const aiuBin = path.join(repoRoot, "dist/src/bin/aiu.js");

describe("metadata-backed CLI", () => {
  it("renders root help from command metadata", async () => {
    const result = await runCli([]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /aiu/);
    assert.match(result.stdout, /Commands:/);
    assert.match(result.stdout, /paths/);
    assert.match(result.stdout, /schema/);
    assert.equal(result.stderr, "");
  });

  it("supports standard non-mutating help forms", async () => {
    const forms = [
      ["--help"],
      ["help", "paths"],
      ["paths", "help"],
      ["paths", "--help"],
      ["help", "schema"],
      ["schema", "help"],
      ["help", "status"],
      ["status", "--help"],
    ];

    for (const form of forms) {
      const result = await runCli(form);

      assert.equal(result.exitCode, 0, form.join(" "));
      assert.match(result.stdout, /Usage:/, form.join(" "));
      assert.equal(result.stderr, "", form.join(" "));
    }
  });

  it("emits clean JSON for paths", async () => {
    const result = await runCli(["paths", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      paths: {
        packageRoot: string;
        pluginWrapperRelativePath: string;
        config: { selectedPath: string; found: boolean };
        state: { stateDir: string; lockDir: string; logDir: string };
        hosts: Array<{ host: string; files: Array<{ absolutePath: string }> }>;
        trustedCommands: unknown[];
      };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "paths");
    assert.equal(typeof parsed.paths.packageRoot, "string");
    assert.equal(parsed.paths.pluginWrapperRelativePath, ".opencode/plugins/ai-umpire-continuation.ts");
    assert.equal(parsed.paths.config.found, false);
    assert.equal(typeof parsed.paths.state.stateDir, "string");
    assert.ok(parsed.paths.hosts.some((host) => host.host === "opencode"));
    assert.deepEqual(parsed.paths.trustedCommands, []);
  });

  it("emits clean JSON for doctor diagnostics", async () => {
    const result = await runCli(["doctor", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      doctor: {
        status: "ok" | "warning" | "error";
        config: { found: boolean; valid: boolean };
        checks: Array<{ status: string; kind: string }>;
      };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "doctor");
    assert.equal(parsed.doctor.config.found, false);
    assert.equal(parsed.doctor.config.valid, true);
    assert.ok(parsed.doctor.checks.some((check) => check.kind === "config-missing"));
  });

  it("emits implemented command schema as clean JSON", async () => {
    const result = await runCli(["schema", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      bin: string;
      commands: Array<{
        name: string;
        flags?: Array<{ name: string; type: string }>;
        examples?: Array<{ command: string }>;
        output?: { formats?: string[]; defaultFormat?: string };
        interactions?: {
          json?: boolean;
          noColor?: boolean;
          nonInteractive?: boolean;
          ttyPrompt?: boolean;
        };
        dryRun?: { supported?: boolean; reason?: string };
        mutation?: { mutates?: boolean };
        errors?: Array<{ kind: string }>;
        exitCodes?: Array<{ code: number }>;
      }>;
      sections?: {
        config?: {
          schemaVersion?: number;
          defaultPath?: string;
          hostNames?: string[];
          hostCapabilityNames?: string[];
          hostSupportLevels?: string[];
          hostCapabilitySupport?: string[];
          hostProfiles?: Array<{ tool: string; supportLevel: string; stopHook?: { support?: string; blocksByDefault?: boolean } }>;
          policyFields?: string[];
          promptSectionKinds?: string[];
        };
        trustedState?: {
          schemaVersion?: number;
          stateKinds?: string[];
          stateValueKinds?: string[];
          trustLevels?: string[];
          freshnessKinds?: string[];
          capabilitySupport?: string[];
          adapterErrorCodes?: string[];
          reasonCodes?: Array<{ code: string; category: string; decision: string; description: string }>;
        };
        decision?: {
          promptKinds?: string[];
          modes?: string[];
        };
        promptRendering?: {
          fingerprintInputs?: string[];
          customizableSections?: string[];
          metadataShape?: string[];
        };
        status?: {
          outputShape?: string[];
          errorCodes?: string[];
        };
      };
      package: { name: string };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.bin, "aiu");
    assert.equal(parsed.package.name, "@tjalve/aiu");

    const commandNames = parsed.commands.map((command) => command.name);
    assert.deepEqual(commandNames, ["config", "doctor", "hook-stop", "init", "migrate", "paths", "schema", "status"]);

    const config = parsed.commands.find((command) => command.name === "config");
    assert.ok(config);
    assert.deepEqual(config.output?.formats, ["human", "json"]);
    assert.equal(config.output?.defaultFormat, "human");
    assert.equal(config.interactions?.json, true);
    assert.equal(config.dryRun?.supported, false);
    assert.equal(config.mutation?.mutates, false);
    assert.ok(config.flags?.some((flag) => flag.name === "json" && flag.type === "boolean"));
    assert.ok(config.flags?.some((flag) => flag.name === "config" && flag.type === "string"));
    assert.ok(config.errors?.some((error) => error.kind === "unsafe-command-descriptor"));
    assert.equal(parsed.sections?.config?.schemaVersion, 1);
    assert.equal(parsed.sections?.config?.defaultPath, "aiu.config.json");
    assert.deepEqual(parsed.sections?.config?.hostNames, ["opencode", "codex", "claude-code"]);
    assert.deepEqual(parsed.sections?.config?.hostCapabilityNames, ["idleEvents", "stopHook", "todoRead", "sessionState", "promptDelivery", "selectedSession", "modelTargeting", "userActivity", "projectTrust"]);
    assert.deepEqual(parsed.sections?.config?.hostSupportLevels, ["supported", "experimental", "recipe-only", "unsupported"]);
    assert.deepEqual(parsed.sections?.config?.hostCapabilitySupport, ["supported", "experimental", "disabled", "unsupported", "unknown"]);
    assert.deepEqual(parsed.sections?.config?.hostProfiles?.map((profile) => profile.tool), ["opencode", "codex", "claude-code"]);
    assert.deepEqual(parsed.sections?.config?.hostProfiles?.map((profile) => profile.supportLevel), ["supported", "experimental", "experimental"]);
    assert.equal(parsed.sections?.config?.hostProfiles?.find((profile) => profile.tool === "codex")?.stopHook?.blocksByDefault, false);
    assert.ok(parsed.sections?.config?.policyFields?.includes("hosts.stopHookBlocking"));
    assert.deepEqual(parsed.sections?.config?.promptSectionKinds, ["work", "planning", "quality", "whip"]);
    assert.equal(parsed.sections?.trustedState?.schemaVersion, 1);
    assert.deepEqual(parsed.sections?.trustedState?.stateKinds, [
      "work-queue",
      "work-item",
      "review",
      "repository",
      "gate-evidence",
      "planning",
      "quality",
      "host-session",
      "continuation-policy",
    ]);
    assert.deepEqual(parsed.sections?.trustedState?.stateValueKinds, ["pass", "fail", "missing", "stale", "unknown", "unsupported", "untrusted", "malformed"]);
    assert.deepEqual(parsed.sections?.trustedState?.trustLevels, ["trusted", "advisory", "untrusted"]);
    assert.deepEqual(parsed.sections?.trustedState?.freshnessKinds, ["fresh", "stale", "unknown"]);
    assert.deepEqual(parsed.sections?.trustedState?.capabilitySupport, ["supported", "unsupported", "unknown"]);
    assert.ok(parsed.sections?.trustedState?.adapterErrorCodes?.includes("trusted-command-malformed-json"));
    assert.ok(parsed.sections?.trustedState?.adapterErrorCodes?.includes("trusted-command-timeout"));
    assert.ok(parsed.sections?.trustedState?.reasonCodes?.some((reason) => reason.code === "continue-active-work" && reason.decision === "continue"));
    assert.ok(parsed.sections?.trustedState?.reasonCodes?.some((reason) => reason.code === "continue-whip-task" && reason.decision === "continue"));
    assert.ok(parsed.sections?.trustedState?.reasonCodes?.some((reason) => reason.code === "stop-unsupported-input" && reason.category === "input"));
    assert.deepEqual(parsed.sections?.decision?.modes, ["continue", "repair", "wait", "stop"]);
    assert.deepEqual(parsed.sections?.decision?.promptKinds, ["work", "review", "repair", "planning", "quality", "whip", "wait", "stop"]);
    assert.deepEqual(parsed.sections?.promptRendering?.fingerprintInputs, ["decisionKind", "selectedItem", "reasonCodes", "sourceTimestamps", "body"]);
    assert.deepEqual(parsed.sections?.promptRendering?.customizableSections, ["work", "planning", "quality", "whip"]);
    assert.deepEqual(parsed.sections?.promptRendering?.metadataShape, ["kind", "decisionKind", "selectedItem", "reasonCodes", "sourceTimestamps", "body", "fingerprint"]);
    assert.ok(parsed.sections?.status?.outputShape?.includes("decision"));
    assert.ok(parsed.sections?.status?.outputShape?.includes("prompt"));
    assert.ok(parsed.sections?.status?.errorCodes?.includes("trusted-command-malformed-json"));
    assert.ok(parsed.sections?.status?.errorCodes?.includes("status-config-invalid"));

    const init = parsed.commands.find((command) => command.name === "init");
    assert.ok(init);
    assert.equal(init.interactions?.json, true);
    assert.equal(init.dryRun?.supported, true);
    assert.equal(init.mutation?.mutates, true);
    assert.ok(init.flags?.some((flag) => flag.name === "tool" && flag.type === "option"));
    assert.ok(init.flags?.some((flag) => flag.name === "dry-run" && flag.type === "boolean"));
    assert.ok(init.flags?.some((flag) => flag.name === "force" && flag.type === "boolean"));

    const hookStop = parsed.commands.find((command) => command.name === "hook-stop");
    assert.ok(hookStop);
    assert.deepEqual(hookStop.output?.formats, ["human", "json"]);
    assert.equal(hookStop.interactions?.json, true);
    assert.equal(hookStop.mutation?.mutates, false);
    assert.ok(hookStop.flags?.some((flag) => flag.name === "tool" && flag.type === "option"));

    const doctor = parsed.commands.find((command) => command.name === "doctor");
    assert.ok(doctor);
    assert.equal(doctor.interactions?.json, true);
    assert.equal(doctor.dryRun?.supported, false);
    assert.equal(doctor.mutation?.mutates, false);
    assert.ok(doctor.flags?.some((flag) => flag.name === "json" && flag.type === "boolean"));
    assert.ok(doctor.flags?.some((flag) => flag.name === "config" && flag.type === "string"));
    assert.ok(doctor.errors?.some((error) => error.kind === "config-missing"));
    assert.ok(doctor.errors?.some((error) => error.kind === "host-stop-hook-blocking-unsafe"));
    assert.ok(doctor.errors?.some((error) => error.kind === "trusted-command-missing"));

    const paths = parsed.commands.find((command) => command.name === "paths");
    assert.ok(paths);
    assert.deepEqual(paths.output?.formats, ["human", "json"]);
    assert.equal(paths.output?.defaultFormat, "human");
    assert.equal(paths.interactions?.json, true);
    assert.equal(paths.interactions?.noColor, true);
    assert.equal(paths.interactions?.nonInteractive, true);
    assert.equal(paths.interactions?.ttyPrompt, false);
    assert.equal(paths.dryRun?.supported, false);
    assert.equal(paths.mutation?.mutates, false);
    assert.ok(paths.flags?.some((flag) => flag.name === "json" && flag.type === "boolean"));
    assert.ok(paths.flags?.some((flag) => flag.name === "config" && flag.type === "string"));
    assert.ok(paths.examples?.some((example) => example.command === "aiu paths --json"));
    assert.ok(paths.errors?.some((error) => error.kind === "asset-paths-unavailable"));
    assert.deepEqual(paths.exitCodes?.map((exitCode) => exitCode.code), [0, 1, 2]);

    const status = parsed.commands.find((command) => command.name === "status");
    assert.ok(status);
    assert.deepEqual(status.output?.formats, ["human", "json"]);
    assert.equal(status.interactions?.json, true);
    assert.equal(status.dryRun?.supported, false);
    assert.equal(status.mutation?.mutates, false);
    assert.ok(status.flags?.some((flag) => flag.name === "json" && flag.type === "boolean"));
    assert.ok(status.flags?.some((flag) => flag.name === "config" && flag.type === "string"));
    assert.ok(status.errors?.some((error) => error.kind === "trusted-command-stale-state"));
    assert.ok(status.errors?.some((error) => error.kind === "trusted-command-timeout"));
    assert.ok(status.errors?.some((error) => error.kind === "trusted-command-invalid-state"));

    const migrate = parsed.commands.find((command) => command.name === "migrate");
    assert.ok(migrate);
    assert.deepEqual(migrate.output?.formats, ["human", "json"]);
    assert.equal(migrate.output?.defaultFormat, "human");
    assert.equal(migrate.interactions?.json, true);
    assert.equal(migrate.dryRun?.supported, true);
    assert.equal(migrate.mutation?.mutates, false);
    assert.ok(migrate.flags?.some((flag) => flag.name === "dry-run" && flag.type === "boolean"));
    assert.ok(migrate.examples?.some((example) => example.command === "aiu migrate --dry-run --json"));

    const schema = parsed.commands.find((command) => command.name === "schema");
    assert.ok(schema);
    assert.deepEqual(schema.output?.formats, ["json"]);
    assert.equal(schema.output?.defaultFormat, "json");
    assert.equal(schema.interactions?.json, true);
    assert.equal(schema.dryRun?.supported, false);
    assert.equal(schema.mutation?.mutates, false);
    assert.ok(schema.flags?.some((flag) => flag.name === "json" && flag.type === "boolean"));
    assert.ok(schema.examples?.some((example) => example.command === "aiu schema --json"));
  });

  it("emits clean JSON for discovered config defaults", async () => {
    const result = await runCli(["config", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      config: {
        found: boolean;
        defaultsUsed: boolean;
        valid: boolean;
        value: {
          version: number;
          paths: {
            stateDir: string;
            lockDir: string;
            logDir: string;
          };
          continuation: {
            stopOnUnknownState: boolean;
            stopOnSupplyChainApprovalBlock: boolean;
            allowBackgroundScheduling: boolean;
          };
          supplyChain: {
            stopOnApprovalRequired: boolean;
          };
        };
        diagnostics: unknown[];
      };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "config");
    assert.equal(parsed.config.found, false);
    assert.equal(parsed.config.defaultsUsed, true);
    assert.equal(parsed.config.valid, true);
    assert.deepEqual(parsed.config.value.paths, {
      stateDir: ".umpire/state",
      lockDir: ".umpire/locks",
      logDir: ".umpire/logs",
    });
    assert.equal(parsed.config.value.continuation.stopOnUnknownState, true);
    assert.equal(parsed.config.value.continuation.stopOnSupplyChainApprovalBlock, true);
    assert.equal(parsed.config.value.continuation.allowBackgroundScheduling, false);
    assert.equal(parsed.config.value.supplyChain.stopOnApprovalRequired, true);
    assert.deepEqual(parsed.config.diagnostics, []);
  });

  it("emits clean JSON for migration dry-run plans", async () => {
    const result = await runCli(["migrate", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      migrate: {
        ok: boolean;
        dryRun: boolean;
        repoLocalHooks: unknown[];
        localCheckoutReferences: unknown[];
        scanErrors: unknown[];
        managedSections: unknown[];
        customizationPoints: string[];
        recommendedNextCommand: string;
      };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "migrate");
    assert.equal(parsed.migrate.ok, true);
    assert.equal(parsed.migrate.dryRun, true);
    assert.deepEqual(parsed.migrate.repoLocalHooks, []);
    assert.deepEqual(parsed.migrate.scanErrors, []);
    assert.ok(parsed.migrate.managedSections.length >= 3);
    assert.ok(parsed.migrate.customizationPoints.includes("aiu.config.json trustedStateCommands argv arrays"));
    assert.equal(parsed.migrate.recommendedNextCommand, "aiu init --dry-run --json");
  });

  it("emits host Stop hook responses without extra output", async () => {
    const hostResponse = await runCli(["hook-stop", "--tool", "codex"]);

    assert.equal(hostResponse.exitCode, 0);
    assert.equal(hostResponse.stdout, "{}\n");
    assert.equal(hostResponse.stderr, "");

    const result = await runCli(["hook-stop", "--tool", "claude-code", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      hookStop: {
        tool: string;
        decision: string;
        reason: string;
        stdoutJson: Record<string, never>;
      };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "hook-stop");
    assert.equal(parsed.hookStop.tool, "claude-code");
    assert.equal(parsed.hookStop.decision, "allow");
    assert.match(parsed.hookStop.reason, /safe behavior is to allow/);
    assert.deepEqual(parsed.hookStop.stdoutJson, {});
  });

  it("suggests unknown commands and flags without executing alternatives", async () => {
    const unknownCommand = await runCli(["path"]);
    assert.equal(unknownCommand.exitCode, 2);
    assert.equal(unknownCommand.stdout, "");
    assert.match(unknownCommand.stderr, /Unknown command: path/);
    assert.match(unknownCommand.stderr, /Did you mean "paths"/);

    const unknownFlag = await runCli(["paths", "--jsoon"]);
    assert.equal(unknownFlag.exitCode, 2);
    assert.equal(unknownFlag.stdout, "");
    assert.match(unknownFlag.stderr, /Unknown flag: --jsoon/);
    assert.match(unknownFlag.stderr, /Did you mean "--json"/);
  });
});

async function runCli(input: readonly string[]) {
  try {
    const result = await execFileAsync(process.execPath, [aiuBin, ...input], {
      cwd: repoRoot,
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    assert(error !== null && typeof error === "object");
    const failed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}
