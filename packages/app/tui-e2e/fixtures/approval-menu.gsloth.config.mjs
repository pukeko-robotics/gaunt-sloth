/**
 * [[TUI-C26]] task 2 PTY e2e config: a real lean `code` session on the **`auto`** rung, whose
 * auto-rater is scripted so the OUTCOME reaching the approval dialog is chosen by the test.
 *
 * `auto` is the one rung that produces all three of this task's screens from a single config, and
 * it produces them the way production does rather than by hand-building an interrupt:
 *
 * - a **`destructive`** verdict is negotiated back to the agent (§5), so proposing the same command
 *   three times drives the exchange to §5.3's terminus and the human sees the whole transcript —
 *   which is the point of showing it at all: *that the agent proposed the same command three times
 *   unchanged* is invisible if only the last attempt is shown;
 * - a **`catastrophic`** verdict escalates immediately with no rounds, and the runner clamps every
 *   sticky grant away (§4.2), which is what reduces the menu;
 * - and both carry a rating, so the severity treatment is on screen either way.
 *
 * Hermetic and key-free like every other fixture here. **Nothing may actually run**: the commands
 * are `echo`, and no test in the suite approves one — the only sticky answer any of them gives is
 * `[d]`, which records a session refusal and writes nothing to disk (unlike `[a]`, which would drop
 * `shell-allowlist.json` into this tracked fixtures dir).
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';

/**
 * The cases, keyed by a token a user turn carries. The tokens are deliberately ones no prompt, tool
 * description or approvals copy contains, so a wording change elsewhere cannot silently reroute an
 * ordinary case onto one of these.
 */
const CASES = {
  // Negotiated: three proposals of the same command, each answered `destructive`, so the third
  // reaches the human with all three rounds behind it.
  'menu-negotiate': {
    outcome: 'destructive',
    reason: 'this rewrites history that is not yours to rewrite',
    // Resolvable, so a sticky GRANT is on offer too and the full menu is on screen behind the
    // transcript — which is what makes the reduced menu of the other case a difference.
    command: 'echo menu-negotiate-marker',
    proposals: 3,
  },
  // Immediate: §4.2 gives a catastrophic verdict no rounds at all, and withdraws every grant.
  'menu-catastrophic': {
    outcome: 'catastrophic',
    reason: 'this cannot be undone from inside the session',
    // ALSO resolvable — so the grant is withdrawn by the VERDICT rather than by the command's
    // shape, which is the only way the reduced menu proves what it claims to.
    command: 'echo menu-catastrophic-marker',
    proposals: 1,
  },
};

class ScriptedMenuModel extends BaseChatModel {
  /** The case the current conversation selected, read by the rating seam below. */
  #chosen = CASES['menu-negotiate'];

  _llmType() {
    return 'scripted-menu-e2e';
  }
  bindTools() {
    return this;
  }

  /**
   * The rating seam. `rateShellCommand` calls this and then `.invoke()` on what comes back, so the
   * verdict travels the production path — the shared structured-output boundary and the real schema
   * validate it on the way in — rather than being injected past it.
   */
  withStructuredOutput() {
    return {
      invoke: async () => ({ outcome: this.#chosen.outcome, reason: this.#chosen.reason }),
    };
  }

  async _generate(messages) {
    const said = (token) =>
      messages.some((m) => typeof m.content === 'string' && m.content.includes(token));
    this.#chosen =
      CASES[Object.keys(CASES).find((token) => said(token))] ?? CASES['menu-negotiate'];
    // How many times this conversation has already proposed the command. Read off the message list
    // rather than counted on the instance, so a replayed history cannot make the model think it has
    // argued more (or less) than the transcript shows.
    const proposals = messages.filter(
      (m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    ).length;
    if (proposals >= this.#chosen.proposals) {
      const message = new AIMessage('approval-final-answer-marker');
      return { generations: [{ message, text: 'approval-final-answer-marker' }] };
    }
    // A justification every round, because §5.4's two-voice rendering has only one voice to show
    // without it: `agent justified:` is the agent's turn, and the rater's answer is the other.
    const message = new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'run_shell_command',
          args: {
            command: this.#chosen.command,
            justification: `menu-justification-marker round ${proposals + 1}`,
          },
          id: `call-${proposals + 1}`,
        },
      ],
    });
    return { generations: [{ message, text: '' }] };
  }
}

export async function configure() {
  return {
    llm: new ScriptedMenuModel({}),
    modelDisplayName: 'scripted-menu-e2e',
    writeOutputToFile: false,
    // `auto` — the negotiating rung. `assisted` would send the first `destructive` straight to the
    // human, and there would be no exchange to render.
    approvals: 'auto',
  };
}
