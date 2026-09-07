/**
 * WARP-519 — `/api/admin/rag-eval/*` proxy.
 *
 * Auth-gated proxy in front of the rag-eval container's HTTP trigger
 * server (services/rag-eval/server.py). Lets the dashboard fire ad-hoc
 * RAGAS runs and the baseline bootstrap, and list recent runs, without
 * `docker exec`. The rag-eval server has NO auth of its own — it binds on
 * the internal Docker network only — so THIS route is the auth wall:
 * admin/owner roles only, same check the other admin routes use.
 *
 * Availability: rag-eval ships under the `eval` Compose profile, which is
 * off by default. When the profile is inactive the service name doesn't
 * resolve and the proxy fetch fails (DNS / ECONNREFUSED) — we map that to
 * `503 { error: "rag_eval_unavailable" }` so the dashboard can render a
 * "enable the eval profile" banner instead of a generic 500. This route is
 * NOT production-gated (unlike admin-retrieval-eval) — operators may want
 * to trigger runs on a live appliance that carries the eval profile.
 */

import { Router, Request, Response } from "express";
import { createLogger } from "../lib/logger.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import { recordAccessDenied } from "../middleware/auth.js";

const logger = createLogger("admin-rag-eval");

// Bound the proxy fetch. /run and /bootstrap return 202 immediately
// (the heavy work is a rag-eval background task), and the GET endpoints
// are file reads — so a short timeout is plenty. On timeout we surface
// 503 the same as a connection refusal.
const PROXY_TIMEOUT_MS = 10_000;

function isAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === "owner" || role === "admin";
}

function ragEvalBaseUrl(): string | null {
  const url = process.env.RAG_EVAL_URL;
  if (!url || url.trim().length === 0) return null;
  // WARP-236: https:// + client cert when internal mTLS is on (identity when off).
  return internalBaseUrl(url.replace(/\/+$/, ""));
}

/**
 * Proxy one request to the rag-eval server and relay its status + JSON.
 * Centralises the 503-on-unreachable contract so every endpoint behaves
 * identically when the `eval` profile is inactive.
 */
async function proxy(
  res: Response,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<void> {
  const base = ragEvalBaseUrl();
  if (!base) {
    res.status(503).json({
      error: "rag_eval_unavailable",
      detail:
        "RAG_EVAL_URL is not configured. The rag-eval service (eval Compose profile) is not wired into this deployment.",
    });
    return;
  }

  const target = `${base}${path}`;
  try {
    const init: RequestInit = {
      method,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    };
    if (method === "POST") {
      init.headers = {
        ...(init.headers as Record<string, string>),
        "Content-Type": "application/json",
      };
      init.body = JSON.stringify(body ?? {});
    }
    const upstream = await internalFetch(target, init);

    // Relay the upstream status + JSON verbatim. rag-eval always replies
    // JSON (202/409/404/200/500); fall back to an empty object if a body
    // somehow isn't parseable so the client still gets a clean shape.
    const text = await upstream.text();
    let payload: unknown = {};
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    res.status(upstream.status).json(payload);
  } catch (err) {
    // Connection refused / DNS failure (profile inactive) or timeout.
    logger.warn(
      { err: (err as Error)?.message, target, method },
      "rag-eval proxy fetch failed — treating as unavailable",
    );
    res.status(503).json({
      error: "rag_eval_unavailable",
      detail:
        "Could not reach the rag-eval service. Ensure the `eval` Compose profile is active.",
    });
  }
}

export function createAdminRagEvalRouter(): Router {
  const router = Router();

  // Single admin gate for the whole sub-tree.
  router.use("/admin/rag-eval", (req: Request, res: Response, next) => {
    if (!isAdmin(req)) {
      // WARP-1062 (audit item B): emit the WARP-237 policy-violation row —
      // local isAdmin() denials must not be silent (requireRole parity).
      recordAccessDenied(req, "role-not-permitted");
      res.status(403).json({ error: "admin required" });
      return;
    }
    next();
  });

  router.post("/admin/rag-eval/run", async (req, res) => {
    await proxy(res, "POST", "/run");
  });

  /**
   * WARP-2732 (ADR-048) — fire the extraction canary that GATES auto mode.
   *
   * 🔴 On THIS router, deliberately, and not on `admin-retrieval-eval`. That
   * one 404s whenever `NODE_ENV === "production"`, which is every real
   * appliance — and this canary's entire purpose is to be run on a real
   * appliance, against the model that box actually serves. A gate you cannot
   * reach where it matters is not a gate.
   *
   * The rag-eval container has no auth of its own (it binds the internal
   * Docker network only), so this route is the wall: owner/admin, via the
   * `isAdmin` guard the whole router already carries.
   *
   * 202 means the run STARTED. The verdict is in the results file — a canary
   * that reported pass/fail in the trigger's status code would make a
   * measured FAIL indistinguishable from a broken harness, which is the
   * reading that gets a gate switched off rather than investigated.
   */
  router.post("/admin/rag-eval/run-extraction", async (_req, res) => {
    await proxy(res, "POST", "/run-extraction");
  });

  router.post("/admin/rag-eval/bootstrap", async (req, res) => {
    // Relay the operator-supplied {runs}; rag-eval clamps to 1..10.
    const runs = req.body?.runs;
    await proxy(
      res,
      "POST",
      "/bootstrap",
      typeof runs === "number" ? { runs } : {},
    );
  });

  router.get("/admin/rag-eval/runs", async (_req, res) => {
    await proxy(res, "GET", "/runs");
  });

  router.get("/admin/rag-eval/runs/:id", async (req, res) => {
    // encodeURIComponent so a malformed id can't smuggle path segments
    // into the upstream URL.
    const id = encodeURIComponent(req.params.id);
    await proxy(res, "GET", `/runs/${id}`);
  });

  router.get("/admin/rag-eval/baselines", async (_req, res) => {
    await proxy(res, "GET", "/baselines");
  });

  return router;
}
