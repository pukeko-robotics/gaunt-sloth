/**
 * @packageDocumentation
 * The message the ACP (Agent Client Protocol) entry points print before exiting non-zero.
 *
 * **The `gaunt-sloth-acp` bin and `gaunt-sloth --acp-agent` still exist and still resolve.** They
 * are declared in `package.json`, so removing them is a packaging break for anyone who wired the
 * command into an editor: the host would report a missing executable, which reads as a broken
 * install rather than a retired feature. Exiting non-zero with this text instead fails the host
 * fast and tells its user what happened and what replaces it.
 *
 * Kept in one module rather than inlined at each entry point so the two bins and the spec that
 * pins them cannot drift apart — a stub whose promise is only kept by one of its two doors is not
 * a promise.
 */

/** Text both ACP entry points write to stderr before exiting non-zero. */
export const ACP_STUB_MESSAGE =
  'The Gaunt Sloth ACP (Agent Client Protocol) server is not available. It was built on the ' +
  'deepagents runtime, which Gaunt Sloth no longer depends on; EXT-46 rebuilds ACP on Gaunt ' +
  "Sloth's own agent, and this command starts working again when it lands. Until then, use the " +
  'AG-UI server (gth api) for a programmatic front door, or gth chat / gth code in a terminal.';
