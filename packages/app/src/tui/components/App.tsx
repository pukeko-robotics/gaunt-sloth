import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
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
import type { ApprovalRung } from '@gaunt-sloth/core/config.js';
import { buildRejectionMessage } from '@gaunt-sloth/core/core/shell/rejection.js';
import { TranscriptViewport } from '#src/tui/components/TranscriptViewport.js';
import { ApprovalPrompt } from '#src/tui/components/ApprovalPrompt.js';
import { LiveTurn, ChecklistPanel } from '#src/tui/components/LiveTurn.js';
import { extractActiveChecklist } from '#src/tui/viewModel.js';
import { StatusBar } from '#src/tui/components/StatusBar.js';
import { NoticeBar, McpFailureBar } from '#src/tui/components/NoticeBar.js';
import { PromptInput } from '#src/tui/components/PromptInput.js';
import { Rule } from '#src/tui/components/Rule.js';
import { ClearBanner } from '#src/tui/components/ClearBanner.js';
import { LaunchBanner } from '#src/tui/components/LaunchBanner.js';
import { MouseProvider } from '#src/tui/useMouse.js';
import {
  DebugPanel,
  debugPanelLines,
  DEBUG_TABS,
  type DebugTab,
} from '#src/tui/components/DebugPanel.js';
import {
  approvalsRungNotice,
  approvalsStatusNotice,
  approvalsTrustNotice,
  createCommandRegistry,
  dispatchSlashCommand,
  type McpTrustRequest,
  parseSlashCommand,
  toolsToggleNotice,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import { TerminalSizeProvider, useTerminalSize } from '#src/tui/useTerminalSize.js';
import { findMatches, scrollOffsetForLine, stepMatch } from '#src/tui/debugSearch.js';
import { useTranscriptScroll } from '#src/tui/useTranscriptScroll.js';
import { isComposingKeystroke, WHEEL_ROWS_PER_NOTCH } from '#src/tui/transcriptScroll.js';

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
  // TUI-C37 — live mouse state, seeded from the resolved `config.useMouse` and flipped by `/mouse`.
  const [mouseEnabled, setMouseEnabled] = useState(!!props.mouseEnabled);
  const [debugFocused, setDebugFocused] = useState(false);
  const [debugTab, setDebugTab] = useState<DebugTab>(DEBUG_TABS[0]);
  const [debugScroll, setDebugScroll] = useState(0);
  const [debugMaximized, setDebugMaximized] = useState(false);
  const [debugHistory, setDebugHistory] = useState<string[]>([]);
  // TUI-C16: the old combined "system + tools" capture is split across two tabs.
  const [debugSystem, setDebugSystem] = useState<string[]>([]);
  const [debugTools, setDebugTools] = useState<string[]>([]);
  // TUI-C20: the MCP-server overview tab (per-server instructions + prefixed tools).
  const [debugMcp, setDebugMcp] = useState<string[]>([]);
  const [debugResponse, setDebugResponse] = useState<string[]>([]);
  // TUI-C21 — `less`-style incremental search over the focused pane's shared line model. Scoped to
  // debug-pane focus (see the useInput handler): `/` opens the query, `n`/`N` step matches, `Esc`
  // clears. `searchInput` is the "typing the query" mode (owns keys); `searchQuery` is the live
  // query (highlights + count); `searchCurrent` is the 0-based cursor into the match list.
  const [debugSearchInput, setDebugSearchInput] = useState(false);
  const [debugSearchQuery, setDebugSearchQuery] = useState('');
  const [debugSearchCurrent, setDebugSearchCurrent] = useState(0);
  // Whether tool-call panels show their args/result body. Collapsed by default (compact
  // summary lines) so the transcript stays readable; Ctrl+T flips the whole turn's detail,
  // mirroring the docked debug panel's single-key detail toggle.
  const [toolsExpanded, setToolsExpanded] = useState(false);
  // CFG-26 — the session approvals posture. Seeded from props (the resolved config posture); the
  // runner owns the authoritative state, this mirror drives the status-bar mode badge and the
  // state-aware notices.
  const [approvals, setApprovals] = useState(props.initialApprovals);
  // Mirror for the synchronous approval useInput handler, so `y` can read the current posture
  // without a stale closure.
  const approvalsRef = useRef(props.initialApprovals);
  // Whether to show the post-`/clear` "history cleared" banner. Hidden again the moment the next
  // user turn starts so it doesn't linger above a fresh conversation.
  const [clearedBanner, setClearedBanner] = useState(false);
  // Tool-approval queue (EXT-9 Phase B2). The head record (if any) is the approval currently
  // shown; while it is non-null the approval prompt OWNS keyboard input and the normal prompt is
  // suspended, so the command can't be typed into the chat box. Additional requests queue behind
  // it (only one approval is shown at a time) and surface as the head is resolved.
  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([]);
  // The head is the approval on screen AND the one that owns the keyboard. Deriving both from this
  // single expression is what keeps those two facts from drifting apart.
  const pendingApproval = approvalQueue[0] ?? null;
  // Mirror of toolsExpanded for the slash-command handler (memoized without it in deps), so
  // /verbose can compute the next state without a stale closure or a side effect in the updater.
  const toolsExpandedRef = useRef(false);
  // Likewise a mirror of debugVisible, so the slash dispatch can pass the current panel state
  // into the command context (for state-aware /debug copy) without a stale closure.
  const debugVisibleRef = useRef(false);
  // Same mirror for mouse, so `/mouse` with no argument toggles from the CURRENT state rather than
  // from whatever the dispatch closure captured.
  const mouseEnabledRef = useRef(!!props.mouseEnabled);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const runningRef = useRef(false);
  const turnCountRef = useRef(0);
  // Per-turn args buffers for the subagent fold (mirrors foldSubagentTree's internal map).
  const subagentBuffersRef = useRef<Map<string, string>>(new Map());
  const debugFocusedRef = useRef(false);
  // TUI-C10 — mirror of whether the prompt's slash-command menu currently owns navigation keys, so
  // the top-level Tab handler (debug-panel focus) stands down while the menu is open.
  const slashMenuActiveRef = useRef(false);
  const { exit } = useApp();
  // TUI-C48 — the full-screen frame is exactly this tall, which is what pins the dock to the
  // terminal floor AND what stops a frame from overflowing the screen (a taller frame loses its
  // top rows silently, as missing content rather than as an error). It also drives the maximised
  // debug viewport, and it is resize-aware: Ink relays out on SIGWINCH but does not re-render.
  // This is the ONE stdout resize subscription in the tree: it is published below through
  // <TerminalSizeProvider>, and every other component that needs the size reads it from there.
  const terminalSize = useTerminalSize();
  const { rows: terminalRows, columns: terminalColumns } = terminalSize;
  // TUI-C48 — where the conversation region's bottom edge sits. The alternate screen has no
  // terminal scrollback, so this is the only way back to what has already been said.
  const {
    scroll: transcriptScroll,
    regionRows: transcriptRegionRows,
    geometry: transcriptGeometry,
    scrollByRows,
    scrollByPages,
    scrollToBottom,
    scrollToStart,
  } = useTranscriptScroll();
  const debugViewport = debugViewportHeight(debugMaximized, terminalRows);
  // PageUp/PageDown step tracks the live viewport so maximise pages by (almost) a full screen.
  const debugPageStep = Math.max(1, debugViewport - 1);
  // The active section's line count drives the real maximum scroll offset, so neither the page
  // step nor the arrow step can push the offset past the end (the over-scroll bug that left
  // PgUp/↑ burning through phantom offset before anything moved — TUI-C11). Single-sourced with
  // DebugPanel via the exported `debugPanelLines` so the clamp matches exactly what is rendered.
  const debugLines = useMemo(
    () =>
      debugPanelLines({
        subagents,
        historyLines: debugHistory,
        systemLines: debugSystem,
        toolsLines: debugTools,
        mcpLines: debugMcp,
        responseLines: debugResponse,
        activeTab: debugTab,
      }),
    [subagents, debugHistory, debugSystem, debugTools, debugMcp, debugResponse, debugTab]
  );
  const debugLineCount = debugLines.length;
  const debugMaxOffset = Math.max(0, debugLineCount - debugViewport);
  // Match line-indices for the current query over the active tab's lines — one search, every tab
  // uniformly (it runs over whatever `debugPanelLines` produced).
  const debugMatches = useMemo(
    () => findMatches(debugLines, debugSearchQuery),
    [debugLines, debugSearchQuery]
  );
  // TUI-C21 — the three search values the key handler both READS AND WRITES, held in refs as well
  // as state. Ink dispatches every keypress parsed out of one stdin chunk in a synchronous loop, so
  // typing `abc` can run this handler three times before a single re-render: reading the state
  // would give all three the pre-`a` value and the query would end up `c`. Every helper below and
  // every branch of the handler writes the ref beside its setter, which is the whole contract —
  // there is no render-time refresh to fall back on, and adding one would store a value from a
  // render React may never commit.
  const debugSearchInputRef = useRef(false);
  const debugSearchQueryRef = useRef('');
  const debugSearchCurrentRef = useRef(0);
  // The absolute line index of the current match (or -1) — DebugPanel paints it distinctly.
  const currentMatchLine =
    debugMatches.length > 0
      ? debugMatches[Math.min(debugSearchCurrent, debugMatches.length - 1)]
      : -1;
  // Clamp helper shared by every downward scroll (page + arrow) so the offset never exceeds the
  // real maximum; the upward floor stays Math.max(0, …).
  const clampDebugScroll = (next: number) => Math.min(Math.max(0, next), debugMaxOffset);

  // ── TUI-C21 search helpers. They read `debugLines` / `debugMatches` straight from this render:
  // Ink wraps the useInput callback in React's `useEffectEvent`, so the handler that calls them is
  // always the newest committed one, and neither value can change from a search keystroke anyway. ──
  // Clear the search entirely (query, matches, input mode). Leaves the viewport where it is.
  const clearDebugSearch = () => {
    debugSearchInputRef.current = false;
    debugSearchQueryRef.current = '';
    debugSearchCurrentRef.current = 0;
    setDebugSearchInput(false);
    setDebugSearchQuery('');
    setDebugSearchCurrent(0);
  };
  // Set the query, recompute matches off the current lines, reset the cursor to the first match and
  // jump the viewport to it (reusing TUI-C11's scroll offset). Incremental: called on every keystroke.
  const setDebugSearch = (query: string) => {
    debugSearchQueryRef.current = query;
    setDebugSearchQuery(query);
    const matches = findMatches(debugLines, query);
    debugSearchCurrentRef.current = 0;
    setDebugSearchCurrent(0);
    if (matches.length > 0) {
      setDebugScroll(scrollOffsetForLine(matches[0], debugViewport, debugLines.length));
    }
  };
  // Move to the next (+1) / previous (-1) match with wrap-around and jump the viewport to it.
  const stepDebugSearch = (dir: number) => {
    const matches = debugMatches;
    if (matches.length === 0) return;
    const next = stepMatch(matches, debugSearchCurrentRef.current, dir);
    debugSearchCurrentRef.current = next;
    setDebugSearchCurrent(next);
    setDebugScroll(scrollOffsetForLine(matches[next], debugViewport, debugLines.length));
  };

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

  // Flip the tool-detail mode and commit the matching notice. Single-sourced so the `/verbose`
  // command and the Ctrl+T key handler give the user identical, state-aware feedback (TUI-C14).
  const toggleTools = useCallback(() => {
    const next = !toolsExpandedRef.current;
    toolsExpandedRef.current = next;
    setToolsExpanded(next);
    const { title, lines, tone } = toolsToggleNotice(next);
    push({ kind: 'notice', title, lines, tone: tone ?? 'info' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // TUI-C37 — apply a `/mouse` toggle. The session module owns the escape sequences, so this
  // updates the state the registry and the hint copy read, then asks it to act.
  const applyMouse = useCallback(
    (next: boolean) => {
      mouseEnabledRef.current = next;
      setMouseEnabled(next);
      props.onSetMouse?.(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // CFG-27 — apply an approvals RUNG change (`/approvals <rung>`). The runner owns the posture,
  // so ask it to apply the rung, mirror the LANDED posture into local state + ref (drives the
  // status badge), and commit the state-aware notice. Falls back to a clear system line when the
  // agent has no runner (the fixture agent omits the method).
  const applyApprovalRung = useCallback(
    (rung: ApprovalRung): void => {
      if (!agent.setApprovalRung) {
        push({
          kind: 'system',
          level: 'warning',
          text: 'Approvals are unavailable in this session.',
        });
        return;
      }
      // The notice is built from what the runner RETURNS, never from what we asked for, so the
      // copy can only ever describe the posture actually in force.
      const landed = agent.setApprovalRung(rung);
      approvalsRef.current = landed;
      setApprovals(landed);
      const { title, lines, tone } = approvalsRungNotice(landed);
      push({ kind: 'notice', title, lines, tone: tone ?? 'info' });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent]
  );

  // CFG-26 — `/approvals` with no argument: DISPLAY the posture. Read-only by construction; it
  // never touches the runner's state.
  const showApprovals = useCallback((): void => {
    if (!agent.getApprovals) {
      push({
        kind: 'system',
        level: 'warning',
        text: 'Approvals are unavailable in this session.',
      });
      return;
    }
    const { approvals: current, allowlist, deny, grants, trust } = agent.getApprovals();
    approvalsRef.current = current;
    setApprovals(current);
    const { title, lines, tone } = approvalsStatusNotice(current, allowlist, deny, grants, trust);
    push({ kind: 'notice', title, lines, tone: tone ?? 'info' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // EXT-70 §4.7.1 — `/approvals trust|untrust <server> <hint…>`: believe, or stop believing,
  // specific annotation hints from one MCP server for this session. Same division as the rung: the
  // runner owns the posture, applies the change and reports what LANDED, and the notice is built
  // from that — never from what was asked for.
  const applyMcpTrust = useCallback(
    (request: McpTrustRequest): void => {
      if (!agent.setMcpAnnotationTrust) {
        push({
          kind: 'system',
          level: 'warning',
          text: 'Approvals are unavailable in this session.',
        });
        return;
      }
      const change = agent.setMcpAnnotationTrust(request.server, request.hints, request.believe);
      const { title, lines, tone } = approvalsTrustNotice(change);
      push({ kind: 'notice', title, lines, tone: tone ?? 'info' });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent]
  );

  // Resolve the currently-shown approval (the queue head) and commit a brief notice so the
  // decision reads in the transcript (TUI-C14 notice conventions). Dequeues the head so the next
  // queued approval (if any) surfaces. Approve carries the chosen scope; reject is fail-closed.
  const resolveApproval = (decision: 'once' | 'session' | 'always' | 'reject'): void => {
    const head = pendingApproval;
    if (!head) return;
    if (decision === 'reject') {
      // EXT-58 (§7): hand the model the moves it has (re-call with a justification, a different
      // command, or ask the user) plus — when the rater named an already-granted alternative
      // (§4.4) — that tool and the clause saying it will not interrupt the user. This is the
      // message the MODEL sees; the on-screen notice below is unchanged.
      head.resolve({
        type: 'reject',
        message: buildRejectionMessage({
          source: 'user',
          toolName: head.pending.name,
          verdict: head.pending.safetyVerdict,
        }),
      });
      push({
        kind: 'notice',
        title: 'Command rejected',
        lines: ['The shell command was not run; the agent was told you declined.'],
        tone: 'warn',
      });
    } else {
      const scope: ToolApprovalScope = decision;
      head.resolve({ type: 'approve', scope });
      // CFG-28 (§4.2) — a `catastrophic` approval is NEVER sticky: the runner clamps the
      // allow-list write, so a `session`/`always` keypress grants exactly this one invocation and
      // the next variant prompts again. The scope is still sent unchanged (the clamp is core's,
      // and is the single chokepoint for every surface); the NOTICE is what has to be true, both
      // in its detail line and in the scope it names. §6: a control offered and then refused reads
      // as a bug, and a confirmation of a persistence that did not happen is the same failure with
      // the evidence hidden. Withdrawing `[a]lways` from the menu is [[TUI-C26]]'s.
      // EXT-70 §6 — the general form of the same rule. `grantPreview` is absent exactly where the
      // runner would store nothing, and `catastrophic` is one of its cases (the runner discards the
      // grant for that outcome), so the confirmation branches on WHAT WAS STORED rather than on the
      // one outcome. Without that, a command that does not statically resolve — or a tool call
      // nothing can attribute — was confirmed as remembered while the store stayed empty, which is
      // the same failure the catastrophic clamp exists to prevent, one case further along.
      const sticky = head.pending.grantPreview !== undefined;
      const catastrophic = head.pending.safetyVerdict?.outcome === 'catastrophic';
      const effectiveScope: ToolApprovalScope = sticky ? scope : 'once';
      const describe = (): string => {
        if (!sticky && scope !== 'once') {
          return catastrophic
            ? 'Approved this once — a command rated catastrophic is never remembered, so the next ' +
                'one like it will ask again.'
            : 'Approved this once — there is nothing about this call that can be remembered, so ' +
                'the next one like it will ask again.';
        }
        // EXT-71 §3.1 — a grant is exactly the command the human saw, so the confirmation says
        // that and not "this operation". A longer command that merely starts with it asks again.
        if (scope === 'session')
          return 'Approved — this exact command will not ask again this session.';
        if (scope === 'always')
          return 'Approved and remembered — this exact command is saved to the project allow-list.';
        return 'Approved this single invocation only.';
      };
      push({
        kind: 'notice',
        title: `Command approved (${effectiveScope})`,
        lines: [describe()],
        tone: 'info',
      });
    }
    setApprovalQueue((q) => q.slice(1));
  };

  const handleSubmit = useCallback(
    (value: string) => {
      if (!value.trim()) return;

      const running = runningRef.current;
      const parsed = parseSlashCommand(value);

      // While a turn is streaming ("during inference") the prompt stays mounted so the user can
      // flip auto-approval or inspect state mid-turn (EXT-12). Only slash commands are honoured
      // then — a plain message can't be sent until the turn finishes — and dispatch itself refuses
      // any command not marked availableDuringRun. Outside a run, everything behaves as before.
      if (running && !parsed) {
        push({
          kind: 'system',
          level: 'warning',
          text: 'The agent is working — only slash commands (e.g. /approvals) are available right now.',
        });
        return;
      }

      // Legacy bare `exit` keyword still quits (idle only — guarded above while running).
      if (isPlainExit(value)) {
        quit();
        return;
      }

      // A line starting with `/` is a slash command: dispatch through the registry instead
      // of sending it to the model. Unknown commands become a friendly system line.
      if (parsed) {
        const result = dispatchSlashCommand(
          parsed,
          registry,
          {
            mode,
            modelDisplayName: modelDisplayName ?? '',
            turnCount: turnCountRef.current,
            toolsExpanded: toolsExpandedRef.current,
            debugVisible: debugVisibleRef.current,
            // TUI-C37 — undefined (not false) when this surface has no mouse layer, so `/mouse`
            // says it is unavailable rather than silently reporting "off".
            mouseEnabled: props.mouseEnabled === undefined ? undefined : mouseEnabledRef.current,
            configSummary: props.configSummary,
            // TUI-C19 — the actual validation warnings so `/config` renders the details the
            // standing advisory line points at.
            configWarnings: props.advisories,
            historySummary: props.historySummary,
            insightsSummary: props.insightsSummary,
            historySearch: props.historySearch,
            // Committed turns' thinking, in transcript order (index 0 = turn 1), for /reasoning.
            turnReasonings: transcript
              .filter(
                (i): i is Extract<TranscriptItem, { kind: 'assistant' }> => i.kind === 'assistant'
              )
              .map((i) => i.turn.reasoning),
            // GS2-46 — the full live transcript + resolved config for /debug-dump, plus the
            // injected fs-writing implementation (undefined for the fixture agent).
            transcript,
            resolvedConfig: props.resolvedConfig,
            dumpDebugSession: props.dumpDebugSession,
          },
          { duringRun: running }
        );
        if (result.clearTranscript) {
          setTranscript([]);
          setSubagents(initialSubagentTree());
          setDebugHistory([]);
          setDebugSystem([]);
          setDebugTools([]);
          setDebugMcp([]);
          setDebugResponse([]);
          // Show visible feedback for the clear.
          //
          // TUI-C48 re-decided the mechanism, it did not silently break it. TUI-C12 chose a
          // scroll-and-clear "bump up" that deliberately preserved the terminal's own scrollback
          // and never emitted ESC[3J. In the alternate screen there is no scrollback to preserve
          // and the transcript is a buffer we own, so emptying that buffer IS the clear: the
          // viewport re-renders with nothing in it and no terminal escape is written at all.
          setClearedBanner(true);
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
          // Ctrl+T). The command's own `result.notice` is intentionally not pushed for /verbose —
          // toggleTools owns the notice so the copy matches the state actually applied.
          toggleTools();
        }
        if (result.setMouse !== undefined) {
          applyMouse(result.setMouse);
        }
        if (result.approvals) {
          // The runner owns the posture; show it, or apply the requested mode and commit the
          // notice for the LANDED state via the shared helper (single-sourced with the approval
          // prompt's y key). CFG-26.
          if ('show' in result.approvals) showApprovals();
          else if ('trust' in result.approvals) applyMcpTrust(result.approvals.trust);
          else applyApprovalRung(result.approvals.rung);
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
              // Drop any active search so the pane reopens clean (TUI-C21).
              clearDebugSearch();
            }
            return next;
          });
        }
        // TUI-C18 — /reasoning reprint: commit a reasoning block that reuses the TUI-C15 styling,
        // tagged with the turn it was recalled from so a recalled block is self-describing.
        if (result.reprintReasoning) {
          push({ kind: 'reasoning', ...result.reprintReasoning });
        }
        // Commit a structured notice (TUI-C14). /verbose and the /approvals family own their
        // notices above (the state-aware copy is committed there), so skip result.notice in those
        // cases — otherwise every approvals command double-prints.
        if (result.notice && !result.toggleTools && !result.approvals) {
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
    [
      runTurn,
      quit,
      registry,
      mode,
      modelDisplayName,
      // /reasoning and /debug-dump read the committed turns, so the handler has to be re-bound
      // when they change. PromptInput calls `onSubmit` straight out of its own render closure and
      // never lists it as a dependency, so re-binding costs nothing.
      transcript,
      toggleTools,
      applyApprovalRung,
      showApprovals,
      applyMcpTrust,
      applyMouse,
    ]
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
    //
    // CFG-27 removed the `y` key ("switch to auto-approve and approve this one"). Spec §6's
    // escalation menu offers five choices — ask to explain · approve · always approve · reject ·
    // always reject — and a per-prompt change of RUNG is not one of them: the ladder has no
    // "turn the gate down from here" action, so keeping the key would have meant inventing one.
    // [[TUI-C26]] builds the five-choice menu (and the §6.1 attack banner) on this seam.
    if (pendingApproval) {
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
    // the keystroke and insert a stray 't'. The `/verbose` slash command covers the idle case.
    if (key.ctrl && input === 't' && runningRef.current) {
      // Share the /verbose helper so the same state-aware notice is committed (TUI-C14).
      toggleTools();
      return;
    }

    if (debugFocusedRef.current) {
      // TUI-C21 — while TYPING the query, the search input OWNS the keyboard: printable chars
      // extend the query, Backspace trims it, Enter confirms (keeps the highlights, leaves input
      // mode), Esc clears. This must come first so `m`/`n`/Tab are typed into the query rather than
      // maximising / navigating / cycling. `/` here is not the app slash line — the prompt is
      // unmounted while the pane is focused, so `/` can only mean "search this pane" (the seam).
      if (debugSearchInputRef.current) {
        if (key.escape) {
          clearDebugSearch();
          return;
        }
        if (key.return) {
          // Confirm: leave typing mode but keep the query + highlights (n/N now navigate).
          debugSearchInputRef.current = false;
          setDebugSearchInput(false);
          return;
        }
        if (key.backspace || key.delete) {
          setDebugSearch(debugSearchQueryRef.current.slice(0, -1));
          return;
        }
        // Ignore navigation keys while typing; only literal characters extend the query.
        if (
          key.tab ||
          key.upArrow ||
          key.downArrow ||
          key.leftArrow ||
          key.rightArrow ||
          key.pageUp ||
          key.pageDown
        ) {
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setDebugSearch(debugSearchQueryRef.current + input);
        }
        return;
      }
      // Esc layering: clear an active search first (less-style), else unfocus the pane.
      if (key.escape) {
        if (debugSearchQueryRef.current) {
          clearDebugSearch();
          return;
        }
        setDebugFocused(false);
        debugFocusedRef.current = false;
        return;
      }
      // `/` opens the search input (scoped to pane focus — the seam).
      if (input === '/') {
        debugSearchInputRef.current = true;
        debugSearchQueryRef.current = '';
        debugSearchCurrentRef.current = 0;
        setDebugSearchInput(true);
        setDebugSearchQuery('');
        setDebugSearchCurrent(0);
        return;
      }
      // n / N step to the next / previous match with wrap-around (only when a search is active).
      if (input === 'n') {
        stepDebugSearch(1);
        return;
      }
      if (input === 'N') {
        stepDebugSearch(-1);
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
        // Matches are tab-local; recompute happens via the memo, reset the cursor to the first
        // match of the new tab (the query persists across tabs).
        debugSearchCurrentRef.current = 0;
        setDebugSearchCurrent(0);
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

    // TUI-C48 — the conversation region's own scroll bindings. Everything above this point is a
    // prior claimant on the same keys, and the ordering is the specification rather than an
    // accident of where the code was added: a pending approval owns the whole keyboard, Esc while
    // a turn runs aborts it, and the focused debug pane owns Esc and PageUp/PageDown for its own
    // viewport. Transcript scrolling is the ELSE branch of all three.
    if (key.escape) {
      // Esc's third meaning, after abort and after the debug pane: come back to the newest output.
      scrollToBottom();
      return;
    }
    if (key.ctrl && key.home) {
      scrollToStart();
      return;
    }
    if (key.ctrl && key.end) {
      scrollToBottom();
      return;
    }
    if (key.pageUp) {
      scrollByPages(-1);
      return;
    }
    if (key.pageDown) {
      scrollByPages(1);
      return;
    }

    // Tab focuses the docked panel when it is visible and no turn is running — unless the prompt's
    // slash-command menu is open, in which case Tab completes the highlighted command (TUI-C10).
    if (key.tab && debugVisible && !runningRef.current && !slashMenuActiveRef.current) {
      setDebugFocused(true);
      debugFocusedRef.current = true;
    }

    // Typing returns the view to the end, because a message being composed belongs next to the
    // output it answers. Deliberately NOT swallowed — the character still reaches the prompt, so
    // this cannot eat the first letter of what the user is writing.
    if (isComposingKeystroke(input, key)) scrollToBottom();
  });

  // The wheel, decoded by the TUI-C37 mouse layer. A notch is three lines and Shift makes it a
  // page — Andrew's bindings. Subscribing separately from `MouseProvider` is deliberate: hit
  // regions dispatch by coordinate, and scrolling is the one mouse gesture that is about the whole
  // region rather than about whatever sits under the pointer.
  const subscribeMouse = props.subscribeMouse;
  useEffect(() => {
    if (!subscribeMouse || !mouseEnabled) return;
    return subscribeMouse((event) => {
      if (event.type !== 'wheel') return;
      const direction = event.wheel === 'up' ? -1 : 1;
      if (event.shift) scrollByPages(direction);
      else scrollByRows(direction * WHEEL_ROWS_PER_NOTCH);
    });
  }, [subscribeMouse, mouseEnabled, scrollByPages, scrollByRows]);

  // Run an initial message once on mount, if supplied. Started from a microtask rather than from
  // the effect body itself: `runTurn` pushes the user line and flips `running`/`live` before its
  // first await, so calling it here would commit the mount frame and immediately supersede it — the
  // cascading render `set-state-in-effect` names. A microtask runs before any I/O, so the turn
  // still starts in the same tick. The flag makes the kickoff cancellable, since an effect that
  // schedules work owes its cleanup a way to stop it.
  //
  // Not a pure frame difference, and the ordering is the part worth knowing: deferring also moves
  // `runTurn`'s synchronous prefix to AFTER the `subscribeStatus` and `subscribeDebug` effects
  // below, which previously had not mounted yet. On the first turn only, WARNING/ERROR from that
  // prefix now reach the transcript, and — since `subscribeDebug` filters nothing — every capture
  // it emits now reaches the debug panel. That is the intended direction (a subscriber that exists
  // sees more, not less), but it is a real behavioural change and not merely an invisible frame.
  useEffect(() => {
    if (!initialMessage || !initialMessage.trim()) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void runTurn(initialMessage);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route agent status updates (warnings/errors) into the transcript instead of stdout,
  // which would otherwise corrupt Ink's frame. INFO/DEBUG system lines are suppressed in the
  // TUI: the agent's per-turn chatter (`Requested tools`, `Loaded tools`, `Workdir`, `Model`,
  // `Thinking…`) duplicates what the TUI already renders (live tool-call cards + spinner + the
  // typed AgentStreamEvent content path). Plain-CLI keeps them via defaultStatusCallback. Only
  // WARNING/ERROR (and content levels) reach the transcript so genuine signals still surface.
  useEffect(() => {
    if (!props.subscribeStatus) return;
    return props.subscribeStatus((level, message) => {
      if (level === 'INFO' || level === 'DEBUG') return;
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
        setDebugSystem(capture.system.split('\n'));
        setDebugTools(capture.tools.split('\n'));
        setDebugMcp(capture.mcp.split('\n'));
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

  // Extract active checklist items from live turn or transcript so it stays pinned at the bottom.
  const activeChecklist = useMemo(
    () => extractActiveChecklist(live, transcript),
    [live, transcript]
  );

  return (
    // The measured terminal size, published once for the whole frame. A rule is rendered per
    // separator and per notice and a session mounts a screenful of them, so components measuring
    // for themselves made the stdout listener count a function of how much conversation was on
    // screen — and crossing Node's default of ten writes a memory-leak warning into the user's
    // alternate screen through Ink's patched console.
    <TerminalSizeProvider size={terminalSize}>
      {/* TUI-C37 — the provider measures this frame and owns the hit-region registry, so a
          component anywhere below can claim a clickable rectangle without knowing where the frame
          sits on screen. */}
      <MouseProvider subscribe={props.subscribeMouse} enabled={mouseEnabled}>
        {/* TUI-C48 — the full-screen frame. Its height is EXACTLY the terminal height, which does
          three things at once: it pins the dock below to the terminal floor, it anchors the frame
          at screen row 0 in the alternate screen (a short first frame paints wherever the cursor
          happened to be), and it is the clamp — a frame taller than the screen loses its top rows
          silently, as missing content rather than as an error. */}
        <Box flexDirection="column" height={terminalRows}>
          {/* The conversation region: the tail of the transcript, then the streaming turn and the
            intro chrome, pinned to the bottom of whatever the dock leaves. */}
          <TranscriptViewport
            items={transcript}
            budgetRows={terminalRows}
            columns={terminalColumns}
            toolsExpanded={toolsExpanded}
            scroll={transcriptScroll}
            regionRows={transcriptRegionRows}
            geometry={transcriptGeometry}
          >
            {clearedBanner ? <ClearBanner /> : null}
            {/* TUI-C33 — the ASCII-art launch banner, ABOVE the ready message and on the same intro
              lifecycle, so it greets the user on arrival and gets out of the way once the
              conversation starts. `showLaunchBanner` carries the session module's isTTY gate. */}
            {showIntro && props.showLaunchBanner ? (
              <LaunchBanner model={modelDisplayName} provider={props.modelProviderType} />
            ) : null}
            {showIntro ? <Text dimColor>{readyMessage.trim()}</Text> : null}
            {live ? <LiveTurn turn={live} toolsExpanded={toolsExpanded} streaming /> : null}
          </TranscriptViewport>
          {/* The dock: everything from here down is pinned to the terminal floor and never scrolls.
            `flexShrink: 0` is what makes the conversation region — not the controls — give up the
            rows when the terminal is short. */}
          <Box flexDirection="column" flexShrink={0}>
            {/* Docked debug/subagent panel: full-width, above the input dock. Toggled by /debug;
          Tab focuses it for PageUp/PageDown scrolling. */}
            {debugVisible ? (
              <DebugPanel
                subagents={subagents}
                historyLines={debugHistory}
                systemLines={debugSystem}
                toolsLines={debugTools}
                mcpLines={debugMcp}
                responseLines={debugResponse}
                activeTab={debugTab}
                scrollOffset={debugScroll}
                focused={debugFocused}
                viewportHeight={debugViewport}
                maximized={debugMaximized}
                searchQuery={debugSearchQuery}
                searchActive={debugSearchInput}
                matchCount={debugMatches.length}
                currentMatchIndex={debugSearchCurrent}
                currentMatchLine={currentMatchLine}
              />
            ) : null}
            {/* Input dock: bracketed top and bottom by rules so the status bar, prompt and hint
          read as a distinct control zone rather than blending into the conversation. */}
            {/* Pinned active checklist panel */}
            {activeChecklist ? <ChecklistPanel items={activeChecklist} /> : null}
            {/* Tool-approval affordance (EXT-9 Phase B2): when an approval is pending it sits just above
          the input dock, owns the keyboard, and suspends the normal prompt below. */}
            {pendingApproval ? <ApprovalPrompt pending={pendingApproval.pending} /> : null}
            <Rule />
            {/* TUI-C19 — persistent startup-advisory line. Lives here in the pinned dock, right by the
          status bar, so a config-validation warning stays on screen and survives transcript
          growth instead of scrolling out of the conversation region (DL-1). Renders nothing when
          there are no advisories. */}
            <NoticeBar advisories={props.advisories} />
            {/* Companion to NoticeBar for MCP connection failures (own line, own pointer → /debug MCP
          tab). Without it a failed MCP server is invisible in the TUI — the connect-time
          displayWarning scrolls under Ink's first frame. */}
            <McpFailureBar failures={props.mcpFailures} />
            <StatusBar
              running={running}
              mode={mode}
              modelDisplayName={modelDisplayName}
              turnCount={turnCount}
              debugHint={debugVisible && !debugFocused}
              approvals={
                approvals
                  ? {
                      rung: approvals.rung,
                      raterProfile: approvals.rater,
                    }
                  : undefined
              }
            />
            {/* The prompt stays mounted while a turn streams (EXT-12), so the user can run mid-turn
          slash commands like /approvals; handleSubmit + dispatch gate what's allowed then. It
          is suspended only when the debug panel is focused or a tool approval owns the keyboard. */}
            {!debugFocused && !pendingApproval ? (
              <PromptInput
                onSubmit={handleSubmit}
                commands={registry}
                onMenuStateChange={(active) => {
                  slashMenuActiveRef.current = active;
                }}
              />
            ) : null}
            <Text dimColor>{exitMessage.trim()}</Text>
            <Rule />
          </Box>
        </Box>
      </MouseProvider>
    </TerminalSizeProvider>
  );
}
