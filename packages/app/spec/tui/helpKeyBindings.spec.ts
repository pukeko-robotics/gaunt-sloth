import { describe, expect, it } from 'vitest';
import {
  createCommandRegistry,
  dispatchSlashCommand,
  parseSlashCommand,
  type SlashCommandContext,
  type SlashCommandNotice,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import { TUI_HINT_SUFFIX, TUI_KEY_BINDINGS } from '#src/tui/keyBindings.js';

/**
 * TUI-C63 — `/help` advertises the keyboard of the surface the reader is looking at, and only that
 * one.
 *
 * The registry is shared with the readline `--no-tui` session (GS2-8), which has no Ink components,
 * no mouse layer and the terminal's own scrollback — so wheel, PgUp/PgDn, Ctrl+Home/Ctrl+End and
 * Ctrl+T are keys it does not have. The bindings therefore travel as DATA on the context rather
 * than as a constant inside `formatHelp`.
 *
 * The case that carries the weight is the readline one: it asserts that surface's `/help` is
 * exactly the command list, line for line. That is what fails the moment the section is hardcoded
 * into the shared formatter — a section that merely "appears in the TUI" would still appear there
 * if the seam were gone, so asserting only the TUI half would prove nothing.
 */

/** The readline surface's context: it supplies no bindings, because it has none to supply. */
const readlineCtx: SlashCommandContext = {
  mode: 'chat',
  modelDisplayName: 'gpt-5',
  turnCount: 0,
  toolsExpanded: false,
  debugVisible: false,
};

/** The full-screen TUI's context — the same session state plus the bindings `<App>` passes in. */
const tuiCtx: SlashCommandContext = { ...readlineCtx, keyBindings: TUI_KEY_BINDINGS };

const help = (ctx: SlashCommandContext, registry = createCommandRegistry()): SlashCommandNotice =>
  dispatchSlashCommand(parseSlashCommand('/help')!, registry, ctx).notice!;

/**
 * Keys that exist only on the full-screen surface — none may reach readline's `/help`.
 *
 * `\ then Enter` is the most surface-specific of them: readline's prompt is one `rl.question` in
 * cooked mode, with no continuation and no way to add one, so promising it there would describe a
 * key that does nothing.
 */
const TUI_ONLY_KEYS = ['PgUp', 'PgDn', 'Ctrl+Home', 'Ctrl+End', 'Ctrl+T', 'wheel', '\\ then Enter'];

/**
 * The sections `/help` offers on this surface, and how many bindings each holds — written out as a
 * LITERAL rather than derived from the table under test.
 *
 * Every other case here builds its expectation by iterating `TUI_KEY_BINDINGS`, so it can only prove
 * the table came out in the order it went in: delete a whole group, or add a binding nothing binds,
 * and they all stay green. Nothing can prove the table matches the handlers — only a reader can —
 * but this stops it eroding unnoticed. Changing the advertised keyboard means changing this list on
 * purpose, in the same commit.
 */
const EXPECTED_SECTIONS: readonly [title: string, bindings: number][] = [
  ['Scrolling the conversation (this window has no scrollback of its own)', 5],
  ['While the agent is working', 1],
  ['At the prompt', 15],
  ['Panels', 7],
  ['When a tool call asks for approval (the prompt shows these too)', 1],
  ['Always', 1],
];

describe('/help key bindings — one registry, two keyboards (TUI-C63)', () => {
  it('gives the two surfaces different help text from the SAME registry', () => {
    const registry = createCommandRegistry();
    const tui = help(tuiCtx, registry);
    const readline = help(readlineCtx, registry);

    expect(tui.lines).not.toEqual(readline.lines);
    expect(tui.lines.length).toBeGreaterThan(readline.lines.length);
    // Same registry in, so the command half is identical — only the surface's own keys differ.
    expect(tui.lines.slice(0, readline.lines.length)).toEqual(readline.lines);
  });

  it('gives readline EXACTLY the command list — no key section, hardcoded or otherwise', () => {
    const registry = createCommandRegistry();
    const readline = help(readlineCtx, registry);

    expect(readline.lines).toEqual(registry.map((c) => `/${c.name} — ${c.description}`));
    expect(readline.title).toBe('Slash commands');

    const text = readline.lines.join('\n');
    for (const key of TUI_ONLY_KEYS) expect(text.toLowerCase()).not.toContain(key.toLowerCase());
  });

  it('gives the TUI every key it binds, under the context that key is reachable in', () => {
    const tui = help(tuiCtx);
    const text = tui.lines.join('\n');

    expect(tui.title).toBe('Slash commands and keys');
    for (const key of TUI_ONLY_KEYS) expect(text.toLowerCase()).toContain(key.toLowerCase());

    // Grouped, not flat: every group's own title is a line, and each of its bindings is an indented
    // line beneath it. Read positionally, so a section that lost its grouping fails here.
    let previousGroupAt = -1;
    for (const group of TUI_KEY_BINDINGS) {
      const groupAt = tui.lines.indexOf(group.title);
      expect(groupAt).toBeGreaterThan(previousGroupAt);
      previousGroupAt = groupAt;
      expect(group.bindings.length).toBeGreaterThan(0);
      for (const binding of group.bindings) {
        expect(tui.lines.indexOf(`  ${binding.keys} — ${binding.description}`)).toBeGreaterThan(
          groupAt
        );
      }
    }
  });

  it('renders exactly the sections it is meant to: a lost or invented one fails here', () => {
    const lines = help(tuiCtx).lines;

    expect(TUI_KEY_BINDINGS.map((g) => [g.title, g.bindings.length])).toEqual(
      EXPECTED_SECTIONS.map((section) => [...section])
    );
    // Pinned against the RENDERED notice too, not only the data: a section that reaches the table
    // but not the reader is the same defect as one that was never there.
    for (const [title, count] of EXPECTED_SECTIONS) {
      expect(lines).toContain(title);
      const from = lines.indexOf(title) + 1;
      const rendered = lines.slice(from, from + count);
      expect(rendered.every((line) => line.startsWith('  '))).toBe(true);
      expect(lines[from + count] ?? '').not.toMatch(/^ {2}\S/);
    }
  });

  it('separates the commands from the keys with a row the screen actually draws', () => {
    const registry = createCommandRegistry();
    const lines = help(tuiCtx, registry).lines;

    // A SPACE, not the empty string: a sibling <Text> holding '' collapses to nothing in Ink's
    // column, so `''` here would be code claiming a gap the reader never sees. The formatter argues
    // that at length; this is what makes a later "tidy the empty string" edit fail instead of
    // silently deleting the blank row.
    expect(lines[registry.length]).toBe(' ');
    // Exactly one, and the keys begin immediately after it.
    expect(lines[registry.length + 1]).toBe(TUI_KEY_BINDINGS[0].title);
  });

  it('names the keys honestly: the Mac note is in /help, and Shift+wheel is qualified', () => {
    const lines = help(tuiCtx).lines;

    // TUI-C11 — PgUp/PgDn do not exist on Mac laptops and compact keyboards, which send the same
    // codes from Fn+↑/↓. The reference is where that is said; the hint row has no room for it.
    const paging = lines.find((line) => line.includes('PgUp / PgDn') && line.includes('a page'));
    expect(paging).toBeDefined();
    expect(paging).toContain('Fn+↑/↓');
    expect(TUI_HINT_SUFFIX).not.toContain('Fn');

    // Shift+wheel is measured to be inert wherever the terminal drops the modifier, so it is listed
    // with its condition rather than promised beside the keys that always work.
    const shiftWheel = lines.find((line) => line.includes('Shift+wheel'));
    expect(shiftWheel).toBeDefined();
    expect(shiftWheel).toContain('terminals that forward Shift');

    // The debug pane's search is a two-step loop and the listing has to say so: while the query is
    // being typed the pane is in an input mode that only Enter leaves, so `n` pressed straight after
    // the query extends the query rather than stepping a match. A line naming `/` and `n`/`N` with
    // no Enter between them prints a sequence that does not work.
    const paneSearch = lines.find((line) => line.includes('n / N'));
    expect(paneSearch).toBeDefined();
    expect(paneSearch).toContain('Enter');

    // Esc in the scrolling group carries its condition for the same reason: the reader of that
    // group is the one most likely to press it while a turn streams, where the first Esc aborts the
    // turn and only the second scrolls. Read alone — which is how a scanned line is read — an
    // unqualified entry invites exactly that keystroke.
    const escToBottom = lines.find(
      (line) => line.includes('Esc, or just start typing') && line.includes('newest output')
    );
    expect(escToBottom).toBeDefined();
    expect(escToBottom).toMatch(/while a turn runs/);

    // Focusing the debug panel needs three things, not the one that names it: the panel open, no
    // turn running, and the slash menu closed. A reader who presses Tab mid-turn or with the menu
    // open finds it inert, which is the same "listed key does nothing" defect in a state sessions
    // spend most of their time in. Substance, not prose — the conditions must be named, the
    // wording may change.
    const tabFocus = lines.find((line) => line.includes('debug panel') && line.includes('Tab'));
    expect(tabFocus).toBeDefined();
    expect(tabFocus).toMatch(/turn is running/);
    expect(tabFocus).toMatch(/menu is open/);

    // TUI-C25 — the prompt's ↑/↓ mean two different things, decided by whether the menu is open.
    // A line that names only one of them tells a reader in the other state that the key is broken.
    const promptArrows = lines.find((line) => line.includes('lines of the message'));
    expect(promptArrows).toBeDefined();
    expect(promptArrows).toContain('↑ / ↓');
    expect(promptArrows).toMatch(/menu/);

    // The one prompt binding a user cannot discover by pressing something: `\` is a character they
    // already type for other reasons, so it has to be listed or it does not exist.
    const continuation = lines.find((line) => line.includes('\\ then Enter'));
    expect(continuation).toBeDefined();
    expect(continuation).toMatch(/another line/);

    // Word motion ships in all three spellings terminals actually send, with no platform branch
    // anywhere — so the listing names both families rather than promising one of them.
    const wordMotion = lines.find((line) => line.includes('a word'));
    expect(wordMotion).toBeDefined();
    expect(wordMotion).toContain('Alt+←');
    expect(wordMotion).toContain('Ctrl+←');
  });

  it('keeps the hint fragment a fragment: it joins the shared row, and only mentions scrolling', () => {
    // Opens with the separator the shared exitMessage already uses between its own clauses, so the
    // row reads as one sentence rather than two glued strings.
    expect(TUI_HINT_SUFFIX.startsWith(' · ')).toBe(true);
    expect(TUI_HINT_SUFFIX).toContain('PgUp/PgDn');
    expect(TUI_HINT_SUFFIX).toContain('scroll');
    // A nudge, not a second reference: one separator, so one appended clause.
    expect(TUI_HINT_SUFFIX.split('·').length - 1).toBe(1);
  });
});
