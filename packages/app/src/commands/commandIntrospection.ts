import type { GthConfig } from '@gaunt-sloth/core/config.js';
import {
  getContentFromSource,
  getRequirementsFromSource,
  type ContentSourceType,
  type RequirementSourceType,
} from '#src/commands/commandUtils.js';
import {
  buildSystemMessages,
  readBackstory,
  readChatPrompt,
  readCodePrompt,
  readExecPrompt,
  readGuidelines,
  readReviewInstructions,
  readSystemPrompt,
} from '@gaunt-sloth/core/utils/llmUtils.js';
import { readPrDiscoveryPrompt } from '#src/commands/prDiscovery.js';

export type PromptCommandType = 'ask' | 'review' | 'pr' | 'pr-discovery' | 'chat' | 'code' | 'exec';
export type SourceCommandType = 'review' | 'pr';
export type SourceInputType = 'content' | 'requirements';

export function getAskSystemPrompt(config: GthConfig): string {
  const parts = [readBackstory(config), readGuidelines(config)];
  const systemPrompt = readSystemPrompt(config);
  if (systemPrompt) {
    parts.push(systemPrompt);
  }
  return parts.join('\n');
}

export function getExecSystemPrompt(config: GthConfig): string {
  return flattenSystemMessageContent(config, readExecPrompt(config));
}

export function getReviewSystemPrompt(config: GthConfig): string {
  const parts = [readBackstory(config), readGuidelines(config), readReviewInstructions(config)];
  const systemPrompt = readSystemPrompt(config);
  if (systemPrompt) {
    parts.push(systemPrompt);
  }
  return parts.join('\n');
}

export function getCommandSystemPrompt(command: PromptCommandType, config: GthConfig): string {
  if (command === 'ask') {
    return getAskSystemPrompt(config);
  }
  if (command === 'exec') {
    return getExecSystemPrompt(config);
  }
  if (command === 'review' || command === 'pr') {
    return getReviewSystemPrompt(config);
  }

  const modePrompt =
    command === 'pr-discovery'
      ? readPrDiscoveryPrompt(config)
      : command === 'chat'
        ? readChatPrompt(config)
        : readCodePrompt(config);
  return flattenSystemMessageContent(config, modePrompt);
}

function flattenSystemMessageContent(config: GthConfig, modePrompt: string): string {
  const [systemMessage] = buildSystemMessages(config, modePrompt);
  const content = systemMessage?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === 'string' ? item : 'text' in item ? item.text : ''))
      .join('\n');
  }

  return '';
}

export function getEffectiveRequirementSource(
  command: SourceCommandType,
  config: GthConfig,
  cliSource?: RequirementSourceType
): RequirementSourceType | undefined {
  return (
    cliSource ??
    (config?.commands?.[command]?.requirementSource as RequirementSourceType | undefined) ??
    (config?.requirementSource as RequirementSourceType | undefined)
  );
}

export function getEffectiveContentSource(
  command: SourceCommandType,
  config: GthConfig,
  cliSource?: ContentSourceType
): ContentSourceType | undefined {
  return (
    cliSource ??
    (config?.commands?.[command]?.contentSource as ContentSourceType | undefined) ??
    (config?.contentSource as ContentSourceType | undefined) ??
    (command === 'pr' ? 'github' : undefined)
  );
}

export async function getCommandSourceInput(
  command: SourceCommandType,
  inputType: SourceInputType,
  id: string | undefined,
  config: GthConfig,
  cliSource?: RequirementSourceType | ContentSourceType
): Promise<string> {
  if (inputType === 'requirements') {
    return getRequirementsFromSource(
      getEffectiveRequirementSource(command, config, cliSource as RequirementSourceType),
      id,
      config
    );
  }

  return getContentFromSource(
    getEffectiveContentSource(command, config, cliSource as ContentSourceType),
    id,
    config
  );
}
