import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender, Text, useInput } from 'ink';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';
import { App } from '#src/tui/components/App.js';
import { createMouseStdin } from '#src/tui/mouseStdin.js';

/**
 * TUI-C62 — what the held-back bytes turn into, and that Escape survives being held back.
 *
 * Everything here is driven from raw byte sequences through the real stdin filter and the real Ink,
 * because a test built on a synthesised key object asserts a decoding no terminal produces and can
 * stay green while the product is broken. The first case is what Ink makes of a reassembled split
 * meta key; the rest are the other direction.
 *
 * The hold-back that stops a split `Option+↑` from cancelling a running turn sits in front of Ink,
 * which means every genuine Escape now passes through it too. The failure mode that would create is
 * not subtle and it is not partial: Escape simply stops working, and it has three separate jobs in
 * this app — so each job is asserted on its own against the real `<App>`.
 *
 * These cases let the real 100 ms elapse rather than driving a clock, and wait on the CONSEQUENCE
 * (`vi.waitFor`) rather than on a duration. The mechanism's timing — which byte is released when —
 * is pinned instant-by-instant in `mouseStdin.spec.ts`, where no React is in the way.
 */

/** A stdout that reports a terminal size, which `ink-testing-library`'s does not. */
class SizedStdout extends EventEmitter {
  frames: string[] = [];
  constructor(
    public columns: number,
    public rows: number
  ) {
    super();
  }
  write = (frame: string) => {
    this.frames.push(frame);
  };
  lastFrame = () => this.frames[this.frames.length - 1] ?? '';
}

/** The REAL stdin's stand-in: the filter's source, so writes here are bytes off a terminal. */
class FakeSource extends EventEmitter {
  isTTY = true;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  write = (data: string) => {
    this.emit('data', data);
  };
}

const KEY = {
  escape: '\x1b',
  pageUp: '\x1b[5~',
  /** Option+↑ on Terminal.app, split the way 6 of 7 presses actually arrive. */
  metaUpSplit: ['\x1b', '\x1b[A'],
  /** The interrupt byte. */
  ctrlC: '\x03',
};

const baseProps = {
  mode: 'chat',
  modelDisplayName: 'test-model',
  readyMessage: 'ready to chat',
  exitMessage: "Type 'exit' to leave",
};

/** A turn that streams once and then stays open until it is aborted. */
function blockingAgent(): { agent: TuiAgent; wasAborted: () => boolean } {
  let aborted = false;
  return {
    agent: {
      async *runTurn(_input, signal): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text', delta: 'streaming' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    },
    wasAborted: () => aborted,
  };
}

/** Eighty numbered rows in ONE answer — a transcript taller than the screen. */
const NUMBERED_ROWS = Array.from(
  { length: 80 },
  (_, i) => `numbered-row-${String(i + 1).padStart(3, '0')}`
);

const tallAgent: TuiAgent = {
  async *runTurn(): AsyncGenerator<AgentStreamEvent> {
    yield { type: 'text', delta: NUMBERED_ROWS.join('\n') };
  },
};

const idleAgent: TuiAgent = {
  async *runTurn(): AsyncGenerator<AgentStreamEvent> {},
};

/** Render `<App>` behind the real stdin filter, and hand back the bytes-in end of it. */
function renderBehindFilter(node: React.ReactElement) {
  const stdout = new SizedStdout(80, 24);
  const source = new FakeSource();
  const mouse = createMouseStdin(source as unknown as NodeJS.ReadStream, () => {});
  const instance = inkRender(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: mouse.stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    stdout,
    source,
    teardown: () => {
      instance.unmount();
      mouse.dispose();
    },
  };
}

/** Vitest's default `waitFor` window is 1 s, which a cold cell rendering 80 rows can miss. */
const RENDER_TIMEOUT_MS = 15_000;

describe('<App> behind the TUI-C62 escape hold-back', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('decodes a split Option+↑ as the meta-modified arrow, with no Escape alongside it', async () => {
    // The other half of the acceptance: the seam proves which BYTES leave the filter, and this
    // proves what Ink makes of them once they do. Asserted at a real `useInput` consumer, driven
    // from raw bytes — a key object synthesised by the test would be a decoding no terminal
    // produces, and would stay green while the product was broken.
    const seen: { input: string; key: Record<string, unknown> }[] = [];
    function KeyProbe() {
      useInput((input, key) => {
        seen.push({ input, key: { ...key } });
      });
      return <Text>probe</Text>;
    }
    const { source, teardown } = renderBehindFilter(<KeyProbe />);

    source.write(KEY.metaUpSplit[0]);
    source.write(KEY.metaUpSplit[1]);

    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: RENDER_TIMEOUT_MS });
    expect(seen[0].key).toMatchObject({ upArrow: true, meta: true });
    // The defect, stated as an absence: the leading half must never surface as the interrupt key.
    expect(seen.some((event) => event.key.escape === true)).toBe(false);

    teardown();
  }, 20_000);

  it('still aborts a running turn on Escape', async () => {
    // Escape's first meaning, and the one the hold-back is most likely to break: the key exists to
    // stop a turn, so a hold-back that lost it would leave the user with no way to interrupt.
    const pump = blockingAgent();
    const { stdout, source, teardown } = renderBehindFilter(
      <App {...baseProps} agent={pump.agent} initialMessage="go" />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('streaming'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    source.write(KEY.escape);

    await vi.waitFor(() => expect(pump.wasAborted()).toBe(true), { timeout: 5_000 });

    teardown();
  }, 20_000);

  it('still dismisses the slash-command menu on Escape', async () => {
    const { stdout, source, teardown } = renderBehindFilter(
      <App {...baseProps} agent={idleAgent} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready to chat'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    source.write('/');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('❯'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    source.write(KEY.escape);

    // The menu is gone and the `/` the user typed is still in the prompt — dismiss, not undo.
    await vi.waitFor(() => expect(stdout.lastFrame()).not.toContain('❯'), { timeout: 5_000 });
    expect(stdout.lastFrame()).toContain('> /');

    teardown();
  }, 20_000);

  it('still returns the transcript to the bottom on Escape when idle', async () => {
    const { stdout, source, teardown } = renderBehindFilter(
      <App {...baseProps} agent={tallAgent} initialMessage="go" />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('numbered-row-080'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    source.write(KEY.pageUp);
    // Control: the page really moved the view, so "back at the bottom" below says something.
    await vi.waitFor(() => expect(stdout.lastFrame()).not.toContain('numbered-row-080'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    source.write(KEY.escape);

    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('numbered-row-080'), {
      timeout: 5_000,
    });

    teardown();
  }, 20_000);

  /**
   * TUI-C77's residual, stated as a test rather than only as a comment.
   *
   * `<App>` claims Ctrl+C on Ink's OWN predicate — `key.ctrl && input === 'c'` — so the set of
   * keystrokes the ladder claims is exactly the set Ink used to swallow. A Ctrl+C released together
   * with a held-back Escape reaches Ink as `ESC ^C`, which parses as `{name: '', ctrl: false}`; the
   * `input` only becomes `'\x03'` after `use-input` strips the escape prefix, and `key.ctrl` is
   * false throughout. So it does not match, and `mouseStdin.ts` says so in as many words.
   *
   * **What the difference is observable AS, which is not what it first looks like.** Widening the
   * predicate to `input === '\x03' || …`, the obvious tidy-up for a future reader, does not change
   * whether the session exits: it changes whether **rung 1 fires**, and a user who types a message
   * and presses Escape then Ctrl+C within the hold window loses it. That is why this case is built
   * around a draft rather than around the exit, and why the assertion below is the draft.
   *
   * The draft is asserted CHARACTER-EXACT (TUI-C51). The merged event arrives with no modifier set,
   * so `<PromptEditor>`'s insert branch used to take it and splice `\x03` into the message — an
   * invisible byte in what the user is writing, which a `toContain` on the visible text could not
   * see. The shared `isTypedText` guard refuses control characters whatever the modifiers claim, so
   * the residual now reaches no buffer at all, and the letter typed after it lands flush against
   * what came before.
   */
  it('is not the interrupt key when the Ctrl+C is released with a held-back Escape', async () => {
    const onExit = vi.fn();
    const pump = blockingAgent();
    const { stdout, source, teardown } = renderBehindFilter(
      <App {...baseProps} agent={pump.agent} onExit={onExit} initialMessage="go" />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('streaming'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    // The prompt stays mounted while a turn streams (EXT-12), so all three rungs are live at once
    // and one case can say the merged form fires none of them.
    source.write('a draft worth keeping');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> a draft worth keeping'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    // Same tick, so the filter hands Ink one chunk — the residual's exact shape.
    source.write(KEY.escape);
    source.write(KEY.ctrlC);

    // "Nothing happened" again waits on a POSITIVE consequence ordered after it in the same stream.
    source.write('z');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('z'), { timeout: 5_000 });

    // Rung 1 did not fire — the draft is still there, and nothing of the merged key is in it: the
    // `z` sits directly against the message, which `a draft worth keeping\x03z` would not.
    expect(stdout.lastFrame()).toContain('> a draft worth keepingz');
    // …nor rung 2, nor rung 3.
    expect(pump.wasAborted()).toBe(false);
    expect(onExit).not.toHaveBeenCalled();

    teardown();
  }, 20_000);

  it('is the interrupt key when the Ctrl+C arrives on its own', async () => {
    // The control the case above needs: without it, a filter that dropped the byte entirely — or an
    // <App> that never claimed it — would satisfy those assertions just as well.
    const onExit = vi.fn();
    const { stdout, source, teardown } = renderBehindFilter(
      <App {...baseProps} agent={idleAgent} onExit={onExit} />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('ready to chat'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    source.write(KEY.ctrlC);

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1), { timeout: 5_000 });

    teardown();
  }, 20_000);

  it('does not abort a running turn when Option+↑ arrives in two reads', async () => {
    // The defect, stated end to end. Two writes on separate ticks are how a terminal delivers a
    // split meta key; whether they are far enough apart to defeat Ink's OWN reassembly is a matter
    // of scheduling, so the discriminating form of this case — which bytes leave the filter, and
    // when — is asserted at the seam in `mouseStdin.spec.ts`. What this one holds is the whole
    // path: the halves reach `<App>` as the meta-modified arrow, and no Escape is manufactured
    // along the way.
    const pump = blockingAgent();
    const { stdout, source, teardown } = renderBehindFilter(
      <App {...baseProps} agent={pump.agent} initialMessage="go" />
    );
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('streaming'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    source.write(KEY.metaUpSplit[0]);
    source.write(KEY.metaUpSplit[1]);

    // "Nothing happened" is not something a test can wait for, so wait on a POSITIVE consequence
    // ordered AFTER it in the same stream: stdin is processed in order, so once this letter is on
    // screen the split key has already been through the whole path.
    source.write('z');
    await vi.waitFor(() => expect(stdout.lastFrame()).toContain('> z'), {
      timeout: RENDER_TIMEOUT_MS,
    });

    expect(pump.wasAborted()).toBe(false);
    // Nothing of the split key was typed into the prompt either.
    expect(stdout.lastFrame()).not.toContain('[A');

    teardown();
  }, 20_000);
});
