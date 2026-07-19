// Reports the shape of the WorkflowContext the host builds — used to assert ctx.z is present and a
// schema built from it parses, plus the callable surface (agent/parallel/log) and args passthrough.
export default async function ctxShape(ctx) {
  const Schema = ctx.z.object({ n: ctx.z.number() });
  return {
    hasZ: typeof ctx.z?.object === 'function',
    schemaBuiltFromCtxZParses: Schema.safeParse({ n: 5 }).success,
    agentType: typeof ctx.agent,
    parallelType: typeof ctx.parallel,
    logType: typeof ctx.log,
    argsSeen: ctx.args,
  };
}
