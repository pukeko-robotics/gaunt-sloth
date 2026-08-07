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
  /**
   * The printed marker ('approval-out-marker') deliberately differs from any literal substring of
   * the command text, so the e2e can distinguish "the pending command is DISPLAYED in the approval
   * prompt" from "the command actually EXECUTED". `node` is guaranteed present (it runs this very
   * CLI) and the quoting works in POSIX shells and cmd.exe alike.
   *
   * The COMPOUND variant, requested by a user turn containing `unresolvable-compound`, is a command
   * that does not statically resolve — so no allow entry of any matcher could ever match it, no
   * sticky grant is on offer, and the §6 menu must not show a sticky control it would then refuse.
   * It is the negative half of that pair; the plain command above is the positive.
   */
  #command(compound) {
    // The marker stays SPLIT inside the emitted command, never concatenated here: the whole point
    // is that 'approval-out-marker' is not a literal substring of the command text, so the e2e can
    // tell "the pending command is displayed" from "the command ran".
    const say = (expr) => `node -e "console.log(${expr})"`;
    const marker = say(`'approval-'+'out-'+'marker'`);
    return compound ? `${say(`'approval-'+'first'`)} && ${marker}` : marker;
  }

  async _generate(messages) {
    this.callCount += 1;
    const last = messages[messages.length - 1];
    // Whether THIS conversation asked for the unresolvable variant. Read off the whole message
    // list rather than the newest message, so it still holds on the post-tool turn.
    // The trigger token is deliberately one no prompt, tool description or approvals copy contains,
    // so a wording change elsewhere cannot silently switch every case onto this branch.
    const compound = messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('unresolvable-compound')
    );
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('approval-final-answer-marker')
      : new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'run_shell_command',
              args: { command: this.#command(compound) },
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
    // (`assisted`) would rate first, and the scripted model above cannot produce a structured
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
