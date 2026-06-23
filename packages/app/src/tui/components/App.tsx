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
import type { PendingApproval, TranscriptItem, TuiAppProps } from '#src/tui/types.js';
import type { ToolApprovalScope } from '@gaunt-sloth/core/core/types.js';
import { Transcript } from '#src/tui/components/Transcript.js';
import { ApprovalPrompt } from '#src/tui/components/ApprovalPrompt.js';
import { LiveTurn } from '#src/tui/components/LiveTurn.js';
import { StatusBar } from '#src/tui/components/StatusBar.js';
import { PromptInput } from '#src/tui/components/PromptInput.js';
import { Rule } from '#src/tui/components/Rule.js';
import { ClearBanner } from '#src/tui/components/ClearBanner.js';
import {
  DebugPanel,
  debugPanelLines,
  DEBUG_TABS,
  type DebugTab,
} from '#src/tui/components/DebugPanel.js';
import {
  createCommandRegistry,
  dispatchSlashCommand,
  parseSlashCommand,
  toolsToggleNotice,
  yoloToggleNotice,
} from '#src/tui/slashCommands.js';
import { viewportBumpSequence } from '#src/tui/terminal.js';

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
  // Tool-approval queue (EXT-9 Phase B2). The head record (if any) is the approval currently
  // shown; while it is non-null the approval prompt OWNS keyboard input and the normal prompt is
  // suspended, so the command can't be typed into the chat box. Additional requests queue behind
  // it (only one approval is shown at a time) and surface as the head is resolved.
  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([]);
  const pendingApproval = approvalQueue[0] ?? null;
  // Mirror for the synchronous useInput handler, so it can read+resolve the head without a stale
  // closure (the handler is bound once and must not depend on the queue in its deps).
  const approvalQueueRef = useRef<PendingApproval[]>([]);
  approvalQueueRef.current = approvalQueue;
  // Mirror of toolsExpanded for the slash-command handler (memoized without it in deps), so
  // /tools can compute the next state without a stale closure or a side effect in the updater.
  const toolsExpandedRef = useRef(false);
  // Likewise a mirror of debugVisible, so the slash dispatch can pass the current panel state
  // into the command context (for state-aware /debug copy) without a stale closure.
  const debugVisibleRef = useRef(false);
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
  // The active section's line count drives the real maximum scroll offset, so neither the page
  // step nor the arrow step can push the offset past the end (the over-scroll bug that left
  // PgUp/↑ burning through phantom offset before anything moved — TUI-C11). Single-sourced with
  // DebugPanel via the exported `debugPanelLines` so the clamp matches exactly what is rendered.
  const debugLineCount = useMemo(
    () =>
      debugPanelLines({
        subagents,
        historyLines: debugHistory,
        requestLines: debugRequest,
        responseLines: debugResponse,
        activeTab: debugTab,
      }).length,
    [subagents, debugHistory, debugRequest, debugResponse, debugTab]
  );
  const debugMaxOffset = Math.max(0, debugLineCount - debugViewport);
  // Clamp helper shared by every downward scroll (page + arrow) so the offset never exceeds the
  // real maximum; the upward floor stays Math.max(0, …).
  const clampDebugScroll = (next: number) => Math.min(Math.max(0, next), debugMaxOffset);

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

  // Flip the tool-detail mode and commit the matching notice. Single-sourced so the `/tools`
  // command and the Ctrl+T key handler give the user identical, state-aware feedback (TUI-C14).
  // Committed turns are frozen in Ink's <Static> and never re-fold, so this only affects the
  // live / next turn — the notice copy says exactly that.
  const toggleTools = useCallback(() => {
    const next = !toolsExpandedRef.current;
    toolsExpandedRef.current = next;
    setToolsExpanded(next);
    const { title, lines, tone } = toolsToggleNotice(next);
    push({ kind: 'notice', title, lines, tone: tone ?? 'info' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the currently-shown approval (the queue head) and commit a brief notice so the
  // decision reads in the transcript (TUI-C14 notice conventions). Dequeues the head so the next
  // queued approval (if any) surfaces. Approve carries the chosen scope; reject is fail-closed.
  const resolveApproval = useCallback((decision: 'once' | 'session' | 'always' | 'reject') => {
    const head = approvalQueueRef.current[0];
    if (!head) return;
    if (decision === 'reject') {
      head.resolve({ type: 'reject', message: 'User rejected the shell command.' });
      push({
        kind: 'notice',
        title: 'Command rejected',
        lines: ['The shell command was not run; the agent was told you declined.'],
        tone: 'warn',
      });
    } else {
      const scope: ToolApprovalScope = decision;
      head.resolve({ type: 'approve', scope });
      const detail =
        scope === 'once'
          ? 'Approved this single invocation only.'
          : scope === 'session'
            ? 'Approved for this session — future variants will not re-prompt.'
            : 'Approved and remembered — saved to the project allow-list.';
      push({
        kind: 'notice',
        title: `Command approved (${scope})`,
        lines: [detail],
        tone: 'info',
      });
    }
    setApprovalQueue((q) => q.slice(1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          toolsExpanded: toolsExpandedRef.current,
          debugVisible: debugVisibleRef.current,
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
          // The status-bar turn counter is part of the conversation state we just wiped, so
          // reset it too — a cleared session starts back at "turns: 0".
          turnCountRef.current = 0;
          setTurnCount(0);
        }
        if (result.toggleTools) {
          // Flip the fold mode and commit the notice via the shared helper (single-sourced with
          // Ctrl+T). The command's own `result.notice` is intentionally not pushed for /tools —
          // toggleTools owns the notice so the copy matches the state actually applied.
          toggleTools();
        }
        if (result.toggleYolo) {
          // The runner owns the flag; flip it and commit the notice for the landed state. When the
          // agent can't toggle (fixture without a runner) fall back to a clear system line rather
          // than silently no-op. EXT-12.
          if (agent.toggleYolo) {
            const next = agent.toggleYolo();
            const { title, lines, tone } = yoloToggleNotice(next);
            push({ kind: 'notice', title, lines, tone: tone ?? 'info' });
          } else {
            push({
              kind: 'system',
              level: 'warning',
              text: 'yolo is unavailable in this session.',
            });
          }
        }
        if (result.toggleDebug) {
          setDebugVisible((v) => {
            const next = !v;
            debugVisibleRef.current = next;
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
        // Commit a structured notice (TUI-C14). /tools and /yolo own their notices above (the
        // state-aware copy is committed there), so skip result.notice in those cases.
        if (result.notice && !result.toggleTools && !result.toggleYolo) {
          const { title, lines, tone } = result.notice;
          push({ kind: 'notice', title, lines, tone: tone ?? 'info' });
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
    [runTurn, quit, registry, mode, modelDisplayName, toggleTools]
  );

  // Keyboard handling, in priority order:
  //  1. Esc while running → abort the in-flight turn (stdin is uncontended here — the event
  //     path never registers gsloth's readline Esc handler, so Ink owns raw mode cleanly).
  //  2. Tab while the panel is visible and idle → focus/cycle the panel.
  //  3. While the panel is focused → Tab/Shift+Tab cycle sections, ↑/↓ scroll one line,
  //     PageUp/PageDown page-step, m maximises, Esc unfocuses.
  useInput((input, key) => {
    // Highest priority: a pending tool approval OWNS the keyboard (EXT-9 Phase B2). While one is
    // shown, o/s/a resolve approve with the matching scope; anything else (n, Esc, Enter, …)
    // resolves reject — fail-closed, mirroring the readline path. We swallow the key either way
    // so it can't fall through to abort/debug handling or get typed into the prompt.
    if (approvalQueueRef.current.length > 0) {
      const ch = input.toLowerCase();
      if (ch === 'o') resolveApproval('once');
      else if (ch === 's') resolveApproval('session');
      else if (ch === 'a') resolveApproval('always');
      else resolveApproval('reject');
      return;
    }

    if (key.escape && runningRef.current) {
      abortRef.current?.abort();
      return;
    }

    // Ctrl+T toggles tool-call detail (compact summary ⇄ expanded args/result) while a turn
    // is streaming — the moment a live tool watch is most useful. We gate it on `running`
    // because the prompt's <TextInput> (mounted only when idle) would otherwise also receive
    // the keystroke and insert a stray 't'. The `/tools` slash command covers the idle case.
    if (key.ctrl && input === 't' && runningRef.current) {
      // Share the /tools helper so the same state-aware notice is committed (TUI-C14).
      toggleTools();
      return;
    }

    if (debugFocusedRef.current) {
      if (key.escape) {
        setDebugFocused(false);
        debugFocusedRef.current = false;
        return;
      }
      // Tab cycles sections forward; Shift+Tab steps back to the previous section (Ink reports
      // a back-tab as key.tab with key.shift). Both reset the scroll to the top of the new section.
      if (key.tab) {
        const step = key.shift ? -1 : 1;
        setDebugTab(
          (t) => DEBUG_TABS[(DEBUG_TABS.indexOf(t) + step + DEBUG_TABS.length) % DEBUG_TABS.length]
        );
        setDebugScroll(0);
        return;
      }
      // 'm' toggles maximise: grow the pane to (most of) the terminal height so long
      // captures (full request / full response) are readable, and back.
      if (input === 'm') {
        setDebugMaximized((m) => !m);
        return;
      }
      // ↑/↓ scroll one line for fine control; PgUp/PgDn page-step for coarse. Arrows exist on
      // every keyboard, so they are the universal scroll keys (Mac/compact keyboards lack
      // dedicated PgUp/PgDn) — that is why the hint and overflow markers advertise the arrows
      // (TUI-C11). Every downward move is clamped to the real maximum (see clampDebugScroll).
      if (key.upArrow) {
        setDebugScroll((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setDebugScroll((s) => clampDebugScroll(s + 1));
        return;
      }
      if (key.pageUp) {
        setDebugScroll((s) => Math.max(0, s - debugPageStep));
        return;
      }
      if (key.pageDown) {
        setDebugScroll((s) => clampDebugScroll(s + debugPageStep));
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

  // Surface tool-approval requests bridged from the runner (EXT-9 Phase B2): each pending
  // approval is appended to the queue; the head renders the <ApprovalPrompt> and owns input.
  useEffect(() => {
    if (!props.subscribeApproval) return;
    return props.subscribeApproval((record) => {
      setApprovalQueue((q) => [...q, record]);
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
      {/* Tool-approval affordance (EXT-9 Phase B2): when an approval is pending it sits just above
          the input dock, owns the keyboard, and suspends the normal prompt below. */}
      {pendingApproval ? <ApprovalPrompt pending={pendingApproval.pending} /> : null}
      <Rule />
      <StatusBar
        running={running}
        mode={mode}
        modelDisplayName={modelDisplayName}
        turnCount={turnCount}
        debugHint={debugVisible && !debugFocused}
      />
      {!running && !debugFocused && !pendingApproval ? (
        <PromptInput onSubmit={handleSubmit} />
      ) : null}
      <Text dimColor>{exitMessage.trim()}</Text>
      <Rule />
    </Box>
  );
}
