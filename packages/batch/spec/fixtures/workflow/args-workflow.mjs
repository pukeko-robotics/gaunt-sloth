// Echoes ctx.args verbatim — the value parsed from `--args <json>`.
export default async function argsWorkflow(ctx) {
  return ctx.args;
}
