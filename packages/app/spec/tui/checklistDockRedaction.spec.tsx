import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import {
  resetToolDisplaySecretsCacheForTests,
  setToolDisplayConfig,
} from '@gaunt-sloth/core/core/toolDisplay.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';
import { CHECKLIST_TOOL_NAME } from '#src/tui/viewModel.js';

/**
 * REL-19 — the pinned checklist panel redacts secrets, like every other rendered surface.
 *
 * The case has to go through `<App>`, for the reason REL-18's neutralisation spec records: the
 * checklist tool call draws NOTHING inside the turn (`drawsNothing` returns true for it and
 * `displaySegments` drops the segment), so a spec rendering it inside a `LiveTurn` asserts on a
 * panel that was never mounted; and the treatment sits on `parseChecklistArgs`, the function that
 * PRODUCES the rows, so mounting `ChecklistPanel` with hand-built items would bypass the very code
 * under test.
 *
 * **No payload here is a real key.** Both are synthetic, and every assertion is on the redacted
 * form or on the absence of a synthetic fragment — never on a secret read from the environment.
 */

/** A fake agent that replays a fixed event script for each turn (mirrors REL-18's spec). */
function scriptedAgent(events: AgentStreamEvent[]): TuiAgent {
  return {
    async *runTurn() {
      for (const event of events) {
        yield event;
        await Promise.resolve();
      }
    },
  };
}

const baseProps = {
  mode: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' to leave chat · /help for commands\n",
};

/** One checklist call carrying `content` as its single in-progress row. */
function checklistEvents(content: string): AgentStreamEvent[] {
  return [
    { type: 'tool_start', id: 'c1', name: CHECKLIST_TOOL_NAME },
    {
      type: 'tool_args',
      id: 'c1',
      delta: JSON.stringify({ items: [{ content, status: 'in_progress' }] }),
    },
    { type: 'tool_end', id: 'c1' },
  ];
}

/** Render the checklist and return the frame with Ink's own colour stripped. */
async function checklistFrame(content: string): Promise<{ visible: string; unmount: () => void }> {
  const agent = scriptedAgent(checklistEvents(content));
  const { lastFrame, unmount } = render(<App {...baseProps} agent={agent} initialMessage="go" />);
  await vi.waitFor(() => expect(stripAnsi(lastFrame() ?? '')).toContain('Checklist'));
  return { visible: stripAnsi(lastFrame() ?? ''), unmount };
}

/**
 * Written with `String.fromCharCode` rather than pasted, so the byte cannot go unnoticed in a diff.
 * BEL is `\p{Cc}`, so the neutraliser rewrites it to the printable escape `\x07`.
 */
const BEL = String.fromCharCode(7);

/**
 * A provider-key-SHAPED literal, obviously synthetic: it matches `\bsk-[A-Za-z0-9_-]{16,}` and
 * nothing else about it is a key.
 */
const PROVIDER_SHAPED = 'sk-EXAMPLEONLYnotarealkey0000000';

/**
 * The ordering control's payload: a **configured literal** secret carrying a control character.
 *
 * This shape, and only this shape, can tell the two orderings apart. `redactText` has two halves
 * and the provider patterns above are NOT order-sensitive — they anchor on printable ASCII that
 * neutralisation leaves untouched, so an `sk-…` payload redacts whichever side of the neutraliser
 * the call sits on, and a control built on one would be an assertion that cannot fail. A literal
 * harvested by `collectSecretValues` is matched VERBATIM, so the instant the BEL inside it becomes
 * `\x07` the match is gone.
 */
const CONFIGURED_SECRET = `plan${BEL}literal-secret`;

/**
 * Registered as an INLINE config secret (technique 1b) rather than an env var, because that is the
 * half of the harvest that only core can see: the config reaches `collectSecretValues` through
 * `setToolDisplayConfig`, which the agent runner calls into core. A redactor harvesting its own
 * secrets in the app layer would miss exactly this value.
 */
const CONFIG_WITH_INLINE_SECRET = { llm: { apiKey: CONFIGURED_SECRET } };

describe('REL-19 — the pinned checklist panel redacts secrets in the model’s item text', () => {
  beforeEach(() => {
    // Drop anything an earlier spec in this worker registered: a leaked literal could make a
    // redaction assertion here pass for a reason that has nothing to do with this code.
    resetToolDisplaySecretsCacheForTests();
  });

  afterEach(() => {
    resetToolDisplaySecretsCacheForTests();
  });

  it('redacts a provider-key-shaped literal in a checklist row', async () => {
    const { visible, unmount } = await checklistFrame(`rotate ${PROVIDER_SHAPED} now`);
    try {
      // The panel actually painted, and painted THIS row. Without these anchors the negative
      // assertion below would pass just as well against a dock that never mounted the checklist.
      expect(visible).toContain('Checklist (0/1)');
      expect(visible).toContain('rotate');
      expect(visible).toContain('now');

      // The key is gone and the row still reads — the marker replaces the value in place.
      expect(visible).toContain('rotate <redacted> now');
      expect(visible).not.toContain('EXAMPLEONLY'); // no leaked head or tail of the payload
    } finally {
      unmount();
    }
  });

  it('redacts a configured literal secret BEFORE neutralisation rewrites its control character', async () => {
    setToolDisplayConfig(CONFIG_WITH_INLINE_SECRET);
    const { visible, unmount } = await checklistFrame(`note ${CONFIGURED_SECRET} here`);
    try {
      expect(visible).toContain('Checklist (0/1)');
      expect(visible).toContain('note');
      expect(visible).toContain('here');

      // Redaction ran on the RAW string, so the literal still matched and the whole value became
      // the marker. Move the redaction after the neutralisation and every assertion below fails:
      // the BEL is rewritten first, the literal no longer matches, no provider pattern covers this
      // payload, and the secret paints onto the panel as `plan\x07literal-secret`.
      expect(visible).toContain('note <redacted> here');
      expect(visible).not.toContain('literal-secret');
      expect(visible).not.toContain('\\x07'); // the escaped BEL only appears if the value survived
    } finally {
      unmount();
    }
  });
});
