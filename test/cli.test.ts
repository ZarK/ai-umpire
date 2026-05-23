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
      };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "paths");
    assert.equal(typeof parsed.paths.packageRoot, "string");
    assert.equal(parsed.paths.pluginWrapperRelativePath, ".opencode/plugins/ai-umpire-continuation.ts");
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
        };
      };
      package: { name: string };
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(parsed.bin, "aiu");
    assert.equal(parsed.package.name, "@tjalve/aiu");

    const commandNames = parsed.commands.map((command) => command.name);
    assert.deepEqual(commandNames, ["config", "paths", "schema"]);

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
    assert.deepEqual(parsed.sections?.config?.hostCapabilityNames, ["stopHook", "sessionState", "promptDelivery"]);

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
    assert.ok(paths.examples?.some((example) => example.command === "aiu paths --json"));
    assert.ok(paths.errors?.some((error) => error.kind === "asset-paths-unavailable"));
    assert.deepEqual(paths.exitCodes?.map((exitCode) => exitCode.code), [0, 1, 2]);

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
