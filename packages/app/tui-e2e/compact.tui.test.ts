import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import { settleSessionsAfterEach } from './fixtures/tmpHome.mjs';

// [[GS2-20]] — see chat.tui.test.ts: settle each session before the throwaway directories go.
settleSessionsAfterEach(test);

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

/** Same construction as chat.tui.test.ts: `CI` deleted, not blanked, so Ink paints a real frame. */
const envFor = (fixtureName: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
  return env;
};

/**
 * GS2-23 — `/compact` end to end in the real TUI: parse → dispatch → the awaited effect → the
 * notice on screen. The fixture agent keeps the conversation its replayed turns would have left
 * in a graph and folds it with the REAL `compactMessages` (only the summary text is canned), so
 * the numbers below are the cut rule's numbers: three greeting turns are twelve messages, the
 * last six begin on a tool result, and the tail widens to that result's call — five folded, seven
 * kept.
 */
test.describe('gth chat TUI — /compact (greeting fixture, GS2-23)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('greeting.json'),
    columns: 120,
    rows: 40,
  });

  test('on a fresh session it reports nothing to compact and changes nothing', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('/compact');
    await expect(terminal.getByText('> /compact')).toBeVisible();
    terminal.submit();

    await expect(terminal.getByText('Nothing to compact')).toBeVisible();
    await expect(terminal.getByText('Nothing was changed.')).toBeVisible();
    // The command never became a turn, and never left the prompt busy.
    await expect(terminal.getByText('chat  ·  turns: 0  ·  ready')).toBeVisible();
  });

  test('after three turns it folds the older ones and reports what changed', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    for (const [index, prompt] of ['first', 'second', 'third'].entries()) {
      terminal.write(prompt);
      terminal.submit();
      await expect(terminal.getByText(`chat  ·  turns: ${index + 1}  ·  ready`)).toBeVisible();
    }

    terminal.write('/compact the readme');
    await expect(terminal.getByText('> /compact the readme')).toBeVisible();
    terminal.submit();

    await expect(terminal.getByText('Conversation compacted')).toBeVisible();
    await expect(terminal.getByText('Folded 5 older messages into a summary')).toBeVisible();
    await expect(terminal.getByText('Model context: 12 messages')).toBeVisible();
    await expect(terminal.getByText('Summary focus: the readme')).toBeVisible();
    await expect(terminal.getByText('The transcript on screen is unchanged')).toBeVisible();
    // The turn counter is untouched — the screen's record was not the thing compacted.
    await expect(terminal.getByText('chat  ·  turns: 3  ·  ready')).toBeVisible();
  });
});
