/**
 * [[TUI-C26]] PTY e2e config: a real lean `code` session on a RATED rung, whose auto-rater is
 * scripted so the `reason` reaching the approval dialog is chosen by the test.
 *
 * The sibling `approval.gsloth.config.mjs` sits on `write` on purpose — the rung that gates the
 * shell and consults no model — because it tests the human seam and a scripted model cannot produce
 * a structured verdict. This one needs the opposite: the rater's `reason` is the second
 * model-authored string on the dialog, and there is no way to see it framed without a rating that
 * actually happened. So the model implements `withStructuredOutput` too, and `assisted` is the rung
 * at which a `destructive` verdict escalates to the human rather than back to the agent.
 *
 * Hermetic and key-free like every other fixture here: nothing reaches a network, and the command
 * is inert because no test in this suite ever approves one.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { FRAMING_RATER_REASON } from './framingCommands.mjs';

class ScriptedRatedModel extends BaseChatModel {
  callCount = 0;
  _llmType() {
    return 'scripted-rater-e2e';
  }
  bindTools() {
    return this;
  }

  /**
   * The rating seam. `rateShellCommand` calls this and then `.invoke()` on what comes back, so the
   * verdict is returned whole; it is re-validated against the real schema on the way in, which is
   * what makes this a test of the production path rather than of a stub.
   *
   * `destructive` rather than `catastrophic`: §4.2 withdraws the sticky grants for `catastrophic`,
   * and this case wants the ordinary escalation with the whole menu on screen.
   */
  withStructuredOutput() {
    return {
      invoke: async () => ({ outcome: 'destructive', reason: FRAMING_RATER_REASON }),
    };
  }

  async _generate(messages) {
    this.callCount += 1;
    const last = messages[messages.length - 1];
    // Deliberately resolvable — one command word, one argument, no composition and no substitution
    // — so a sticky grant is on offer and the whole five-line menu is on screen behind the reason.
    const command = 'echo framing-rated-command-marker';
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('approval-final-answer-marker')
      : new AIMessage({
          content: '',
          tool_calls: [
            { name: 'run_shell_command', args: { command }, id: `call-${this.callCount}` },
          ],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

export async function configure() {
  return {
    llm: new ScriptedRatedModel({}),
    modelDisplayName: 'scripted-rater-e2e',
    writeOutputToFile: false,
    approvals: 'assisted',
  };
}
