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
import { displayWarning } from '#src/utils/consoleUtils.js';
import { truncateString } from '#src/utils/stringUtils.js';
import { isPathArgument, truncatePathStart } from '#src/utils/pathArguments.js';
import { GthConfig, PromptSegmentName, ScopedPromptsEntry } from '#src/config.js';
import type { GthCommand } from '#src/core/types.js';
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
type PromptReadConfig = Pick<
  GthConfig,
  'prompts' | 'identityProfile' | 'noDefaultPrompts' | 'scopedPrompts'
>;

/**
 * CFG-70 — the byte total above which a run warns that its scoped overlays have become a large
 * prompt in their own right. A **warning, never a cap**: nothing is truncated, because a guideline
 * cut mid-sentence is worse than a long prompt — the model then follows a rule whose exception was
 * removed.
 *
 * Where 64 KiB comes from, since a threshold nobody can argue with is a threshold nobody trusts:
 *
 * - **Measured floor.** Every prompt file gaunt-sloth ships — all seven bundled segments together
 *   — is under 7 KB. This is an order of magnitude above the whole built-in prompt, so a user is
 *   well past "a few per-module guideline files" before it says anything.
 * - **Context-window ceiling.** At the customary ~4 bytes per token this is roughly 16k tokens,
 *   about an eighth of a 128k-token window — the smallest among the models `review` and `pr`
 *   routinely run on — and the diff, the requirements and the model's own answer still have to fit
 *   beside it.
 *
 * The cost of firing slightly early is one line of output, which is why the estimate is allowed to
 * be an estimate.
 */
export const SCOPED_PROMPT_BUDGET_BYTES = 65_536;

/** What the selected scoped entries cost, as {@link measureScopedPrompts} reports it. */
export interface ScopedPromptBudget {
  /** Total bytes of every scoped segment file the entries resolve to. */
  totalBytes: number;
  /** Entries contributing at least one resolvable file, in config order. */
  entryNames: string[];
  /** Whether {@link totalBytes} is over {@link SCOPED_PROMPT_BUDGET_BYTES}. */
  overBudget: boolean;
}

/** The seven segment names, in the order {@link ScopedPromptsEntry} declares them. */
const SCOPED_SEGMENT_NAMES: readonly PromptSegmentName[] = [
  'backstory',
  'guidelines',
  'system',
  'chat',
  'code',
  'exec',
  'review',
];

/**
 * CFG-70 — where one scoped entry's segment path lands, and whether anything is there.
 *
 * It reports the resolved path on **both** outcomes, because the caller that has to warn about a
 * missing file needs to name where it looked — a user who mistyped a path learns nothing from
 * being told their own string back.
 *
 * **Deliberately not {@link readPromptFile}**, which is the function every *root* segment goes
 * through. `readPromptFile` falls back to the installed package directory when the project file is
 * absent, and for a scoped path that fallback is wrong in both of its outcomes: a bundled default
 * of the same name would attach content the user never asked for to a module it has nothing to do
 * with, and the ordinary case — no such file in the package either — throws an ENOENT naming a
 * path inside `node_modules`, which tells a user with a typo in their config nothing they can act
 * on. A scoped path has no bundled default by construction: it names a file the user wrote.
 *
 * The one thing it shares with `readPromptFile` is {@link getGslothConfigReadPath}, so an identity
 * profile retargets a scoped path exactly as it retargets a root one.
 */
export function resolveScopedSegmentPath(
  path: string,
  identityProfile: string | undefined
): { resolved: string; exists: boolean } {
  const resolved = getGslothConfigReadPath(path, identityProfile);
  return { resolved, exists: existsSync(resolved) };
}

/**
 * CFG-70 — what the selected scoped entries will cost, in bytes of file content.
 *
 * Exported so exactly one site owns the resolution-and-sizing walk: `review()` decides whether to
 * warn, and does not re-derive where a scoped file lives. Unresolvable paths contribute nothing
 * and are not reported here — {@link readPromptSegment} is where a user hears about those, once
 * per segment that actually wanted the file.
 */
export function measureScopedPrompts(
  entries: readonly ScopedPromptsEntry[],
  config: Pick<GthConfig, 'identityProfile'>
): ScopedPromptBudget {
  let totalBytes = 0;
  const entryNames: string[] = [];
  for (const entry of entries) {
    let contributed = false;
    for (const segment of SCOPED_SEGMENT_NAMES) {
      const path = entry[segment];
      if (!path) continue;
      const { resolved, exists } = resolveScopedSegmentPath(path, config.identityProfile);
      if (!exists) continue;
      totalBytes += Buffer.byteLength(readFileSync(resolved, { encoding: 'utf8' }), 'utf8');
      contributed = true;
    }
    if (contributed) entryNames.push(entry.name);
  }
  return { totalBytes, entryNames, overBudget: totalBytes > SCOPED_PROMPT_BUDGET_BYTES };
}

/**
 * The `##` heading one segment's scoped block is filed under. The noun follows the segment,
 * because "Module guidelines" and "Module review instructions" are what those two segments are
 * called everywhere else a user meets them; the remaining five have no established noun and take
 * the generic form.
 */
function scopedBlockHeading(segment: PromptSegmentName): string {
  if (segment === 'guidelines') return '## Module guidelines';
  if (segment === 'review') return '## Module review instructions';
  return `## Module ${segment} prompt`;
}

/**
 * CFG-70 — compose the scoped overlay for ONE segment, or `''` when nothing applies.
 *
 * Shape, for `guidelines` with two selected entries carrying one:
 *
 * ```text
 * ## Module guidelines
 * The diff under review touches these modules. Each block applies ONLY to files under its paths.
 *
 * ### vue-ui — packages/vue-ui/**
 * <contents of the entry's guidelines file>
 *
 * ### e2e — e2e/**, playwright.config.ts
 * <contents of the entry's guidelines file>
 * ```
 *
 * The `###` line lists **all** of the entry's patterns, negations included: the model is being
 * told which files a block governs, and an exclusion is part of that answer.
 *
 * An entry carrying no path for this segment contributes nothing and is absent, and when no
 * selected entry carries the segment there is no heading either — an empty `## Module guidelines`
 * would read to the model as "these modules have no guidelines", which is the opposite of what a
 * config that simply scopes a different segment means.
 *
 * **A path that does not resolve, or resolves to an empty file, warns and is omitted.** Those are
 * the two ways a block could come out silently empty, and a silent empty block is the one outcome
 * with no recovery: the review runs, looks ordinary, and is missing the guidelines the user wrote
 * the entry for. Warning rather than throwing is a proportionality judgement — scoped content is
 * *extra* by definition, so one mistyped path should not refuse to review the diff at all, and the
 * warning names the entry, the segment and the resolved path, which is everything needed to fix
 * it. The warning may repeat within a run, because composition happens per segment per read and
 * several sites compose a prompt; twice is the right side of the error to be on.
 */
function composeScopedPromptSegment(segment: PromptSegmentName, config: PromptReadConfig): string {
  const entries = config.scopedPrompts;
  if (!entries?.length) return '';

  const blocks: string[] = [];
  for (const entry of entries) {
    const path = entry[segment];
    if (!path) continue;
    const { resolved, exists } = resolveScopedSegmentPath(path, config.identityProfile);
    if (!exists) {
      displayWarning(
        `Scoped prompt "${entry.name}" points its ${segment} at ${path}, which does not exist ` +
          `(looked for ${resolved}). That module's ${segment} will be missing from this run.`
      );
      continue;
    }
    // `trimEnd` only: a prompt file almost always ends in a newline, and the block separator is
    // this function's to decide. Leading whitespace is left alone — it can be the indentation of
    // a fenced example on the file's first line.
    const content = readFileSync(resolved, { encoding: 'utf8' }).trimEnd();
    if (!content) {
      displayWarning(
        `Scoped prompt "${entry.name}" points its ${segment} at ${path}, which is empty. ` +
          `That module's ${segment} will be missing from this run.`
      );
      continue;
    }
    blocks.push(`### ${entry.name} — ${entry.match.join(', ')}\n${content}`);
  }

  if (!blocks.length) return '';
  return [
    scopedBlockHeading(segment),
    'The diff under review touches these modules. Each block applies ONLY to files under its paths.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/**
 * GS2-43 — the single composition point for one prompt segment, honouring the segment's
 * `prompts.<segment>` config:
 * - no setting → the segment's default-named file (`PROMPT_SEGMENT_FILES`), falling back
 *   to the bundled default unless `noDefaultPrompts` — exactly the pre-GS2-43 behaviour;
 * - a `string` → shorthand for `{ path }`;
 * - `enabled: false` → the segment is dropped entirely (returns `''`), even its bundled default;
 * - `path` + `mode: 'replace'` (default) → the file replaces the built-in segment content;
 * - `path` + `mode: 'append'` → the file content is appended after the built-in content.
 *
 * CFG-70 — and then the run's selected path-scoped overlays are appended, for every one of the
 * seven segments and therefore for every caller. This is the seam because it is the sole reader of
 * `config.prompts?.[segment]`: `readGuidelines`, `readReviewInstructions`, `readSystemPrompt`,
 * `readChatPrompt`, `readCodePrompt`, `readExecPrompt` and `readBackstory` are all thin wrappers,
 * so one edit here reaches `buildSystemMessages`, `getReviewPreamble` and the `gth get
 * system-prompt` introspection alike, with no site left to forget.
 *
 * **The scoped overlay survives `enabled: false`, deliberately.** A disabled root segment plus
 * matched scoped entries composes to the module blocks ALONE. Read against `enabled`'s own
 * docstring above — "the segment is dropped entirely" — that looks like a bug, and it is not:
 * `enabled` turns off the *repository-wide* segment, which is a coherent and useful monorepo
 * config alongside `prompts.paths` ("no guidelines for the repo, only per-module ones"). Honouring
 * it the other way would silently discard entries the user wrote explicitly, and force that user
 * to point `guidelines` at an empty file to express what they already expressed. Never discarding
 * configuration someone wrote on purpose is the principle the whole feature is built on.
 *
 * **`.filter(Boolean)` is load-bearing, not tidiness.** With no scoped entries selected — which is
 * every run today, and every run of a project that does not use the feature — all four branches
 * must compose byte-identically to what they composed before this existed. A plain
 * `[base, scoped].join('\n')` appends a trailing newline when `scoped` is empty; the filter is
 * what makes the unset path an exact identity rather than an almost-identity.
 */
export function readPromptSegment(segment: PromptSegmentName, config: PromptReadConfig): string {
  const setting = config.prompts?.[segment];
  const segmentConfig = typeof setting === 'string' ? { path: setting } : (setting ?? {});
  const readBuiltIn = () =>
    readPromptFile(PROMPT_SEGMENT_FILES[segment], config.identityProfile, config.noDefaultPrompts);
  const readBase = (): string => {
    if (segmentConfig.enabled === false) {
      return '';
    }
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
  };
  return [readBase(), composeScopedPromptSegment(segment, config)].filter(Boolean).join('\n');
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
        // CFG-70 — this list is the type-level statement of what the function reads, so a field
        // `readPromptSegment` now consults has to appear here or the type says it does not.
        | 'scopedPrompts'
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
 * GS2-79 — the SINGLE place a command's mode prompt is chosen, for every site that composes a
 * system prompt via {@link buildSystemMessages}: the agent and the subagent profiles.
 *
 * It exists because the selection used to be an inline three-branch ternary copied to each of
 * those sites, and a command missing from one copy is silently served the CHAT prompt — the
 * default branch — rather than failing. That is how `review`/`pr` came to compose the chat prompt
 * while the review instructions were smuggled in as a caller-side leading `SystemMessage`, which
 * Anthropic rejects outright ("System messages are only permitted as the first passed message").
 * One function means a new command is wired once, and `review`/`pr` cannot silently fall back to
 * chat again.
 *
 * `review`/`pr` resolve to the REVIEW INSTRUCTIONS (`.gsloth.review.md`), which is what makes a
 * review a review; every command without a mode prompt of its own keeps the chat prompt.
 */
export function readModePrompt(command: GthCommand | undefined, config: PromptReadConfig): string {
  switch (command) {
    case 'code':
      return readCodePrompt(config);
    case 'exec':
      return readExecPrompt(config);
    case 'review':
    case 'pr':
      return readReviewInstructions(config);
    default:
      return readChatPrompt(config);
  }
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
      // [[TUI-C111]] — a path keeps its END, so a deep tree's file names stay apart; a `paths`
      // array is cut per element before stringifying, and the line cap bounds the whole.
      if (isPathArgument(key)) {
        if (typeof value === 'string') return `${key}: ${truncatePathStart(value, 50)}`;
        if (Array.isArray(value)) {
          const paths = value.map((p) => (typeof p === 'string' ? truncatePathStart(p, 50) : p));
          return `${key}: ${JSON.stringify(paths)}`;
        }
      }
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
