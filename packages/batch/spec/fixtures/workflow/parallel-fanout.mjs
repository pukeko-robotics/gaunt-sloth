// BATCH-24 regression fixture: measures how many thunks `ctx.parallel` ever has in flight at once.
// Each thunk holds a slot until every thunk that will ever start has started (the barrier below
// resolves once no further thunk can begin), so the observed peak IS the host's fan-out cap.
export default async function parallelFanout(ctx) {
  const thunkCount = 12;
  let inFlight = 0;
  let maxInFlight = 0;

  const results = await ctx.parallel(
    Array.from({ length: thunkCount }, () => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield long enough for every worker the host started to reach this point before any slot
      // frees up, so `maxInFlight` settles on the real cap rather than a scheduling artefact.
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return 'ok';
    })
  );

  return { maxInFlight, resultCount: results.length };
}
