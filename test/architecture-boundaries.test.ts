import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type SourceModule = {
  readonly name: string;
  readonly source: string;
  readonly imports: readonly string[];
};

describe("runtime architecture boundaries", () => {
  it("keeps normal runtime paths isolated from migration and CLI implementation modules", async () => {
    const modules = await loadSourceModules();
    const normalRuntimeModules = [
      "config",
      "continuation_store",
      "decision",
      "extensions",
      "hook_stop",
      "host_policy",
      "opencode",
      "prompt",
      "state",
      "status",
      "trusted_adapter",
      "whip",
    ];
    const forbiddenRuntimeImports = new Set(["assets", "cli", "command_registry", "doctor", "init", "migrate"]);

    for (const moduleName of normalRuntimeModules) {
      const module = moduleByName(modules, moduleName);
      for (const imported of dependencyNames(module).filter((item) => !item.includes(":") && !item.startsWith("@"))) {
        assert.equal(forbiddenRuntimeImports.has(imported), false, `${moduleName} must not import ${imported}`);
      }
    }
  });

  it("keeps provider-neutral core modules free of filesystem, process execution, CLI, and host delivery imports", async () => {
    const modules = await loadSourceModules();
    const coreModules = ["state", "decision", "prompt", "extensions"];
    const forbiddenImports = new Set([
      "node:fs",
      "node:fs/promises",
      "node:child_process",
      "cli",
      "command_registry",
      "doctor",
      "hook_stop",
      "init",
      "migrate",
      "opencode",
      "status",
      "trusted_adapter",
    ]);

    for (const moduleName of coreModules) {
      const module = moduleByName(modules, moduleName);
      for (const imported of dependencyNames(module)) {
        assert.equal(forbiddenImports.has(imported), false, `${moduleName} must not import ${imported}`);
      }
    }
  });

  it("keeps host adapters thin wrappers over shared runtime services", async () => {
    const modules = await loadSourceModules();
    const requiredSharedImports = ["config", "decision", "prompt", "state", "trusted_adapter", "whip"];
    const forbiddenHostImports = new Set([
      "node:child_process",
      "node:fs",
      "node:fs/promises",
      "assets",
      "cli",
      "command_registry",
      "doctor",
      "init",
      "migrate",
    ]);

    for (const moduleName of ["hook_stop", "opencode"]) {
      const module = moduleByName(modules, moduleName);
      const imports = new Set(dependencyNames(module));

      for (const required of requiredSharedImports) {
        assert.equal(imports.has(required), true, `${moduleName} should delegate through ${required}`);
      }
      for (const forbidden of forbiddenHostImports) {
        assert.equal(imports.has(forbidden), false, `${moduleName} must not import ${forbidden}`);
      }
    }
  });

  it("keeps trusted command execution explicit and shell-free", async () => {
    const modules = await loadSourceModules();
    const trustedAdapter = moduleByName(modules, "trusted_adapter");
    const imports = new Set(dependencyNames(trustedAdapter));

    assert.equal(imports.has("node:child_process"), true);
    assert.match(trustedAdapter.source, /\bspawn\(executable,\s*args,\s*\{/);
    assert.match(trustedAdapter.source, /\bshell:\s*false\b/);
    assert.doesNotMatch(trustedAdapter.source, /\bexec(?:File)?(?:Sync)?\s*\(/);
  });

  it("keeps CLI dispatch and metadata on qube-cli", async () => {
    const modules = await loadSourceModules();
    const cli = moduleByName(modules, "cli");
    const registry = moduleByName(modules, "command_registry");
    const bin = moduleByName(modules, "bin/aiu");

    assert.ok(cli.imports.includes("@tjalve/qube-cli/runtime"));
    assert.ok(registry.imports.includes("@tjalve/qube-cli/metadata"));
    assert.ok(registry.imports.includes("@tjalve/qube-cli/registry"));
    assert.match(bin.source, /runAiuCli\(process\.argv\.slice\(2\)\)/);
    assert.doesNotMatch(cli.source, /\bprocess\.argv\b/);
    assert.doesNotMatch(registry.source, /\bprocess\.argv\b/);
  });

  it("rejects explicit fallback and placeholder identifiers in normal runtime modules", async () => {
    const modules = await loadSourceModules();
    const runtimeModules = [
      "continuation_store",
      "decision",
      "hook_stop",
      "opencode",
      "prompt",
      "state",
      "status",
      "trusted_adapter",
      "whip",
    ];
    const forbiddenPatterns = [
      /\blegacyHelperMode\b/,
      /\bruntimeFallback\b/,
      /\bfallbackCli\b/,
      /\blegacyFallback\b/,
      /\blocal-checkout\b/i,
      /\bplaceholder provider\b/i,
      /\bno-op command\b/i,
    ];

    for (const moduleName of runtimeModules) {
      const module = moduleByName(modules, moduleName);
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(module.source, pattern, `${moduleName} contains forbidden runtime fallback marker ${pattern}`);
      }
    }
  });

  it("keeps product-facing docs free of implementation-history wording", async () => {
    const docs = [
      "README.md",
      ...(await readdir(path.join(repoRoot, "docs"))).filter((file) => file.endsWith(".md")).map((file) => path.join("docs", file)),
    ];
    const forbiddenPatterns = [
      /\bsource-provenance\b/i,
      /\blocal reference\b/i,
      /\blocal-reference\b/i,
      /\blocal-checkout\b/i,
      /\bbootstrap phases?\b/i,
    ];

    for (const relativePath of docs) {
      const source = await readFile(path.join(repoRoot, relativePath), "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(source, pattern, `${relativePath} contains implementation-history wording ${pattern}`);
      }
    }
  });
});

async function loadSourceModules(): Promise<readonly SourceModule[]> {
  const files = await collectSourceFiles(path.join(repoRoot, "src"));
  return Promise.all(files.map(async (filePath) => {
    const source = await readFile(filePath, "utf8");
    return Object.freeze({
      name: sourceModuleName(filePath),
      source,
      imports: Object.freeze(parseImportSpecifiers(source)),
    });
  }));
}

async function collectSourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  }));
  return files.flat().sort();
}

function sourceModuleName(filePath: string): string {
  const relative = path.relative(path.join(repoRoot, "src"), filePath);
  return relative.replace(/\.ts$/, "").split(path.sep).join("/");
}

function parseImportSpecifiers(source: string): readonly string[] {
  const imports: string[] = [];
  const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    if (match[1]) {
      imports.push(match[1]);
    }
  }
  return imports;
}

function moduleByName(modules: readonly SourceModule[], name: string): SourceModule {
  const module = modules.find((item) => item.name === name);
  assert.ok(module, `missing source module ${name}`);
  return module;
}

function dependencyNames(module: SourceModule): readonly string[] {
  return module.imports.map((specifier) => localModuleName(specifier, module.name) ?? specifier);
}

function localModuleName(specifier: string, importerName: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const importerDirectory = path.posix.dirname(importerName);
  const withoutExtension = specifier.replace(/\.(?:[cm]?js|[cm]?ts)$/, "");
  return path.posix.normalize(path.posix.join(importerDirectory, withoutExtension)).replace(/^\.\//, "");
}
