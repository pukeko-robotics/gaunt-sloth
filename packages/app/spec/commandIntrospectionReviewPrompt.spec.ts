import { describe, expect, it } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

/**
 * GS2-79 — `gth get system-prompt review|pr` must report what a review run actually sends.
 *
 * Introspection composing the review prompt its own way is how the two came to disagree: while the
 * agent backends composed the CHAT prompt for `review`/`pr`, this function was the only place the
 * review instructions appeared at all, and it kept reporting them — so the introspection output
 * looked right for the whole window in which the model was getting something else.
 *
 * The assertion is an equality against the SHARED composition (`buildSystemMessages` +
 * `readModePrompt`, the same two functions the agent calls), with the real prompt readers. It
 * carries no literal of its own, so it cannot agree with the code about a wrong one.
 */
describe('review/pr system-prompt introspection (GS2-79)', () => {
  const config = {} as GthConfig;

  it.each(['review', 'pr'] as const)(
    'reports exactly what the agent composes for %s',
    async (command) => {
      const { buildSystemMessages, readModePrompt, readReviewInstructions, readChatPrompt } =
        await import('@gaunt-sloth/core/utils/llmUtils.js');
      const { getCommandSystemPrompt } = await import('#src/commands/commandIntrospection.js');

      const expected = buildSystemMessages(config, readModePrompt(command, config))[0]?.content;
      expect(typeof expected).toBe('string');
      expect((expected as string).length).toBeGreaterThan(0);

      const reported = getCommandSystemPrompt(command, config);
      expect(reported).toBe(expected);
      // Named directly as well, so a reader that returned the wrong segment in BOTH places (and so
      // still satisfied the equality) is caught.
      expect(reported).toContain(readReviewInstructions(config));
      expect(reported).not.toContain(readChatPrompt(config));
    }
  );

  it('still reports the chat prompt for chat, and the code prompt for code', async () => {
    const { readChatPrompt, readCodePrompt, readReviewInstructions } =
      await import('@gaunt-sloth/core/utils/llmUtils.js');
    const { getCommandSystemPrompt } = await import('#src/commands/commandIntrospection.js');

    expect(getCommandSystemPrompt('chat', config)).toContain(readChatPrompt(config));
    expect(getCommandSystemPrompt('chat', config)).not.toContain(readReviewInstructions(config));
    expect(getCommandSystemPrompt('code', config)).toContain(readCodePrompt(config));
    expect(getCommandSystemPrompt('code', config)).not.toContain(readReviewInstructions(config));
  });
});
