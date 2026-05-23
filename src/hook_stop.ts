import type { AiuHost } from "./config.js";

export interface AiuHookStopOptions {
  readonly tool: Extract<AiuHost, "codex" | "claude-code">;
  readonly stdin?: string;
}

export interface AiuHookStopResult {
  readonly tool: AiuHookStopOptions["tool"];
  readonly decision: "allow";
  readonly reason: string;
  readonly inputBytes: number;
  readonly stdoutJson: Readonly<Record<string, never>>;
}

export function runAiuHookStop(options: AiuHookStopOptions): AiuHookStopResult {
  const stdin = options.stdin ?? "";
  return Object.freeze({
    tool: options.tool,
    decision: "allow" as const,
    reason: "Continuation decision engine is not wired for stop hooks yet, so the safe behavior is to allow the host to stop.",
    inputBytes: Buffer.byteLength(stdin, "utf8"),
    stdoutJson: Object.freeze({}),
  });
}

export function formatHookStopJson(result: AiuHookStopResult): string {
  return `${JSON.stringify(result.stdoutJson)}\n`;
}

export async function readHookStopStdin(timeoutMs = 250): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);
      clearTimeout(timer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      clearTimeout(timer);
      timer = setTimeout(finish, timeoutMs);
    };
    const onEnd = () => finish();
    timer = setTimeout(finish, timeoutMs);

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onEnd);
    process.stdin.resume();
  });
}
