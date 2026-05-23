import type { AiuConfig, AiuPromptSectionKind } from "./config.js";

export interface AiuPromptSectionInput {
  readonly kind: AiuPromptSectionKind;
  readonly defaultText: string;
  readonly config: Pick<AiuConfig, "prompts">;
}

export interface AiuPromptSectionRender {
  readonly kind: AiuPromptSectionKind;
  readonly text: string;
  readonly customized: boolean;
  readonly source: "package-default" | "repo-config";
}

export function renderAiuPromptSection(input: AiuPromptSectionInput): AiuPromptSectionRender {
  if (!Object.hasOwn(input.config.prompts.sections, input.kind)) {
    return Object.freeze({
      kind: input.kind,
      text: input.defaultText,
      customized: false,
      source: "package-default" as const,
    });
  }
  const customization = input.config.prompts.sections[input.kind];
  if (customization === undefined) {
    return Object.freeze({
      kind: input.kind,
      text: input.defaultText,
      customized: false,
      source: "package-default" as const,
    });
  }

  const body = customization.replacement ?? input.defaultText;
  return Object.freeze({
    kind: input.kind,
    text: [...customization.prepend, body, ...customization.append].join("\n\n"),
    customized: true,
    source: "repo-config" as const,
  });
}
