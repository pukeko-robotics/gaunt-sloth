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
    // Hermetic and quiet: no per-run md log in the fixtures dir, no history store writes.
    writeOutputToFile: false,
    // CFG-27 — `write` is set EXPLICITLY, not inherited. This suite exercises the EXT-52 HUMAN
    // approval seam (interrupt → <ApprovalPrompt> → resume), and `write` is the rung that gates
    // the shell while consulting NO model: it always escalates to the human. The default rung
    // (`auto-safe`) would rate first, and the scripted model above cannot produce a structured
    // verdict, so it would fail-closed to `destructive` and escalate — the right prompt for the
    // wrong reason, and one that would stop testing the human seam the moment the rating path
    // changed. Rater behaviour belongs in its own coverage, not smuggled into this guard.
    //
    // CFG-27 also retired `persistAllowlist` (§3: persistence is a per-decision choice at the
    // prompt). Nothing in this suite may press `[a]`/always — that would write
    // `shell-allowlist.json` into this tracked fixtures dir, since the allow-list path resolves
    // against the PROJECT dir, not the throwaway HOME the suite overrides.
    approvals: 'write',
  };
}
