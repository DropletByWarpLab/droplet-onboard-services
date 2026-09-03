/**
 * The dispatcher probe, as its own process (WARP-2611).
 *
 * Asking "does this runtime's built-in fetch accept the installed undici's
 * dispatcher?" needs a real request, which is async — but the answer has to be
 * available SYNCHRONOUSLY, because `describe.skipIf(...)` is evaluated at
 * collect time and `apps/orchestrator` is a CommonJS package under `tsc`
 * (`module: NodeNext`, no `"type": "module"`), where a top-level `await` in a
 * `.test.ts` is a TS1309 error. So the async part lives here and `preflight.mjs`
 * runs it with `execFileSync`.
 *
 * Prints one line of JSON: `{"ok":true}` or `{"ok":false,"detail":"..."}`.
 */
import { createServer } from "node:http";
import { Agent } from "undici";

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
  await fetch(`http://127.0.0.1:${server.address().port}/`, { dispatcher: agent });
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
