import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { PromptEditor } from '#src/tui/components/PromptEditor.js';
import { SlashCommandMenu } from '#src/tui/components/SlashCommandMenu.js';
import {
  filterSlashCommands,
  slashMenuQuery,
  type SlashCommand,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import {
  createEditorState,
  insertText,
  killAll,
  pressEnter,
  type EditorState,
  type KillResult,
} from '#src/tui/lineEditor.js';
import { normalizePastedText } from '#src/tui/pasteParser.js';
import { isTypedText, opensCommandMenu, typedText } from '#src/tui/keyGuards.js';

/** The prompt buffer, with the monotonic serial of the edits that produced it. */
interface PromptBuffer {
  readonly state: EditorState;
  readonly edits: number;
}

/**
 * TUI-C51 — the draft-preserving command menu, while it is open. `null` is closed.
 *
 * Its `query` is the whole reason this state exists: the typed menu (TUI-C10) filters on the
 * PROMPT buffer, so it can only open on a buffer that begins with `/` and holds no space. This one
 * carries its own, which is what lets the menu open over half a composed message.
 */
interface CommandMenu {
  /** What has been typed into the MENU — never into the message. */
  readonly query: string;
  /** The highlighted row, reset to the most relevant match whenever the query changes. */
  readonly index: number;
  /**
   * Whether anything has reached this query yet — what arms the one leading-slash strip.
   *
   * `false` holds only between the chord opening the menu and the first input it takes, which is
   * what bounds the strip at one. An empty query is not the same question and cannot stand in for
   * it: the swallowed slash LEAVES the query empty, so a strip keyed on emptiness re-arms itself
   * on every slash and is unbounded. See {@link extendCommandMenuQuery}.
   */
  readonly started: boolean;
}

/**
 * The menu query's prefix, deliberately as wide as `<PromptEditor>`'s `  > `.
 *
 * The query is not in the message, so it needs a row of its own or the user is typing somewhere
 * they cannot see (DL-4). It is drawn directly above the prompt, below the matches, so the three
 * read downwards as one block: what matches, what you typed, what you were writing.
 */
const COMMAND_MENU_PREFIX = '  / ';

/**
 * TUI-C95 — the chord menu's query after `typed` is added to what it already held.
 *
 * **A leading `/` is tolerated where the user would put one, and nowhere else.** Command names are
 * stored without the slash, so a query still carrying one matches nothing — and to a user who
 * learned the commands as `/help` the character they typed looks exactly like part of the name they
 * are looking for, which leaves an empty list with nothing on screen to explain it. The chord menu
 * is right not to REQUIRE the slash — reaching it over a half-written message is the whole point —
 * so the slash is dropped rather than demanded, and the two doors take the same spelling.
 *
 * **The normalisation belongs here, at the storing boundary, and not in `filterSlashCommands`.**
 * That filter is shared with the typed door, which already strips the slash on the way in
 * (`slashMenuQuery`); a second strip inside it would state the same rule twice and let the two
 * drift. Storing-side also settles the rendered query row, which draws its own `/ ` prefix
 * ({@link COMMAND_MENU_PREFIX}) and would otherwise read `/ /help`.
 *
 * **What arrives is an event's text, not a keystroke**, which is why the strip is applied to the
 * whole of it: with bracketed-paste mode off a pasted `/help` lands as one call carrying the
 * whole string, and a fix that swallowed a lone `/` key would miss it entirely.
 *
 * **Exactly one slash, and only as the first thing that reaches a freshly opened menu** —
 * `started`, not an empty query, is what says so. One slash is what a user means; a second is not a
 * spelling of anything, and the typed door refuses `//help` outright as a path rather than a
 * command, so a chord door that dispatched it would give two doors opposite answers for the same
 * six characters. Keying the strip on emptiness instead is what makes that happen: a swallowed
 * slash leaves the query empty, so the strip re-arms and `//help` typed one key at a time collapses
 * to `help` while the same string pasted keeps its second slash. Anywhere after the first input —
 * a query with characters in it, or one backspaced empty again — a `/` is ordinary query text and
 * matches nothing, which is the honest answer.
 */
function extendCommandMenuQuery(current: string, typed: string, started: boolean): string {
  if (started) return current + typed;
  return typed.startsWith('/') ? typed.slice(1) : typed;
}

/**
 * What `<App>` may ask of a mounted prompt (TUI-C79) — the imperative half of the Ctrl+C ladder.
 *
 * `<App>` arbitrates Ctrl+C because Ink broadcasts a keypress to every `useInput` subscriber with no
 * way to stop propagation, so exactly one handler may own a key with more than one meaning — and it
 * has to be the one that is always mounted, since this component is not (a pending approval, an
 * attack banner, the approvals picker and the focused debug pane each replace it). The buffer and
 * the kill slot live HERE, though, so the rung that clears a draft is asked for rather than reached
 * into: `<App>` holds the handle only while the prompt is mounted, and gets `false` when it is not.
 */
export interface PromptInputHandle {
  /**
   * Scrap the whole draft, into the kill slot — Ctrl+C's first rung.
   *
   * Returns whether there was anything to scrap, which is what tells `<App>` the keystroke was
   * spent here and must not fall through to stopping the turn or leaving the session. The cleared
   * text goes to the same one slot the editor's killing verbs feed, so `Ctrl+Y` puts it back: this
   * key is a reflex, it can arrive on a message that took minutes to write, and the prompt has no
   * undo of its own.
   */
  clearToKillSlot(): boolean;
}

/**
 * TUI-C51 — where a draft waits while this component does not exist, or `null` for "nothing is
 * waiting".
 *
 * A restored draft is written into this component's own state, which is only sound while it is
 * still mounted afterwards — and dispatching a command is one of the things that unmounts it. The
 * prompt stands down for a pending approval, the attack banner, the focused debug pane and the
 * `/approvals` picker, and that last one is opened BY a command the menu dispatches: `/approvals`
 * is the very command the mid-turn notice offers as its example. So the snapshot is handed to a
 * slot that outlives the unmount — held by `<App>`, which is always mounted — and the next mount
 * takes it back. Everything else about the buffer stays here; this carries one message across one
 * remount and nothing more.
 */
export type PromptDraftCarry = React.MutableRefObject<EditorState | null>;

/**
 * The user prompt line. Mirrors the readline `  > ` prompt. Clears on submit; the parent
 * hides it while a turn is running so Ink owns stdin uncontended during streaming.
 *
 * The buffer and caret live here as an {@link import('#src/tui/lineEditor.js').EditorState} and are
 * rendered and driven by `<PromptEditor>` (TUI-C25), which owns the keyboard for everything that
 * edits text. This component owns what the buffer *means*: the slash menu it may open, the
 * submission it becomes — including what Enter means, which is decided against the authoritative
 * buffer so that it reads the text its predecessors in the same stdin chunk produced — and the
 * one-slot kill store the editor's killing verbs feed and `Ctrl+Y` reads back (`killRef` below).
 *
 * TUI-C10 — while the user is typing a bare slash command (input starts with `/`, no space yet),
 * a discovery menu of the matching registered commands appears just above the prompt. The registry
 * (`commands`) is the single source, so extension-registered commands show automatically. Arrow
 * keys move the highlight, Tab completes the highlighted name, Enter dispatches it, Esc dismisses
 * the menu. The keyboard split is stated in one place and honoured on both sides of it: while the
 * menu is open `<PromptEditor>` stands down from Up/Down and Enter (its `menuActive` prop) and this
 * component's `useInput` claims them, so no key is handled twice. A fully-typed command still
 * dispatches exactly as before (Enter with the menu open submits the highlighted command, which
 * equals what was typed).
 *
 * A buffer with a newline in it never opens the menu, and does not need a guard of its own to stop
 * it: `slashMenuQuery` matches `/` followed by non-whitespace to the end of the input, and `\n` is
 * whitespace — so a continued or pasted multi-line entry beginning with `/` is not a command query.
 *
 * TUI-C51 — **the same menu, reachable over an unfinished message: `Ctrl+G` (or `Ctrl+/`).** The
 * menu above filters on the prompt buffer itself, so with `please refactor the fo` typed there is no
 * way to reach it at all: the buffer neither starts with `/` nor is expendable. The chord opens the
 * menu in a mode whose query lives in its own state ({@link CommandMenu}), so the message is neither
 * read nor written — it stays on screen, unchanged, caret where it was, while the user filters and
 * dispatches above it. `Esc` closes the menu and leaves it exactly as it was.
 *
 * **The message is captured and put back across the dispatch**, rather than the dispatch being
 * taught not to disturb it: the command goes out through the same `submit` the typed menu uses, so
 * `<App>` cannot tell the two paths apart and every mid-turn rule it already applies keeps applying
 * unchanged. What differs is only what this component does afterwards, which is give the draft back
 * — and it gives it back even when the command replaced this prompt with something else while it
 * ran, which `/approvals` does (see {@link PromptDraftCarry}).
 *
 * **The menu neither requires the leading `/` nor refuses it** — a query typed as `/help` filters
 * exactly as `help` does, and a query PASTED while the menu is open is filtered by rather than
 * spliced into the message.
 *
 * **The chord OPENS the menu; it never closes it.** A toggle would make an even number of presses
 * indistinguishable from none — a shape this input family has twice made a test pass on a broken
 * tree (TUI-C58) — and `Esc` already closes it.
 *
 * **It is not gated on a turn running.** `Ctrl+T` is, because Ink broadcasts every keypress to every
 * `useInput` subscriber with no way to stop propagation; here filtering IS the mechanism and there
 * is nothing to swallow, and working idle with a draft in the buffer is the whole point.
 *
 * TUI-C24 — multiline paste. `usePaste` puts the terminal into bracketed-paste mode (`\x1b[?2004h`)
 * while the prompt is mounted and disables it on unmount, and Ink delivers the pasted text on a
 * channel separate from `useInput` — so an embedded newline in a pasted burst is never read as
 * Enter and can never submit the turn mid-paste. The normalized paste (CRLF/CR → `\n`) is inserted
 * at the caret without submitting; a subsequent explicit Enter submits the whole multi-line value.
 * While the chord's menu is open the paste goes to the MENU's query instead, for the same reason
 * every other key does.
 */
export function PromptInput({
  onSubmit,
  commands = [],
  onMenuStateChange,
  handleRef,
  draftCarryRef,
}: {
  onSubmit: (value: string) => void;
  /** The slash-command registry (App builds it once) — the menu's single source of truth. */
  commands?: SlashCommand[];
  /** Notifies the parent whether the menu currently owns navigation keys (so App can stand down
   *  its own Tab handler while the menu is open). */
  onMenuStateChange?: (active: boolean) => void;
  /** TUI-C79 — where to publish this prompt's {@link PromptInputHandle} while it is mounted, so
   *  `<App>`'s Ctrl+C ladder can ask the buffer to clear itself (and is told when there is none). */
  handleRef?: React.MutableRefObject<PromptInputHandle | null>;
  /** TUI-C51 — the slot a draft waits in across a remount; see {@link PromptDraftCarry}. */
  draftCarryRef?: PromptDraftCarry;
}): React.ReactElement {
  /**
   * The buffer and its edit serial — authoritative in a REF, mirrored into state for rendering.
   *
   * A keystroke is not delivered alone: Ink splits one stdin chunk into several key events and
   * dispatches them synchronously, so a handler that computes from the rendered value computes from
   * the text as it stood before its predecessors in that chunk. Holding a Backspace is exactly that
   * shape — Ink splits repeated backspace bytes into separate events precisely *because* holding the
   * key sends them in one chunk. A ref is written and read synchronously, so each keystroke sees
   * what the one before it did, and `onSubmit` can still be called straight from the handler that
   * decided on it (which a `setState` updater, being pure, could not do). It is the same
   * ref-plus-mirror shape `<App>` uses for its own keystroke-driven text buffers.
   *
   * `edits` counts only the updates that CHANGED the text, and it is the key the menu's transient
   * bookkeeping hangs on. Keying that bookkeeping on the text itself is the obvious thing and it is
   * wrong: an Esc-dismissal or a stale highlight resurrects the moment an edit returns the buffer to
   * a value it has already held — a Backspace back to the previous query, or the same query typed
   * again in a later message. A serial never repeats, so the bookkeeping is invalidated by any edit
   * and by nothing else; a bare caret move leaves it alone, which is what lets Esc survive an arrow.
   */
  const [buffer, setBuffer] = useState<PromptBuffer>(() => ({
    state: createEditorState(),
    edits: 0,
  }));
  const bufferRef = useRef(buffer);
  const state = buffer.state;

  /** Make `next` the buffer: authoritative immediately, on screen at the next render. */
  const commitBuffer = (next: PromptBuffer): void => {
    bufferRef.current = next;
    setBuffer(next);
  };

  /**
   * Commit `next` as the successor of `previous`, counting it as an edit only if it changed the
   * text. Shared by every keystroke that produces a new buffer, so that what *counts* as an edit is
   * decided in one place: an edit and a kill that answered that question differently would drift the
   * serial the menu's bookkeeping hangs on.
   */
  const commit = (previous: PromptBuffer, next: EditorState): void => {
    commitBuffer({
      state: next,
      edits: next.value === previous.state.value ? previous.edits : previous.edits + 1,
    });
  };

  /** Apply one edit or motion, counting it as an edit only if it changed the text. */
  const applyEdit = (update: (previous: EditorState) => EditorState): void => {
    const previous = bufferRef.current;
    commit(previous, update(previous.state));
  };

  /**
   * The one-slot kill store: the text the most recent killing verb removed (TUI-C79).
   *
   * It sits here, beside the buffer, for the same reason the buffer does — `<PromptEditor>` is
   * controlled and stores nothing, and it is unmounted in several app states, while module scope in
   * `lineEditor.ts` would share one slot across every render tree. Nothing renders it, so a plain
   * ref is the whole of it; it is written and read in the same synchronous handler the buffer is.
   *
   * ONE slot, not a readline kill ring: the editor's four killing verbs (`Alt+Backspace`/`Ctrl+W`,
   * `Alt+Delete`/`Ctrl+Delete`, `Ctrl+K`, `Ctrl+U`) feed it, `Ctrl+C` clearing the whole draft feeds
   * it through {@link PromptInputHandle.clearToKillSlot}, and `Ctrl+Y` puts it back. Plain
   * `Backspace`/`Delete`/`Ctrl+D` deliberately do not — a slot that every keystroke overwrites is
   * one nobody can predict the contents of — and neither does a kill that removed nothing, which
   * would otherwise destroy a yank the user still wanted by replacing it with an empty string.
   *
   * A yank READS the slot and leaves it, so `Ctrl+Y` is repeatable — deliberately, not incidentally.
   * readline's `Ctrl+Y` is repeatable and this imitates it, and a slot that spent itself on use would
   * make the second press do nothing with nothing on screen to explain why: the same unpredictability
   * the rule above exists to avoid. Only killing verbs ever write here.
   */
  const killRef = useRef('');

  /**
   * Apply one kill: the same authoritative-buffer path as {@link applyEdit}, and the removed text
   * comes out of that same call rather than being read off the render — a kill sharing a stdin chunk
   * with an earlier edit would otherwise store text the user has already changed.
   */
  const applyKill = (kill: (previous: EditorState) => KillResult): void => {
    const previous = bufferRef.current;
    const { state: next, killed } = kill(previous.state);
    if (killed !== '') killRef.current = killed;
    commit(previous, next);
  };

  /** `Ctrl+Y` — put the slot's text back at the caret. An empty slot inserts nothing. */
  const yankKill = (): void => {
    applyEdit((current) => insertText(current, killRef.current));
  };

  /** {@link PromptInputHandle.clearToKillSlot} — `Ctrl+C` rung 1, asked for by `<App>`. */
  const clearToKillSlot = (): boolean => {
    // Answered from the AUTHORITATIVE buffer, like every other keystroke here: the ladder's whole
    // decision hangs on this boolean, and a Ctrl+C sharing a stdin chunk with the edit that emptied
    // the buffer would otherwise claim the keystroke and leave the session where the user meant to
    // stop the turn. Emptiness is also exactly the "an empty range is not a kill" rule, kept here so
    // the answer and the slot cannot disagree about whether anything was scrapped.
    if (bufferRef.current.state.value === '') return false;
    applyKill(killAll);
    return true;
  };

  // Publish the handle for as long as this prompt is mounted, and take it away when it is not — the
  // null is load-bearing, because `<App>` reads it in states where this component does not exist and
  // a stale handle would clear a buffer nobody can see. Deliberately without a dependency array: the
  // handle closes over functions rebuilt on every render, and republishing one object per render
  // costs nothing next to a stale closure deciding what a keystroke means.
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { clearToKillSlot };
    return () => {
      handleRef.current = null;
    };
  });

  /** Whether this mount has already had its one chance to take a draft out of the carry slot. */
  const carryTakenRef = useRef(false);

  // TUI-C51 — the carry slot, on both of its sides, in the one place that can tell them apart.
  //
  // **On this mount's first commit**, a draft waiting in the slot is a message this prompt was
  // showing before a command replaced it (see {@link PromptDraftCarry}), so it is taken back —
  // caret included, since the slot holds the whole editor state. **On every commit after that**,
  // the slot is emptied: a draft written into it by a dispatch that left this prompt standing has
  // already been restored into local state by that dispatch, and leaving it there would resurrect
  // the message at some later, unrelated remount the user cannot connect to anything.
  //
  // React runs no effect for a component that the same commit unmounted, which is exactly what
  // makes this work: the dispatch that replaces the prompt gets neither branch, so the slot stays
  // full until the next mount reads it. Deliberately without a dependency array, for the same
  // reason the handle above has none — this must hold after every commit, not after a chosen few.
  // The slot is read here rather than in the initial state, because a ref belongs to effects and
  // handlers and not to render.
  //
  // **A LAYOUT effect, not a passive one, and the difference is reachable.** React flushes a
  // passive effect on a later scheduler task, while Ink's stdin `data` events are ordinary
  // macrotasks on the same loop — so between the commit that remounts this prompt (buffer empty,
  // `<PromptEditor>`'s `useInput` already subscribed) and a passive restore, a keypress can be
  // applied to the empty buffer and then thrown away whole, because `commitBuffer` replaces the
  // buffer rather than merging into it. A user who Escapes the `/approvals` picker and types
  // straight away would lose the first characters and watch the caret jump. A layout effect runs
  // synchronously inside the commit, so there is no such window — and no frame painted empty
  // before the message comes back.
  useLayoutEffect(() => {
    if (!draftCarryRef) return;
    if (!carryTakenRef.current) {
      carryTakenRef.current = true;
      const carried = draftCarryRef.current;
      if (carried) commitBuffer({ state: carried, edits: 0 });
    }
    draftCarryRef.current = null;
  });

  /** Submit `value` and clear the buffer; the bumped serial resets the menu (see `bufferRef`). */
  const submit = (value: string): void => {
    commitBuffer({ state: createEditorState(), edits: bufferRef.current.edits + 1 });
    onSubmit(value);
  };

  /**
   * Enter, with the menu closed — decided here rather than in the editor.
   *
   * What Enter means depends on the buffer (a trailing backslash continues the line, anything else
   * submits it), so the decision reads the same authoritative buffer every other keystroke writes.
   * Decided from a render instead, an Enter sharing a chunk with an edit answers about the text
   * before that edit: a held Backspace released into Enter shows the corrected text on screen and
   * sends the uncorrected text, then clears the buffer so nothing survives to show it.
   */
  const pressEnterOnBuffer = (): void => {
    const result = pressEnter(bufferRef.current.state);
    if (result.kind === 'continue') {
      commitBuffer({ state: result.state, edits: bufferRef.current.edits + 1 });
      return;
    }
    submit(result.value);
  };

  /**
   * The menu's transient state, keyed on the edit serial it belongs to.
   *
   * `dismissed` is Esc's, so the menu can be sent away without clearing the input; `index` is the
   * highlighted row, which starts at the most-relevant match whenever the query changes under it.
   */
  const [menu, setMenu] = useState<{ forEdit: number; dismissed: boolean; index: number }>({
    forEdit: 0,
    dismissed: false,
    index: 0,
  });
  const menuAppliesToBuffer = menu.forEdit === buffer.edits;

  /**
   * TUI-C51 — the chord's menu, or `null`. Authoritative in a ref for the same reason the buffer
   * is: Ink dispatches every key of one stdin chunk synchronously, so a handler reading the
   * rendered value reads it from before its predecessor in that chunk — and here that predecessor
   * is routinely the keystroke that OPENED the menu.
   */
  const [commandMenu, setCommandMenu] = useState<CommandMenu | null>(null);
  const commandMenuRef = useRef(commandMenu);
  const putCommandMenu = (next: CommandMenu | null): void => {
    commandMenuRef.current = next;
    setCommandMenu(next);
  };

  /**
   * TUI-C95 — put `typed` into the open menu's query: the ONE place either input channel stores it.
   *
   * The keystroke channel and the bracketed-paste channel both land here, so the leading-slash
   * strip and the highlight reset are stated once. Split between the two, they would answer the
   * same `/help` differently depending only on whether the terminal wrapped it in paste markers —
   * which is not a distinction the user makes, or can even see.
   *
   * Every edit to the query resets the highlight to the most relevant match, exactly as the typed
   * menu does: the row that was first before is not the row that is first now.
   */
  const typeIntoCommandMenu = (open: CommandMenu, typed: string): void => {
    putCommandMenu({
      query: extendCommandMenuQuery(open.query, typed, open.started),
      index: 0,
      started: true,
    });
  };

  const query = slashMenuQuery(state.value);
  const dismissed = menuAppliesToBuffer && menu.dismissed;
  const matches = query !== null && !dismissed ? filterSlashCommands(commands, query) : [];
  // The two menus are the same menu in two modes and never share the screen: while the chord's
  // menu is open the editor is standing down, so a buffer that happens to read `/de` would
  // otherwise leave a second, unreachable list rendered under a query nobody can type into.
  const menuActive = commandMenu === null && matches.length > 0;
  // Clamp defensively in case the filtered list shrank below the highlight between renders.
  const selectedIndex = menuActive
    ? Math.min(menuAppliesToBuffer ? menu.index : 0, matches.length - 1)
    : 0;

  const commandMatches = commandMenu ? filterSlashCommands(commands, commandMenu.query) : [];
  const commandIndex = commandMenu ? Math.min(commandMenu.index, commandMatches.length - 1) : 0;

  // Let the parent suppress its competing Tab handler (debug-panel focus) while EITHER menu owns
  // the navigation keys.
  const menuOwnsNavigation = menuActive || commandMenu !== null;
  useEffect(() => {
    onMenuStateChange?.(menuOwnsNavigation);
  }, [menuOwnsNavigation, onMenuStateChange]);

  /** Step the highlight by `step`, wrapping — the menu is open, so there is a list to step. */
  const moveHighlight = (step: number): void => {
    const forEdit = bufferRef.current.edits;
    setMenu((previous) => {
      const current = previous.forEdit === forEdit ? previous.index : 0;
      const clamped = Math.min(current, matches.length - 1);
      return {
        forEdit,
        dismissed: false,
        index: (clamped + step + matches.length) % matches.length,
      };
    });
  };

  /**
   * TUI-C51 — run the highlighted command and give the message back, caret included.
   *
   * The dispatch goes through the ordinary {@link submit}, which clears the buffer: that is what
   * makes this a capture-and-restore rather than a claim that nothing was disturbed. Keeping the
   * one submit path is the point — `<App>`'s `handleSubmit` sees exactly the string the typed menu
   * would have sent it, so the mid-turn rules (a plain message refused, a command without
   * `availableDuringRun` refused) apply here with nothing taught about this mode.
   *
   * The snapshot is taken from the AUTHORITATIVE buffer, not the render, for the usual reason: the
   * Enter can share a stdin chunk with the edit before it, and a draft restored from the rendered
   * value would silently roll that edit back.
   *
   * The serial keeps climbing across the round trip. It must: it is what invalidates the typed
   * menu's transient bookkeeping, and a restore that put the old serial back would resurrect an
   * Esc-dismissal or a stale highlight belonging to a buffer that has been away and returned.
   */
  const dispatchBesideDraft = (name: string): void => {
    const draft = bufferRef.current.state;
    // The slot is filled BEFORE the dispatch, because the dispatch may be the last thing that
    // happens to this component: a command that opens a picker replaces the prompt, and the
    // restore below then lands in state nothing will render again (see {@link PromptDraftCarry}).
    //
    // **What the carry then needs is that the unmount reaches React before this component commits
    // again** — not that the order of these two lines is irrelevant. The effect above empties the
    // slot on every commit after the first, so a picker-opening command that deferred its state
    // change by even one macrotask would let this prompt commit once while still mounted, the slot
    // would be cleared, and the draft would be gone by the time the remount looked for it. Nothing
    // trips that today: `handleSubmit` and the commands it dispatches are synchronous, so the
    // unmount lands in the same React commit and this component's effect never runs.
    if (draftCarryRef) draftCarryRef.current = draft;
    putCommandMenu(null);
    submit(`/${name}`);
    commitBuffer({ state: draft, edits: bufferRef.current.edits + 1 });
  };

  // TUI-C24 — capture a bracketed paste as buffered text instead of keystrokes. Ink enables
  // bracketed-paste mode while this hook is mounted and routes the pasted payload here (off the
  // `useInput` channel), so its embedded newlines never reach Enter handling. The paste is inserted
  // AT THE CARET and does NOT submit — a later explicit Enter submits it all.
  //
  // TUI-C95 — **unless the chord's menu is open, in which case the paste is what the menu is being
  // filtered BY.** While it is up the menu owns the whole keyboard and the message underneath is
  // not written to (TUI-C51), and this is the channel a terminal normally uses: bracketed-paste
  // mode is on for as long as this hook is mounted, so a user who presses the chord and pastes
  // `/status` out of their notes arrives HERE and not at `useInput`. Ungated, that paste filtered
  // nothing and was spliced into the draft instead — the one way the menu could modify a message it
  // promises to leave exactly as it was.
  usePaste((text) => {
    const pasted = normalizePastedText(text);
    if (!pasted) return;
    const open = commandMenuRef.current;
    if (open) {
      // Through the same `typedText` the keystroke channel reads, so the two cannot diverge on what
      // a one-line query may hold: a paste is never a chord, and a line break is not content to a
      // query (`keyGuards.ts`). Nothing left after that filter is nothing to do — updating anyway
      // would reset the highlight on a paste that changed nothing on screen.
      const typed = typedText(pasted, {});
      if (typed) typeIntoCommandMenu(open, typed);
      return;
    }
    applyEdit((current) => insertText(current, pasted));
  });

  useInput(
    (input, key) => {
      // TUI-C51 — the chord, live in every state of the buffer and of the session. It only ever
      // OPENS (see the component's doc comment); pressing it again restarts the query.
      if (opensCommandMenu(input, key)) {
        putCommandMenu({ query: '', index: 0, started: false });
        return;
      }

      // While the chord's menu is open it owns the whole keyboard — `<PromptEditor>` is suspended,
      // so every key answered here is answered nowhere else in this subtree. Read from the ref:
      // the key that opened the menu may be the one immediately before this in the same chunk.
      const open = commandMenuRef.current;
      if (open) {
        const list = filterSlashCommands(commands, open.query);
        const highlighted = Math.min(open.index, list.length - 1);
        if (key.escape) {
          // Close, and leave the message exactly as it was — this component never wrote to it.
          putCommandMenu(null);
        } else if (key.upArrow || key.downArrow) {
          if (list.length > 0) {
            const step = key.upArrow ? -1 : 1;
            putCommandMenu({
              query: open.query,
              index: (highlighted + step + list.length) % list.length,
              started: open.started,
            });
          }
        } else if (key.tab) {
          // Complete into the MENU's query, never into the message. No trailing space: there are no
          // arguments to type here, and a space would only narrow the list to nothing.
          if (list.length > 0)
            putCommandMenu({ query: list[highlighted].name, index: 0, started: true });
        } else if (key.return) {
          // Nothing highlighted means nothing to run — the same rule <SelectList> applies to a
          // filter that matches no row. The menu stays open so the query can be corrected.
          if (list.length > 0) dispatchBesideDraft(list[highlighted].name);
        } else if (key.backspace || key.delete) {
          // Nothing to trim is nothing to do. Running the update anyway would reset the highlight
          // on a keystroke that changed nothing on screen, so a user who has arrowed down the list
          // and then pressed Backspace once too often watches the selection jump back to the top
          // with nothing to explain it.
          if (open.query)
            putCommandMenu({
              query: open.query.slice(0, -1),
              index: 0,
              started: open.started,
            });
        } else if (isTypedText(input, key)) {
          // The query is one line and holds no command name with a control character in it, so what
          // goes in is the event's text (`keyGuards.ts`), not the event.
          typeIntoCommandMenu(open, typedText(input, key));
        }
        return;
      }

      // Only claim keys while the menu is visible; otherwise the editor handles everything.
      if (!menuActive) return;
      if (key.upArrow) {
        moveHighlight(-1);
      } else if (key.downArrow) {
        moveHighlight(1);
      } else if (key.tab) {
        // Complete to the highlighted name plus a trailing space: the space closes the menu (the
        // input now has whitespace) and leaves the caret ready for args, without dispatching.
        applyEdit(() => createEditorState(`/${matches[selectedIndex].name} `));
      } else if (key.escape) {
        setMenu({ forEdit: bufferRef.current.edits, dismissed: true, index: 0 });
      } else if (key.return) {
        // With the menu open, Enter dispatches the HIGHLIGHTED command (so "/mo"+Enter runs
        // "/mode") rather than the typed text. The parent's handler parses + dispatches through
        // the registry either way, so fully-typed dispatch is unchanged. <PromptEditor> stands
        // down from Enter while `menuActive`, so this is the only claimant.
        submit(`/${matches[selectedIndex].name}`);
      }
    },
    // Active only while the prompt is mounted; harmless when the menu is closed (early return).
    { isActive: true }
  );

  return (
    <Box flexDirection="column">
      {menuActive ? <SlashCommandMenu commands={matches} selectedIndex={selectedIndex} /> : null}
      {/* TUI-C51 — the chord's menu: the matches, then the query row it is being filtered by, then
          the untouched message below. The query needs the row because it is nowhere else on
          screen, and an empty one still draws it — that row IS the mode indicator (DL-4). */}
      {commandMenu ? (
        <Box flexDirection="column">
          <SlashCommandMenu commands={commandMatches} selectedIndex={commandIndex} />
          <Box>
            <Text color="cyan">{COMMAND_MENU_PREFIX}</Text>
            <Text>{commandMenu.query}</Text>
          </Box>
        </Box>
      ) : null}
      {/* The editor decides nothing that depends on the text: it hands up an UPDATER for each edit
          and motion, and merely REPORTS Enter. Both go through `setBuffer`, so two keystrokes that
          share one stdin chunk compose in order instead of the second overwriting the first. */}
      <PromptEditor
        state={state}
        onChange={applyEdit}
        onKill={applyKill}
        onYank={yankKill}
        onEnter={pressEnterOnBuffer}
        menuActive={menuActive}
        suspended={commandMenu !== null}
      />
    </Box>
  );
}
