// The first thunk resolves LAST (delay) but must still land in slot 0 — proves results are in input
// order, not completion order. The middle thunk throws and must become null without failing others.
export default async function parallelWorkflow(ctx) {
  return await ctx.parallel([
    async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'a';
    },
    async () => {
      throw new Error('boom');
    },
    async () => 'c',
  ]);
}
