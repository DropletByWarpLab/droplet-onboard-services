/**
 * WARP-2473 — the package's importable surface.
 *
 * WHY THIS IS NOT `index.ts`
 * --------------------------
 * `src/index.ts` is the *executable*: it carries the `#!/usr/bin/env node`
 * shebang and calls `main()` at module scope. It is wired as such in three
 * places that all run the emitted `dist/index.js`:
 *
 *   - `package.json` `bin.droplet-mcp-server`
 *   - `services/mcp-server/Dockerfile` CMD (`--transport=http`)
 *   - `docker/docker-compose.yml` `MCP_SERVER_BIN` — the orchestrator spawns
 *     it as a stdio child process
 *
 * Making that file the barrel would mean every `import` of this package
 * booted a PrismaClient, opened a gRPC channel to ai-gateway, connected
 * Redis and started a transport. So the library entry lives here, and
 * `package.json` points `main`/`types`/`exports["."]` at `dist/lib.js`
 * while `bin` keeps pointing at `dist/index.js`. Neither imports the other.
 *
 * SCOPE
 * -----
 * Deliberately just the transitive closure of `createServer`'s signature —
 * the thing a consumer needs to construct a server and drive its dispatch
 * path. Everything else in `src/` stays reachable through the `./dist/*.js`
 * subpath export, which is typed now for the same reason. This is an
 * addition, not a narrowing: no existing import path changes meaning.
 */

export { createServer } from "./server.js";
export type { TrustContext, ServerOptions } from "./server.js";
export type { ContextDeps } from "./context.js";
export type { Claims } from "./auth/jwt.js";
