import type { GthConfig } from '@gaunt-sloth/core/config.js';
import {
  getContentFromProvider,
  getRequirementsFromProvider,
  type ContentProviderType,
  type RequirementsProviderType,
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
export type ProviderCommandType = 'review' | 'pr';
export type ProviderInputType = 'content' | 'requirements';

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

export function getEffectiveRequirementsProvider(
  command: ProviderCommandType,
  config: GthConfig,
  cliProvider?: RequirementsProviderType
): RequirementsProviderType | undefined {
  return (
    cliProvider ??
    (config?.commands?.[command]?.requirementsProvider as RequirementsProviderType | undefined) ??
    (config?.requirementsProvider as RequirementsProviderType | undefined)
  );
}

export function getEffectiveContentProvider(
  command: ProviderCommandType,
  config: GthConfig,
  cliProvider?: ContentProviderType
): ContentProviderType | undefined {
  return (
    cliProvider ??
    (config?.commands?.[command]?.contentProvider as ContentProviderType | undefined) ??
    (config?.contentProvider as ContentProviderType | undefined) ??
    (command === 'pr' ? 'github' : undefined)
  );
}

export async function getCommandProviderInput(
  command: ProviderCommandType,
  inputType: ProviderInputType,
  id: string | undefined,
  config: GthConfig,
  cliProvider?: RequirementsProviderType | ContentProviderType
): Promise<string> {
  if (inputType === 'requirements') {
    return getRequirementsFromProvider(
      getEffectiveRequirementsProvider(command, config, cliProvider as RequirementsProviderType),
      id,
      config
    );
  }

  return getContentFromProvider(
    getEffectiveContentProvider(command, config, cliProvider as ContentProviderType),
    id,
    config
  );
}
