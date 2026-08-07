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

/** Keys that exist only on the full-screen surface — none may reach readline's `/help`. */
const TUI_ONLY_KEYS = ['PgUp', 'PgDn', 'Ctrl+Home', 'Ctrl+End', 'Ctrl+T', 'wheel'];

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
