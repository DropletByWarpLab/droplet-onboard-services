/**
 * WARP-2900 (ADR-056 slice H4) — `GET /api/llm/tools/runtime`: the runtime
 * half of the tool universe, for the `/tools` Extensions section.
 *
 * `GET /api/llm/tools/catalog` lists what is compiled into this box. Tools
 * that exist only at runtime — a promoted workshop extension, a connected
 * vendor server — have no catalog entry and were visible nowhere. This lists
 * them, one row per registered tool: name, server, source
 * (`extension:<slug>@<version>`), the domain the operator chose, and what
 * dispatch does with a call right now.
 *
 * Deliberately NOT listed: the wire description. It is the author's (or the
 * vendor's) claim about the tool, unchecked by this box, and a page that
 * rendered it would let an extension describe its own privilege level. See
 * services/runtime-tool-view.service.ts.
 *
 * Who sees what mirrors the catalog route: an owner or admin sees every row;
 * everyone else sees only the tools dispatch would run (a reviewed read),
 * which is the runtime equivalent of the catalog's non-write half. An
 * extension principal never reaches this route at all — the global
 * extension-principal guard confines it to `/api/extensions/self*`.
 *
 * Read-only, and a catalog rather than a console: there is no run path here,
 * and none may be added.
 *
 * This file exports only the router factory (the route-file rule).
 */
import { Router, type Request, type Response } from "express";

import type { RemoteCallPolicy } from "../services/mcp-multiplexer.service.js";
import {
  runtimeToolRegistry,
  type RuntimeToolDescriptor,
} from "../services/runtime-tool-registry.service.js";
import { describeRuntimeTool } from "../services/runtime-tool-view.service.js";
import { isPrivilegedRole } from "../services/tool-access.service.js";

interface ToolsRuntimeRouterDeps {
  /**
   * The dispatch policy the multiplexer runs every remote call through. No
   * default on purpose: a default deny would render every reviewed read as
   * refused, and a default allow would render every refusal as runnable.
   */
  policy: RemoteCallPolicy;
  /** The runtime layer. Defaults to the process-wide registry. */
  list?: () => readonly RuntimeToolDescriptor[];
}

export function createToolsRuntimeRouter(deps: ToolsRuntimeRouterDeps): Router {
  const router = Router();
  const list = deps.list ?? (() => runtimeToolRegistry.list());

  router.get("/llm/tools/runtime", (req: Request, res: Response) => {
    const rows = list().map((t) => describeRuntimeTool(t, deps.policy));
    const tools = isPrivilegedRole(req.user?.role)
      ? rows
      : rows.filter((r) => r.classification.decision === "allow");
    res.json({ tools });
  });

  return router;
}
