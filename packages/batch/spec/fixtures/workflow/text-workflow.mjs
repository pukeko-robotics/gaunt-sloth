// A no-schema (text) agent run — exercises the runSingleShot text path.
export default async function textWorkflow(ctx) {
  return await ctx.agent('do a thing');
}
