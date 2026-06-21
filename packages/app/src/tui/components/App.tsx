import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import {
  foldEvents,
  foldSubagentEvents,
  initialSubagentTree,
  initialTurnViewModel,
  type SubagentTreeViewModel,
  type TurnViewModel,
} from '#src/tui/viewModel.js';
import type { TranscriptItem, TuiAppProps } from '#src/tui/types.js';
import { Transcript } from '#src/tui/components/Transcript.js';
import { LiveTurn } from '#src/tui/components/LiveTurn.js';
import { StatusBar } from '#src/tui/components/StatusBar.js';
import { PromptInput } from '#src/tui/components/PromptInput.js';
import { Rule } from '#src/tui/components/Rule.js';
import { ClearBanner } from '#src/tui/components/ClearBanner.js';
import { DebugPanel, DEBUG_TABS, type DebugTab } from '#src/tui/components/DebugPanel.js';
import {
  createCommandRegistry,
  dispatchSlashCommand,
  parseSlashCommand,
} from '#src/tui/slashCommands.js';

/** Rows of clipping viewport in the docked debug panel (default / restored size). */
const DEBUG_VIEWPORT_HEIGHT = 8;
/** Rows of chrome around the debug viewport we leave for when it is maximised (panel
 *  border, tab row, hint row, the bottom scroll-status row, the input dock's
 *  rules/status/prompt). The maximised viewport is the terminal height minus this, clamped
 *  so it never collapses on a tiny terminal. */
const DEBUG_MAX_CHROME_ROWS = 9;
/** Floor for the maximised viewport so a short terminal still shows something usable. */
const DEBUG_MAX_MIN_HEIGHT = 6;

/** The clipping-viewport height for the docked panel given the terminal height + maximise state. */
function debugViewportHeight(maximized: boolean, terminalRows: number | undefined): number {
  if (!maximized) return DEBUG_VIEWPORT_HEIGHT;
  const rows = terminalRows && terminalRows > 0 ? terminalRows : 24;
  return Math.max(DEBUG_MAX_MIN_HEIGHT, rows - DEBUG_MAX_CHROME_ROWS);
}

/**
 * The terminal sequence that makes `/clear` "bump up" the screen like `clear`/Ctrl+L while
 * *preserving* scrollback. We deliberately do NOT emit the clear-scrollback escape `ESC[3J`
 * (which would destroy history and defeat the point):
 *  - First push a screenful of newlines so the prior conversation scrolls up and out of the
 *    visible viewport — but stays reachable by scrolling/wheeling up (it lives in scrollback).
 *  - Then home the cursor (`ESC[H`) and clear from the cursor to the end of the *visible*
 *    screen (`ESC[J`, i.e. `ESC[0J`) so Ink re-renders cleanly at the top with no artifacts.
 * `rows` is the live terminal height; we fall back to a sensible default when it is unknown.
 */
function viewportBumpSequence(rows: number | undefined): string {
  const height = rows && rows > 0 ? rows : 24;
  // newlines (bump prior content into scrollback) + cursor home + clear-to-end-of-visible-screen.
  // NOTE: `\x1b[J` is clear-to-end-of-screen (NOT `\x1b[3J`, which would erase scrollback).
  return '\n'.repeat(height) + '\x1b[H' + '\x1b[J';
}

type DistributiveOmitId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** Plain (legacy) `exit` keyword still quits, alongside the `/exit` slash command. */
const isPlainExit = (s: string): boolean => s.trim().toLowerCase() === 'exit';

/**
 * Root TUI component: owns the transcript, the in-progress live turn, and the run
 * lifecycle (one `AbortController` per turn; Esc aborts). It consumes the agent purely as
 * an `AsyncGenerator<AgentStreamEvent>` and folds events through the pure `foldEvents`
 * reducer, so the whole component is testable with a scripted fake agent.
 */
export function App(props: TuiAppProps): React.ReactElement {
  const { agent, mode, modelDisplayName, readyMessage, exitMessage, initialMessage } = props;
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [live, setLive] = useState<TurnViewModel | null>(null);
  const [running, setRunning] = useState(false);
  const [turnCount, setTurnCount] = useState(0);
  // Subagent tree (deepagents `task` calls) folded from the live event stream.
  const [subagents, setSubagents] = useState<SubagentTreeViewModel>(initialSubagentTree);
  // Docked debug panel state (toggled by /debug).
  const [debugVisible, setDebugVisible] = useState(false);
  const [debugFocused, setDebugFocused] = useState(false);
  const [debugTab, setDebugTab] = useState<DebugTab>(DEBUG_TABS[0]);
  const [debugScroll, setDebugScroll] = useState(0);
  const [debugMaximized, setDebugMaximized] = useState(false);
  const [debugHistory, setDebugHistory] = useState<string[]>([]);
  const [debugRequest, setDebugRequest] = useState<string[]>([]);
  const [debugResponse, setDebugResponse] = useState<string[]>([]);
  // Whether tool-call panels show their args/result body. Collapsed by default (compact
  // summary lines) so the transcript stays readable; Ctrl+T flips the whole turn's detail,
  // mirroring the docked debug panel's single-key detail toggle.
  const [toolsExpanded, setToolsExpanded] = useState(false);
  // Whether to show the post-`/clear` "history cleared" banner. Lives in the live (non-Static)
  // frame so it is reliably visible — pushing a system line right after setTranscript([]) is
  // swallowed because clearing <Static>'s items resets its internal index (TUI-C12). Hidden
  // again the moment the next user turn starts so it doesn't linger above a fresh conversation.
  const [clearedBanner, setClearedBanner] = useState(false);
  // Mirror of toolsExpanded for the slash-command handler (memoized without it in deps), so
  // /tools can compute the next state without a stale closure or a side effect in the updater.
  const toolsExpandedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const runningRef = useRef(false);
  const turnCountRef = useRef(0);
  // Per-turn args buffers for the subagent fold (mirrors foldSubagentTree's internal map).
  const subagentBuffersRef = useRef<Map<string, string>>(new Map());
  const debugFocusedRef = useRef(false);
  const { exit } = useApp();
  // Terminal height drives the maximised viewport size; useStdout keeps it resize-aware.
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows;
  const debugViewport = debugViewportHeight(debugMaximized, terminalRows);
  // PageUp/PageDown step tracks the live viewport so maximise pages by (almost) a full screen.
  const debugPageStep = Math.max(1, debugViewport - 1);

  // Built once per session; a plain array so later layers (EXT-5) could append commands.
  const registry = useMemo(() => createCommandRegistry(), []);

  const nextId = () => (idRef.current += 1);
  // Distributive omit so each union member keeps its own fields (a plain
  // Omit<TranscriptItem,'id'> collapses to the shared `kind` key only).
  const push = (item: DistributiveOmitId<TranscriptItem>) =>
    setTranscript((t) => [...t, { ...item, id: nextId() } as TranscriptItem]);

  const runTurn = useCallback(
    async (userInput: string) => {
      // A new exchange supersedes the post-/clear banner; drop it so it doesn't sit above
      // the fresh conversation.
      setClearedBanner(false);
      push({ kind: 'user', text: userInput });
      const ac = new AbortController();
      abortRef.current = ac;
      runningRef.current = true;
      setRunning(true);
      let vm = initialTurnViewModel();
      setLive(vm);
      // Fresh args-buffer map per turn so partial `task` JSON from a prior turn never bleeds in.
      subagentBuffersRef.current = new Map();
      try {
        for await (const event of agent.runTurn(userInput, ac.signal)) {
          vm = foldEvents(vm, event);
          setLive(vm);
          // Fold subagent (`task`) tool calls into the tree for the debug panel.
          setSubagents((tree) => foldSubagentEvents(tree, event, subagentBuffersRef.current));
        }
      } catch (err) {
        push({
          kind: 'system',
          level: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        push({ kind: 'assistant', turn: vm });
        setLive(null);
        setRunning(false);
        runningRef.current = false;
        abortRef.current = null;
        turnCountRef.current += 1;
        setTurnCount(turnCountRef.current);
        props.onTurnComplete?.(userInput, vm.text);
      }
    },
    // props is stable for the session; intentionally run-once-bound
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent]
  );

  const quit = useCallback(() => {
    void Promise.resolve(props.onExit?.()).finally(() => exit());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exit]);

  const handleSubmit = useCallback(
    (value: string) => {
      if (runningRef.current) return;
      if (!value.trim()) return;

      // Legacy bare `exit` keyword still quits.
      if (isPlainExit(value)) {
        quit();
        return;
      }

      // A line starting with `/` is a slash command: dispatch through the registry instead
      // of sending it to the model. Unknown commands become a friendly system line.
      const parsed = parseSlashCommand(value);
      if (parsed) {
        const result = dispatchSlashCommand(parsed, registry, {
          mode,
          modelDisplayName: modelDisplayName ?? '',
          turnCount: turnCountRef.current,
        });
        if (result.clearTranscript) {
          setTranscript([]);
          setSubagents(initialSubagentTree());
          setDebugHistory([]);
          setDebugRequest([]);
          setDebugResponse([]);
          // Show visible feedback for the clear. Rendered outside <Static> (see clearedBanner)
          // so the known index-reset swallow quirk can't eat it (TUI-C12).
          setClearedBanner(true);
          // "Bump up" the screen the clear/Ctrl+L way: scroll the prior conversation up and out
          // of the visible viewport (it stays in scrollback — we never emit ESC[3J), so the
          // session restarts at the top. We write the sequence ourselves and then reset Ink's
          // frame accounting (onResetFrame → instance.clear()) so the next render lands cleanly
          // at the top with no leftover artifacts.
          stdout?.write(viewportBumpSequence(stdout?.rows));
          props.onResetFrame?.();
          // Clearing only the on-screen transcript would leave the model's conversation
          // thread intact (the LangGraph checkpointer replays it on the next turn), so the
          // model would still "remember" everything. Reset the agent's thread too so the
          // model context truly matches the now-empty transcript (TUI-C8).
          agent.resetThread?.();
        }
        if (result.toggleTools) {
          // Committed turns are frozen in Ink's <Static> and never re-fold, so toggling while
          // idle has no visible effect on the existing scrollback. Flip the mode for the live /
          // next turn and emit an immediate system line confirming the new state so the command
          // is not a silent no-op (TUI-C9).
          const next = !toolsExpandedRef.current;
          toolsExpandedRef.current = next;
          setToolsExpanded(next);
          push({
            kind: 'system',
            level: 'info',
            text: `Tool call details: ${next ? 'expanded' : 'collapsed'} — applies to new turns.`,
          });
        }
        if (result.toggleDebug) {
          setDebugVisible((v) => {
            const next = !v;
            // Reset scroll + focus each time the panel is shown, so it opens at the top and
            // focus never lingers on a hidden panel.
            if (next) {
              setDebugScroll(0);
            } else {
              setDebugFocused(false);
              debugFocusedRef.current = false;
              setDebugMaximized(false);
            }
            return next;
          });
        }
        if (result.message) {
          push({ kind: 'system', level: result.level ?? 'info', text: result.message });
        }
        if (result.exit) quit();
        return;
      }

      void runTurn(value);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runTurn, quit, registry, mode, modelDisplayName]
  );

  // Keyboard handling, in priority order:
  //  1. Esc while running → abort the in-flight turn (stdin is uncontended here — the event
  //     path never registers gsloth's readline Esc handler, so Ink owns raw mode cleanly).
  //  2. Tab while the panel is visible and idle → focus/cycle the panel.
  //  3. While the panel is focused → Tab cycles section, PageUp/PageDown scroll, Esc unfocuses.
  useInput((input, key) => {
    if (key.escape && runningRef.current) {
      abortRef.current?.abort();
      return;
    }

    // Ctrl+T toggles tool-call detail (compact summary ⇄ expanded args/result) while a turn
    // is streaming — the moment a live tool watch is most useful. We gate it on `running`
    // because the prompt's <TextInput> (mounted only when idle) would otherwise also receive
    // the keystroke and insert a stray 't'. The `/tools` slash command covers the idle case.
    if (key.ctrl && input === 't' && runningRef.current) {
      const next = !toolsExpandedRef.current;
      toolsExpandedRef.current = next;
      setToolsExpanded(next);
      return;
    }

    if (debugFocusedRef.current) {
      if (key.escape) {
        setDebugFocused(false);
        debugFocusedRef.current = false;
        return;
      }
      if (key.tab) {
        setDebugTab((t) => DEBUG_TABS[(DEBUG_TABS.indexOf(t) + 1) % DEBUG_TABS.length]);
        setDebugScroll(0);
        return;
      }
      // 'm' toggles maximise: grow the pane to (most of) the terminal height so long
      // captures (full request / full response) are readable, and back.
      if (input === 'm') {
        setDebugMaximized((m) => !m);
        return;
      }
      if (key.pageUp) {
        setDebugScroll((s) => Math.max(0, s - debugPageStep));
        return;
      }
      if (key.pageDown) {
        setDebugScroll((s) => s + debugPageStep);
        return;
      }
      return;
    }

    // Tab focuses the docked panel when it is visible and no turn is running.
    if (key.tab && debugVisible && !runningRef.current) {
      setDebugFocused(true);
      debugFocusedRef.current = true;
    }
  });

  // Run an initial message once on mount, if supplied.
  useEffect(() => {
    if (initialMessage && initialMessage.trim()) {
      void runTurn(initialMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route agent status updates (warnings/info) into the transcript instead of stdout,
  // which would otherwise corrupt Ink's frame.
  useEffect(() => {
    if (!props.subscribeStatus) return;
    return props.subscribeStatus((level, message) => {
      if (message.trim()) push({ kind: 'system', level, text: message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Capture debug payloads (full history sent to the model + the raw resolved response) from
  // the deep agent's wrapModelCall middleware, for the `/debug` panel. Routed into local state
  // — never to stdout — and split into lines for the panel's bounded viewport.
  useEffect(() => {
    if (!props.subscribeDebug) return;
    return props.subscribeDebug((capture) => {
      if (capture.kind === 'request') {
        setDebugHistory(capture.text.split('\n'));
        setDebugRequest(capture.details.split('\n'));
      } else setDebugResponse(capture.text.split('\n'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The greeting is an intro, not a permanent fixture: show it only before the first
  // exchange, so it stops padding the bottom dock once the conversation is underway.
  const showIntro = !initialMessage && transcript.length === 0 && !live;

  return (
    <Box flexDirection="column">
      <Transcript items={transcript} toolsExpanded={toolsExpanded} />
      {clearedBanner ? <ClearBanner /> : null}
      {showIntro ? <Text dimColor>{readyMessage.trim()}</Text> : null}
      {live ? <LiveTurn turn={live} toolsExpanded={toolsExpanded} streaming /> : null}
      {/* Docked debug/subagent panel: full-width, below the transcript / live turn and above
          the input dock. Lives in the live (non-static) frame, so it coexists with the
          <Static> scrollback. Toggled by /debug; Tab focuses it for PageUp/PageDown scrolling. */}
      {debugVisible ? (
        <DebugPanel
          subagents={subagents}
          historyLines={debugHistory}
          requestLines={debugRequest}
          responseLines={debugResponse}
          activeTab={debugTab}
          scrollOffset={debugScroll}
          focused={debugFocused}
          viewportHeight={debugViewport}
          maximized={debugMaximized}
        />
      ) : null}
      {/* Input dock: bracketed top and bottom by rules so the status bar, prompt and hint
          read as a distinct control zone rather than blending into the scrollback. */}
      <Rule />
      <StatusBar
        running={running}
        mode={mode}
        modelDisplayName={modelDisplayName}
        turnCount={turnCount}
        debugHint={debugVisible && !debugFocused}
      />
      {!running && !debugFocused ? <PromptInput onSubmit={handleSubmit} /> : null}
      <Text dimColor>{exitMessage.trim()}</Text>
      <Rule />
    </Box>
  );
}
