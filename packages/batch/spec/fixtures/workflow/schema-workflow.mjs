// Builds its Zod schema from the HOST's zod (ctx.z) and runs a single structured agent call end to
// end. With a fake model that returns a schema-valid object, agent({ schema }) resolves to the
// validated object; with a non-conforming object it throws (askStructured -> { ok: false }).
export default async function schemaWorkflow(ctx) {
  const Schema = ctx.z.object({ name: ctx.z.string() });
  return await ctx.agent('hello', { schema: Schema, system: 'be helpful' });
}
