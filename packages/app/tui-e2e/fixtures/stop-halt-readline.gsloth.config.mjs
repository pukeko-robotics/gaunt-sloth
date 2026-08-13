/**
 * [[TUI-C71]] PTY e2e config: the same always-`attack` rater and the same hostile command as
 * `stop-halt.gsloth.config.mjs`, with the TUI turned OFF so the session runs on the plain readline
 * surface.
 *
 * Both surfaces render the halt, through different code, and only a real terminal shows what each
 * one puts on the screen.
 */
import { configure as stopConfigure } from './stop-halt.gsloth.config.mjs';

export async function configure() {
  return { ...(await stopConfigure()), tui: false };
}
