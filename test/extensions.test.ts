import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { getDefaultAiuConfig } from "../dist/src/config.js";
import type * as AiuExtensions from "../src/extensions.ts";
import type * as AiuOpenCode from "../src/opencode.ts";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());

describe("extension API", () => {
  it("renders repo-level prompt section customizations without private internals", async () => {
    const { renderAiuPromptSection } = await import(path.join(repoRoot, "dist/src/extensions.js")) as typeof AiuExtensions;
    const config = {
      ...getDefaultAiuConfig(),
      prompts: {
        sections: {
          work: {
            prepend: ["Check trusted state first."],
            append: ["Keep the next action bounded."],
          },
        },
      },
    };

    const rendered = renderAiuPromptSection({
      kind: "work",
      defaultText: "Continue the next ready issue.",
      config,
    });

    assert.equal(rendered.customized, true);
    assert.equal(rendered.source, "repo-config");
    assert.equal(rendered.text, "Check trusted state first.\n\nContinue the next ready issue.\n\nKeep the next action bounded.");
  });

  it("ignores inherited prompt section values", async () => {
    const { renderAiuPromptSection } = await import(path.join(repoRoot, "dist/src/extensions.js")) as typeof AiuExtensions;
    const sections = Object.create({
      work: {
        prepend: ["Inherited text must not be trusted."],
        append: [],
      },
    }) as ReturnType<typeof getDefaultAiuConfig>["prompts"]["sections"];

    const rendered = renderAiuPromptSection({
      kind: "work",
      defaultText: "Continue the next ready issue.",
      config: {
        ...getDefaultAiuConfig(),
        prompts: { sections },
      },
    });

    assert.equal(rendered.customized, false);
    assert.equal(rendered.text, "Continue the next ready issue.");
  });


  it("composes OpenCode handlers around the package runtime delegate", async () => {
    const { createAiuOpenCodePlugin } = await import(path.join(repoRoot, "dist/src/opencode.js")) as typeof AiuOpenCode;
    const target = await mkdtemp(path.join(tmpdir(), "aiu-opencode-extension-"));
    try {
      const calls: string[] = [];
      const before: AiuOpenCode.AiuOpenCodeHandler = async (_event, _context, next) => {
        calls.push("before");
        const result = await next();
        calls.push("after-next");
        return result;
      };
      const after: AiuOpenCode.AiuOpenCodeHandler = async (_event, context, next) => {
        calls.push(`after:${context.previousResult?.metadata?.eventType ?? "none"}`);
        return next();
      };
      const plugin = createAiuOpenCodePlugin({ before: [before], after: [after] });

      const result = await plugin.handle({ type: "idle" }, { cwd: target });

      assert.deepEqual(calls, ["before", "after-next", "after:idle"]);
      assert.equal(result.handled, true);
      assert.equal(result.metadata?.eventType, "idle");
      assert.ok(result.metadata?.suppressions?.includes("host-disabled"));
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("allows after OpenCode handlers to override the package delegate result", async () => {
    const { createAiuOpenCodePlugin } = await import(path.join(repoRoot, "dist/src/opencode.js")) as typeof AiuOpenCode;
    const override: AiuOpenCode.AiuOpenCodeHandler = (_event, context) => ({
      handled: true,
      metadata: {
        ...context.previousResult?.metadata,
        repoCustom: true,
      },
    });
    const plugin = createAiuOpenCodePlugin({ after: [override] });

    const result = await plugin.handle({ type: "idle" });

    assert.equal(result.metadata?.repoCustom, true);
  });

  it("rejects handlers that call next more than once", async () => {
    const { composeAiuOpenCodeHandlers } = await import(path.join(repoRoot, "dist/src/opencode.js")) as typeof AiuOpenCode;
    const invalid: AiuOpenCode.AiuOpenCodeHandler = async (_event, _context, next) => {
      await next();
      return next();
    };
    const handler = composeAiuOpenCodeHandlers([invalid]);

    await assert.rejects(async () => handler({ type: "idle" }, {}, async () => ({ handled: false })), /next\(\) was called more than once/);
  });

  it("compiles examples against exported package types only", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "aiu-extension-example-"));
    const tsconfigPath = path.join(tempRoot, "tsconfig.json");
    try {
      await writeFile(
        tsconfigPath,
        `${JSON.stringify(
          {
            compilerOptions: {
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
              strict: true,
              target: "ES2022",
              types: ["node"],
              typeRoots: [path.join(repoRoot, "node_modules/@types")],
              paths: {
                "@tjalve/aiu": [path.join(repoRoot, "dist/src/index.d.ts")],
                "@tjalve/aiu/opencode": [path.join(repoRoot, "dist/src/opencode.d.ts")],
              },
            },
            files: [path.join(repoRoot, "examples/opencode-extension.ts")],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await execFileAsync("pnpm", ["exec", "tsc", "-p", tsconfigPath], { cwd: repoRoot });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
