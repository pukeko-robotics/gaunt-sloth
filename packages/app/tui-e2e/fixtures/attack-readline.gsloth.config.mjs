/**
 * [[TUI-C68]] PTY e2e config: the same always-`attack` rater as `attack.gsloth.config.mjs`, with
 * the TUI turned OFF so the session starts on the plain readline surface.
 *
 * §5 names both surfaces, and the readline one answers the banner differently in a way only a real
 * terminal shows: `rl.question` reads a whole LINE in cooked mode, so there is no keystroke to
 * intercept and every line that is not the phrase stops the run. A unit spec can assert what the
 * callback returns; only this can show that a line typed at a real prompt reaches it.
 */
import { configure as attackConfigure } from './attack.gsloth.config.mjs';

export async function configure() {
  return { ...(await attackConfigure()), tui: false };
}
