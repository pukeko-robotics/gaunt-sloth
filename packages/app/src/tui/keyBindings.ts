/**
 * TUI-C63 — what the full-screen surface advertises about its own keyboard.
 *
 * Two pieces of copy live here, and they are here rather than in the shared slash-command layer or
 * in the shared `exitMessage` for the same reason: **only this surface has these keys.** The
 * registry (`@gaunt-sloth/agent/modules/slashCommands.js`) and the hint string are both shared with
 * the readline `--no-tui` session, which keeps the terminal's own scrollback, mounts no Ink
 * components and has no mouse layer — so wheel, PgUp/PgDn, Ctrl+Home/Ctrl+End and Ctrl+T are keys it
 * does not have. Keeping the copy on this side of the seam makes readline's output unchanged **by
 * construction** rather than by anyone remembering (GS2-87: divergence is deliberate and stated).
 *
 * The bindings are the ones the code actually binds — `<App>`'s `useInput` and wheel subscription,
 * and `<PromptInput>`'s menu handler. Adding an entry here does not add a binding; it promises one.
 */

import type { KeyBindingGroup } from '@gaunt-sloth/agent/modules/slashCommands.js';

/**
 * The scroll fragment this surface appends to the shared hint row.
 *
 * The row is a nudge, not the reference: it names the two keys that answer "where did my scrollback
 * go?", and `/help` carries the honest detail (the Mac/compact-keyboard note, the wheel, the
 * start/end keys) that a single dim line has no room for. It opens with the same `·` separator the
 * shared `exitMessage` already uses between its own clauses, so the row reads as one sentence
 * whichever command supplied the first half.
 */
export const TUI_HINT_SUFFIX = ' · PgUp/PgDn to scroll history';

/**
 * The key bindings `/help` lists on this surface, grouped by the context each is reachable in.
 *
 * Grouped, not flat, because the bindings are modal: `Esc` alone aborts a running turn, leaves the
 * focused debug panel, dismisses the slash menu, or returns to the newest output, decided by what
 * owns the keyboard at the time. A flat list would state four contradictory things about one key.
 *
 * `Shift+wheel` is listed with its condition rather than beside the keys that always work: the
 * binding is correct (measured at exactly one page in a pty), but a terminal that never sets the
 * Shift bit on a wheel report delivers a plain notch instead, so on those the promise is false.
 */
export const TUI_KEY_BINDINGS: readonly KeyBindingGroup[] = [
  {
    title: 'Scrolling the conversation (this window has no scrollback of its own)',
    bindings: [
      {
        keys: 'PgUp / PgDn',
        description: 'a page (Fn+↑/↓ on Mac and compact keyboards sends the same codes)',
      },
      { keys: 'Ctrl+Home / Ctrl+End', description: 'the start of the session / the newest output' },
      { keys: 'Wheel', description: 'three lines a notch, while the mouse is on (see /mouse)' },
      {
        keys: 'Shift+wheel',
        description: 'a page, in terminals that forward Shift with the wheel — some never do',
      },
      { keys: 'Esc, or just start typing', description: 'back to the newest output' },
    ],
  },
  {
    title: 'While the agent is working',
    bindings: [{ keys: 'Esc', description: 'stop the turn' }],
  },
  {
    title: 'At the prompt',
    bindings: [
      { keys: '/', description: 'open the slash-command menu' },
      { keys: '↑ / ↓', description: 'move through the open menu' },
      { keys: 'Tab', description: 'complete the highlighted command' },
      { keys: 'Esc', description: 'dismiss the menu' },
    ],
  },
  {
    title: 'Panels',
    bindings: [
      {
        keys: 'Ctrl+T',
        description: 'fold and unfold tool output and thinking (same as /verbose)',
      },
      { keys: 'Tab', description: 'focus the debug panel while it is open (see /debug)' },
      { keys: 'Tab / Shift+Tab', description: 'in the focused panel: next / previous view' },
      { keys: '↑ / ↓, PgUp / PgDn', description: 'in the focused panel: a line, a page' },
      {
        keys: '/, then n / N',
        description: 'in the focused panel: search it, then next / previous match',
      },
      { keys: 'm', description: 'in the focused panel: maximise it, and back' },
      { keys: 'Esc', description: 'leave the focused panel (first Esc clears an active search)' },
    ],
  },
  {
    // One line rather than the prompt's own legend repeated: the prompt paints these keys on screen
    // the moment they apply, and it owns the keyboard until answered — so `/help` cannot even be
    // reached from there.
    title: 'When a tool call asks for approval (the prompt shows these too)',
    bindings: [
      {
        keys: 'o / s / a, or anything else',
        description: 'approve once / this session / always, or reject',
      },
    ],
  },
  {
    title: 'Always',
    bindings: [{ keys: 'Ctrl+C', description: 'exit (so do the exit keyword, /exit and /quit)' }],
  },
];
