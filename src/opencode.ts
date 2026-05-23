import type { AiuConfig } from "./config.js";
import { getDefaultAiuConfig } from "./config.js";

export interface AiuOpenCodeEvent {
  readonly type: string;
  readonly payload?: unknown;
}

export interface AiuOpenCodeContext {
  readonly cwd?: string;
  readonly config?: AiuConfig;
  readonly previousResult?: AiuOpenCodeHandlerResult;
}

export interface AiuOpenCodeHandlerResult {
  readonly handled: boolean;
  readonly command?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type AiuOpenCodeNext = () => Promise<AiuOpenCodeHandlerResult>;
export type AiuOpenCodeHandler = (event: AiuOpenCodeEvent, context: AiuOpenCodeContext, next: AiuOpenCodeNext) => AiuOpenCodeHandlerResult | Promise<AiuOpenCodeHandlerResult>;

export interface AiuOpenCodePlugin {
  readonly name: "@tjalve/aiu/opencode";
  readonly handle: (event: AiuOpenCodeEvent, context?: AiuOpenCodeContext) => Promise<AiuOpenCodeHandlerResult>;
}

export interface AiuOpenCodePluginOptions {
  readonly before?: readonly AiuOpenCodeHandler[];
  readonly after?: readonly AiuOpenCodeHandler[];
}

const AIU_OPENCODE_COMMAND = Object.freeze(["aiu", "hook", "opencode"] as const);

export function createAiuOpenCodePlugin(options: AiuOpenCodePluginOptions = {}): AiuOpenCodePlugin {
  const before = composeAiuOpenCodeHandlers(options.before ?? []);
  const after = composeAiuOpenCodeHandlers(options.after ?? []);
  return Object.freeze({
    name: "@tjalve/aiu/opencode" as const,
    handle: async (event: AiuOpenCodeEvent, context: AiuOpenCodeContext = {}) => {
      const normalizedContext = withDefaultContext(context);
      const result = await before(event, normalizedContext, async () => delegateToAiuOpenCodeCommand(event, normalizedContext));
      return after(event, Object.freeze({ ...normalizedContext, previousResult: result }), async () => result);
    },
  });
}

export function composeAiuOpenCodeHandlers(handlers: readonly AiuOpenCodeHandler[]): AiuOpenCodeHandler {
  return async (event, context, next) => {
    let index = -1;
    async function dispatch(position: number): Promise<AiuOpenCodeHandlerResult> {
      if (position <= index) {
        throw new Error("OpenCode handler next() was called more than once.");
      }
      index = position;
      const handler = handlers[position];
      return handler === undefined ? next() : handler(event, context, () => dispatch(position + 1));
    }
    return dispatch(0);
  };
}

function delegateToAiuOpenCodeCommand(event: AiuOpenCodeEvent, context: AiuOpenCodeContext): AiuOpenCodeHandlerResult {
  return Object.freeze({
    handled: true,
    command: AIU_OPENCODE_COMMAND,
    metadata: Object.freeze({
      eventType: event.type,
      cwd: context.cwd,
      configVersion: context.config?.version,
    }),
  });
}

async function terminalOpenCodeHandler(): Promise<AiuOpenCodeHandlerResult> {
  return Object.freeze({ handled: false });
}

function withDefaultContext(context: AiuOpenCodeContext): AiuOpenCodeContext {
  return Object.freeze({
    ...context,
    config: context.config ?? getDefaultAiuConfig(),
  });
}
