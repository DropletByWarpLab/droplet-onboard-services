/**
 * WARP-3046 — a counter of "the installed model set just changed" events,
 * so a model listing read that a change overtook is never cached.
 *
 * Three read-through caches hold the installed-model list: GET /api/models'
 * `models:page`, GET /api/llm/models' `llm:models` (Redis, 30 s each) and
 * ai-gateway.client.ts' in-process `_modelsCache` (30 s). A finished download
 * busts all three — but a read that STARTED before the bust (its gateway
 * fan-out already under way, or its page payload still being composed) lands
 * after it and writes the pre-install list straight back for a full TTL: the
 * just-installed model is missing again. The gateway's ModelRegistry hands a
 * stale-generation fan-out's result to callers already awaiting it by design,
 * so the window is real, not theoretical.
 *
 * The rule, for every writer of those caches: read the generation BEFORE the
 * listing read, and write only if it is unchanged afterwards. A read that
 * started before the change and finishes after it is served to its own
 * caller, uncached; a read that finished before it is removed by the bust
 * that follows the bump. So the bump must come AFTER the gateway has dropped
 * its own listing (a read starting in between would otherwise cache the
 * gateway's stale copy) and BEFORE the orchestrator's caches are busted —
 * `refreshModels()` bumps in exactly that slot.
 *
 * Its own module, not ai-gateway.client.ts: route tests replace that client
 * wholesale, and the counter must stay real underneath them.
 */

let generation = 0;

/** The current generation. Compare a value read before a listing read with
 *  one read after it; unequal means a change overtook the read. */
export function modelListGeneration(): number {
  return generation;
}

/** The installed model set changed: every listing read in flight is stale. */
export function markModelListChanged(): void {
  generation += 1;
}
