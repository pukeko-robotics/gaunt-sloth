/**
 * The terminal sequence that "bumps up" the screen like `clear`/Ctrl+L while *preserving*
 * scrollback. We deliberately do NOT emit the clear-scrollback escape `ESC[3J` (which would
 * destroy history and defeat the point):
 *  - First push a screenful of newlines so the prior content scrolls up and out of the
 *    visible viewport — but stays reachable by scrolling/wheeling up (it lives in scrollback).
 *  - Then home the cursor (`ESC[H`) and clear from the cursor to the end of the *visible*
 *    screen (`ESC[J`, i.e. `ESC[0J`) so what re-renders lands cleanly at the top with no
 *    artifacts.
 * `rows` is the live terminal height; we fall back to a sensible default when it is unknown.
 *
 * Used both by `/clear` (TUI-C12) and on interactive launch (TUI-C13).
 */
export function viewportBumpSequence(rows: number | undefined): string {
  const height = rows && rows > 0 ? rows : 24;
  // newlines (bump prior content into scrollback) + cursor home + clear-to-end-of-visible-screen.
  // NOTE: `\x1b[J` is clear-to-end-of-screen (NOT `\x1b[3J`, which would erase scrollback).
  return '\n'.repeat(height) + '\x1b[H' + '\x1b[J';
}
