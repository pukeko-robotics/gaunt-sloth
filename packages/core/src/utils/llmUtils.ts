import { RunnableConfig } from '@langchain/core/runnables';
import { randomUUID } from 'node:crypto';
import {
  GSLOTH_BACKSTORY,
  GSLOTH_CHAT_PROMPT,
  GSLOTH_CODE_PROMPT,
  GSLOTH_EXEC_PROMPT,
  GSLOTH_SYSTEM_PROMPT,
  PROJECT_GUIDELINES,
  PROJECT_REVIEW_INSTRUCTIONS,
} from '#src/constants.js';
import { getGslothConfigReadPath, readFileFromInstallDir } from '#src/utils/fileUtils.js';
import { existsSync, readFileSync } from 'node:fs';
import { debugLog } from '#src/utils/debugUtils.js';
import { truncateString } from '#src/utils/stringUtils.js';
import { GthConfig, PromptSegmentName } from '#src/config.js';
import { SystemMessage } from '@langchain/core/messages';

/**
 * Creates new runnable config.
 * configurable.thread_id is an important part of that because it helps to distinguish different chat sessions.
 * We normally do not have multiple sessions in the terminal, but I had bad stuff happening in tests
 * and in another prototype project where I was importing Gaunt Sloth.
 */
export function getNewRunnableConfig(recursionLimit: number = 1000): RunnableConfig {
  return {
    recursionLimit,
    configurable: { thread_id: randomUUID() },
  };
}

/**
 * GS2-43 — each prompt segment's default-named file. The `prompts.<segment>` config retargets,
 * disables, or composes against these; with no config the segment resolves exactly as before
 * (config-dir/project file of this name, else the bundled default).
 */
const PROMPT_SEGMENT_FILES: Record<PromptSegmentName, string> = {
  backstory: GSLOTH_BACKSTORY,
  guidelines: PROJECT_GUIDELINES,
  system: GSLOTH_SYSTEM_PROMPT,
  chat: GSLOTH_CHAT_PROMPT,
  code: GSLOTH_CODE_PROMPT,
  exec: GSLOTH_EXEC_PROMPT,
  review: PROJECT_REVIEW_INSTRUCTIONS,
};

/** The config slice every prompt-segment read needs. */
type PromptReadConfig = Pick<GthConfig, 'prompts' | 'identityProfile' | 'noDefaultPrompts'>;

/**
 * GS2-43 — the single composition point for one prompt segment, honouring the segment's
 * `prompts.<segment>` config:
 * - no setting → the segment's default-named file ({@link PROMPT_SEGMENT_FILES}), falling back
 *   to the bundled default unless `noDefaultPrompts` — exactly the pre-GS2-43 behaviour;
 * - a `string` → shorthand for `{ path }`;
 * - `enabled: false` → the segment is dropped entirely (returns `''`), even its bundled default;
 * - `path` + `mode: 'replace'` (default) → the file replaces the built-in segment content;
 * - `path` + `mode: 'append'` → the file content is appended after the built-in content.
 */
export function readPromptSegment(segment: PromptSegmentName, config: PromptReadConfig): string {
  const setting = config.prompts?.[segment];
  const segmentConfig = typeof setting === 'string' ? { path: setting } : (setting ?? {});
  if (segmentConfig.enabled === false) {
    return '';
  }
  const readBuiltIn = () =>
    readPromptFile(PROMPT_SEGMENT_FILES[segment], config.identityProfile, config.noDefaultPrompts);
  if (!segmentConfig.path) {
    return readBuiltIn();
  }
  const fileContent = readPromptFile(
    segmentConfig.path,
    config.identityProfile,
    config.noDefaultPrompts
  );
  if (segmentConfig.mode === 'append') {
    return [readBuiltIn(), fileContent].filter(Boolean).join('\n');
  }
  return fileContent;
}

export function readBackstory(config: PromptReadConfig): string {
  return readPromptSegment('backstory', config);
}

export function readGuidelines(
  config:
    | Pick<
        GthConfig,
        | 'prompts'
        | 'includeCurrentDateAfterGuidelines'
        | 'organization'
        | 'identityProfile'
        | 'noDefaultPrompts'
      >
    | string
): string {
  if (typeof config === 'string') {
    return readPromptFile(config, undefined);
  }
  const guidelines = readPromptSegment('guidelines', config);
  if (config.includeCurrentDateAfterGuidelines) {
    const currentDate = new Date();

    const orgName = config.organization?.name;
    const locale = config.organization?.locale;
    const timezone = config.organization?.timezone;

    const hasLocaleOrTimezone = Boolean((locale && locale.trim()) || (timezone && timezone.trim()));

    const humanReadableDate = hasLocaleOrTimezone
      ? new Intl.DateTimeFormat(locale?.trim() || undefined, {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone: timezone?.trim() || undefined,
        }).format(currentDate)
      : '';

    const lines: string[] = [guidelines];
    if (orgName) {
      lines.push(`Organization: ${orgName}`);
    }
    lines.push(
      `Current Date: ${currentDate.toISOString()}${hasLocaleOrTimezone ? ` - ${humanReadableDate}` : ''}`
    );
    return lines.join('\n');
  }
  return guidelines;
}

export function readReviewInstructions(config: PromptReadConfig | string): string {
  if (typeof config === 'string') {
    return readPromptFile(config, undefined);
  }
  return readPromptSegment('review', config);
}

export function readSystemPrompt(config: PromptReadConfig): string {
  return readPromptSegment('system', config);
}

export function readChatPrompt(config: PromptReadConfig): string {
  return readPromptSegment('chat', config);
}

export function buildSystemMessages(
  config: GthConfig,
  modePrompt?: string | null
): SystemMessage[] {
  const parts = [readBackstory(config), readGuidelines(config)];
  if (modePrompt) parts.push(modePrompt);
  const systemPrompt = readSystemPrompt(config);
  if (systemPrompt) parts.push(systemPrompt);
  const content = parts.filter(Boolean).join('\n');
  return content.trim() ? [new SystemMessage(content)] : [];
}

export function readCodePrompt(config: PromptReadConfig): string {
  return readPromptSegment('code', config);
}

export function readExecPrompt(config: PromptReadConfig): string {
  return readPromptSegment('exec', config);
}

/**
 * Read a prompt file from the project config dir (honouring identity profiles), falling back
 * to a packaged default unless `noDefaultPrompts` is set. Downstream packages owning their own
 * prompt files (e.g. the assistant's PR discovery prompt) pass `defaultPromptDir` pointing at
 * their package root; when omitted, the default is read from the core package.
 */
export function readPromptFile(
  filename: string,
  identityProfile: string | undefined,
  noDefaultPrompts?: boolean,
  defaultPromptDir?: string
): string {
  const path = getGslothConfigReadPath(filename, identityProfile);
  if (existsSync(path)) {
    return readFileSync(path, { encoding: 'utf8' });
  }
  if (noDefaultPrompts) {
    return '';
  }
  return readFileFromInstallDir(filename, defaultPromptDir);
}

/**
 * Wraps content within randomized block
 */
export function wrapContent(
  content: string,
  wrapBlockPrefix: string = 'block',
  prefix: string = 'content',
  alwaysWrap: boolean = false
): string {
  if (content || alwaysWrap) {
    const contentWrapper = [];
    const block = wrapBlockPrefix + '-' + randomUUID().substring(0, 7);
    contentWrapper.push(`\nProvided ${prefix} follows within ${block} block\n`);
    contentWrapper.push(`<${block}>\n`);
    contentWrapper.push(content);
    contentWrapper.push(`\n</${block}>\n`);
    return contentWrapper.join('');
  }
  return content;
}

/**
 * Utility function to execute hook(s) - either a single hook or an array of hooks
 * Fully type-safe and works with any number of arguments
 * @param hooks - Single hook function or array of hook functions (or undefined)
 * @param args - Arguments to pass to each hook function
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeHooks<T extends (...args: any[]) => Promise<void>>(
  hooks: T | T[] | undefined,
  ...args: Parameters<T>
): Promise<void> {
  if (!hooks) return;

  if (Array.isArray(hooks)) {
    for (const hook of hooks) {
      await hook(...args);
    }
  } else {
    await hooks(...args);
  }
}
/**
 * Format tool call arguments in a human-readable way
 */
export function formatToolCallArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => {
      let displayValue: string;
      if (typeof value === 'string') {
        displayValue = value;
      } else if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
        displayValue = JSON.stringify(value);
      } else {
        displayValue = String(value);
      }
      return `${key}: ${truncateString(displayValue, 50)}`;
    })
    .join(', ');
}

/**
 * Format multiple tool calls for display (matches Invocation.ts behavior)
 */
export function formatToolCalls(
  toolCalls: Array<{ name: string; args?: Record<string, unknown> }>,
  maxLength = 255
): string {
  const formatted = toolCalls
    .map((toolCall) => {
      debugLog(JSON.stringify(toolCall));
      const formattedArgs = formatToolCallArgs(toolCall.args || {});
      return `${toolCall.name}(${formattedArgs})`;
    })
    .join(', ');

  // Truncate to maxLength characters if needed
  return formatted.length > maxLength ? formatted.slice(0, maxLength - 3) + '...' : formatted;
}
