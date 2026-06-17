import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { foldEvents, initialTurnViewModel, type TurnViewModel } from '#src/tui/viewModel.js';
import type { TranscriptItem, TuiAppProps } from '#src/tui/types.js';
import { Transcript } from '#src/tui/components/Transcript.js';
import { LiveTurn } from '#src/tui/components/LiveTurn.js';
import { StatusBar } from '#src/tui/components/StatusBar.js';
import { PromptInput } from '#src/tui/components/PromptInput.js';
import {
  createCommandRegistry,
  dispatchSlashCommand,
  parseSlashCommand,
} from '#src/tui/slashCommands.js';

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
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const runningRef = useRef(false);
  const turnCountRef = useRef(0);
  const { exit } = useApp();

  // Built once per session; a plain array so later layers (EXT-5) could append commands.
  const registry = useMemo(() => createCommandRegistry(), []);

  const nextId = () => (idRef.current += 1);
  // Distributive omit so each union member keeps its own fields (a plain
  // Omit<TranscriptItem,'id'> collapses to the shared `kind` key only).
  const push = (item: DistributiveOmitId<TranscriptItem>) =>
    setTranscript((t) => [...t, { ...item, id: nextId() } as TranscriptItem]);

  const runTurn = useCallback(
    async (userInput: string) => {
      push({ kind: 'user', text: userInput });
      const ac = new AbortController();
      abortRef.current = ac;
      runningRef.current = true;
      setRunning(true);
      let vm = initialTurnViewModel();
      setLive(vm);
      try {
        for await (const event of agent.runTurn(userInput, ac.signal)) {
          vm = foldEvents(vm, event);
          setLive(vm);
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
        if (result.clearTranscript) setTranscript([]);
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

  // Esc aborts the in-flight turn (stdin is uncontended here — the event-stream path does
  // not register gsloth's readline Esc handler, so Ink owns raw mode cleanly).
  useInput((_input, key) => {
    if (key.escape && runningRef.current) {
      abortRef.current?.abort();
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

  return (
    <Box flexDirection="column">
      <Transcript items={transcript} />
      {!initialMessage ? <Text dimColor>{readyMessage.trim()}</Text> : null}
      {live ? <LiveTurn turn={live} /> : null}
      <StatusBar
        running={running}
        mode={mode}
        modelDisplayName={modelDisplayName}
        turnCount={turnCount}
      />
      {!running ? <PromptInput onSubmit={handleSubmit} /> : null}
      {!running ? <Text dimColor>{exitMessage.trim()}</Text> : null}
    </Box>
  );
}
