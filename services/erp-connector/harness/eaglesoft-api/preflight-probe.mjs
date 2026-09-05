/**
 * The dispatcher probe, as its own process (WARP-2611, WARP-2626).
 *
 * Asking "can this runtime carry a request through the installed undici's
 * dispatcher?" needs a real request, which is async — but the answer has to be
 * available SYNCHRONOUSLY, because `describe.skipIf(...)` is evaluated at
 * collect time and `apps/orchestrator` is a CommonJS package under `tsc`
 * (`module: NodeNext`, no `"type": "module"`), where a top-level `await` in a
 * `.test.ts` is a TS1309 error. So the async part lives here and `preflight.mjs`
 * runs it with `execFileSync`.
 *
 * WARP-2626 — this probe must ask the question the CONNECTOR asks, not a
 * question that merely resembles it. It originally drove `globalThis.fetch`,
 * because that is what `api-auth.ts:resolveFetch` used to resolve to, and it
 * correctly reported Node >= 22 as incapable. The connector now pairs a
 * dispatcher with the npm undici's OWN `fetch` — the only fetch that honours an
 * Agent that undici minted — so driving the built-in fetch here would skip the
 * live suites on a runtime that can, in fact, run them.
 *
 * It stays a real request rather than a version check, so it keeps answering
 * honestly if undici breaks, if the pin moves, or if the connector is ever
 * "simplified" back onto the built-in fetch. The mirror to `resolveFetch` is
 * itself pinned by `__tests__/api-auth.dispatcher.test.ts`.
 *
 * Prints one line of JSON: `{"ok":true}` or `{"ok":false,"detail":"..."}`.
 */
import { createServer } from "node:http";
// Both halves from the SAME undici, exactly as the connector resolves them.
import { Agent, fetch as undiciFetch } from "undici";

const server = createServer((_req, res) => {
  res.writeHead(204);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const agent = new Agent();
let result;
try {
  // A compatible runtime answers; an incompatible one throws before a byte is
  // sent. Plain HTTP and a throwaway server: this is about the dispatcher
  // plumbing only, not about TLS or any harness state.
  await undiciFetch(`http://127.0.0.1:${server.address().port}/`, { dispatcher: agent });
  result = { ok: true };
} catch (err) {
  const cause = err?.cause;
  result = {
    ok: false,
    detail: cause?.code ? `${cause.code}: ${cause.message}` : (err?.message ?? String(err)),
  };
} finally {
  await agent.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}

process.stdout.write(JSON.stringify(result));
