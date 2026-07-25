/**
 * EXT-52 PTY e2e config: a REAL lean `code` session (no GTH_TUI_E2E_FIXTURE fixture agent — the
 * actual GthAgentRunner + GthLangChainAgent + createAgent graph run) whose model is scripted, so
 * the run is hermetic and key-free. The model requests `run_shell_command` once per user turn and
 * concludes after it observes a tool result (the executed command's output OR the HITL rejection
 * ToolMessage) — exactly the shape needed to drive the per-command approval interrupt that EXT-52
 * restores on the lean (default) backend, end to end into the TUI's <ApprovalPrompt>.
 *
 * Imports resolve from this file's location (packages/app/tui-e2e/fixtures) up to packages/app's
 * own @langchain/core dependency, so no extra devDependency is needed.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

class ScriptedShellCallingModel extends BaseChatModel {
  callCount = 0;
  _llmType() {
    return 'scripted-e2e';
  }
  // The ReAct graph binds tools to the model; responses are scripted, so binding is a no-op.
  bindTools() {
    return this;
  }
  async _generate(messages) {
    this.callCount += 1;
    const last = messages[messages.length - 1];
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('approval-final-answer-marker')
      : new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'run_shell_command',
              // The printed marker ('approval-out-marker') deliberately differs from any literal
              // substring of the command text, so the e2e can distinguish "the pending command is
              // DISPLAYED in the approval prompt" from "the command actually EXECUTED". `node` is
              // guaranteed present (it runs this very CLI) and the quoting works in POSIX shells
              // and cmd.exe alike.
              args: { command: `node -e "console.log('approval-'+'out-'+'marker')"` },
              id: `call-${this.callCount}`,
            },
          ],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

export async function configure() {
  return {
    llm: new ScriptedShellCallingModel({}),
    modelDisplayName: 'scripted-e2e',
    // Hermetic and quiet: no per-run md log in the fixtures dir, no history store writes, and the
    // shell approval allow-list is never persisted to disk (an `always` grant would otherwise
    // write into this tracked fixtures dir — CFG-26 moved that knob to `approvals`).
    writeOutputToFile: false,
    // CFG-26 — `mode: "ask"` is set EXPLICITLY, not inherited. This suite exercises the EXT-52
    // HUMAN approval seam (interrupt → <ApprovalPrompt> → resume), and interactive `code` on a TTY
    // now defaults to `mode: "auto"` with the AI rater ON. Under that default the prompt still
    // appeared, but only by accident: the rater ran against the scripted model above, which cannot
    // produce a structured verdict, so it fail-closed to `danger` — which happens to sit exactly on
    // the default `escalate: "danger"` threshold and therefore escalated to the human. Pinning
    // `ask` removes a pointless rater round-trip through the scripted model AND stops the suite
    // silently ceasing to test the human seam if the default threshold ever moves. Rater behaviour
    // belongs in its own coverage, not smuggled into the EXT-52 regression guard.
    approvals: { mode: 'ask', persistAllowlist: false },
  };
}
