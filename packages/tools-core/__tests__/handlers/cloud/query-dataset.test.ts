/**
 * WARP-2497 — `cloud_query_dataset`, the one cloud-connector read tool.
 *
 * The tool is a thin, honest pass-through over the orchestrator's
 * `GET /api/erp/dataset/:dataset`, so what is worth pinning is the CALL it
 * makes — the dataset lands in the path, only the args the model actually
 * supplied become query params — and that a route-level refusal reaches the
 * agent as a typed `ok: false` carrying the route's own code, never a throw.
 */
import { describe, it, expect, vi } from "vitest";
import cloudQueryDataset, {
  CLOUD_QUERY_DATASETS,
} from "../../../src/handlers/cloud/query-dataset.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(orchestratorGet: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: orchestratorGet,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

/** Fresh Response per call — a Response body can only be read once. */
function jsonGet(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

// The route's wire shape (`{ dataset, provider, rows, truncated }`).
const STRIPE_CHARGES = {
  dataset: "charge",
  provider: "stripe",
  rows: [
    { id: "ch_1", amount: 4200, currency: "usd", status: "succeeded" },
    { id: "ch_2", amount: 1999, currency: "usd", status: "refunded" },
  ],
  truncated: false,
};

describe("cloud_query_dataset (WARP-2497)", () => {
  it("is a read tool — the size-and-safety contract the ticket exists for", () => {
    expect(cloudQueryDataset.name).toBe("cloud_query_dataset");
    expect(cloudQueryDataset.requiresWrite).toBe(false);
    expect(cloudQueryDataset.requiresConfirmation).toBe(false);
    // The full serialized tool block rides in EVERY completion request, and
    // the full-registry canary sits ~2.7 KB under its 100 KB ceiling. A
    // rewritten description or a per-dataset schema expansion has to stay
    // inside this budget.
    // Mutation: pad the description or split the enum into per-vendor
    // properties → this goes red before the registry canary does.
    const serialized = JSON.stringify({
      type: "function",
      function: {
        name: cloudQueryDataset.name,
        description: cloudQueryDataset.description,
        parameters: cloudQueryDataset.inputSchema,
      },
    });
    expect(serialized.length).toBeLessThan(1500);
  });

  it("sends the dataset in the path and nothing else when no filters are given", async () => {
    const get = jsonGet(STRIPE_CHARGES);
    const ctx = ctxWith(get);

    const res = await cloudQueryDataset.handler({ dataset: "charge" }, ctx);

    // Mutation: drop `dataset` from the path template (e.g. hard-code
    // "/api/erp/dataset") → red here, and the TOOL_ROUTES hop cross-check
    // would still pass on shape alone, so this is the assertion that catches it.
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/erp/dataset/charge", {
      params: {},
      headers: { Accept: "application/json" },
    });

    // Mutation: reshape or re-key the route body instead of passing it
    // through → red. The route owns the shape; a second shaper is a second
    // place to drift.
    expect(res).toEqual({ ok: true, data: STRIPE_CHARGES });
  });

  it("carries every supplied optional arg as a query param and omits the rest", async () => {
    const get = jsonGet({ ...STRIPE_CHARGES, dataset: "deal", provider: "hubspot" });
    const ctx = ctxWith(get);

    await cloudQueryDataset.handler(
      {
        dataset: "deal",
        from: "2026-08-01T00:00:00Z",
        to: "2026-09-01T00:00:00Z",
        limit: 25,
      },
      ctx,
    );

    // Absent args must NOT be sent: an empty `status`/`query`/`id` on the wire
    // is a filter the route would honour, silently returning nothing.
    // Mutation: forward the whole `args` object (or default the missing keys
    // to "" / null) → red on the exact-params match.
    expect(get).toHaveBeenCalledWith("/api/erp/dataset/deal", {
      params: { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z", limit: 25 },
      headers: { Accept: "application/json" },
    });
  });

  it("forwards the free-text and single-record filters under their own names", async () => {
    const get = jsonGet({ dataset: "contact", provider: "hubspot", rows: [], truncated: false });
    const ctx = ctxWith(get);

    await cloudQueryDataset.handler(
      { dataset: "contact", query: "ada@example.com", status: "open", id: "c_9" },
      ctx,
    );

    // Mutation: rename a param on the way out (`query` → `q`, `id` → `record_id`)
    // → red. The route reads these exact names, and a renamed param is a
    // filter the route ignores while the tool reports success.
    expect(get).toHaveBeenCalledWith("/api/erp/dataset/contact", {
      params: { status: "open", query: "ada@example.com", id: "c_9" },
      headers: { Accept: "application/json" },
    });
  });

  it("maps a route refusal to a typed error carrying the route's own code", async () => {
    const get = jsonGet(
      { error: "no integration configured for provider \"stripe\"", code: "ERP_NOT_CONNECTED" },
      503,
    );
    const ctx = ctxWith(get);

    const res = await cloudQueryDataset.handler({ dataset: "invoice" }, ctx);

    // Mutation: throw on !res.ok, or collapse every failure to one generic
    // code → red. "Connect Stripe first" and "you may not read this" are
    // different actions for the agent, and only the route's code tells them apart.
    expect(res).toEqual({
      ok: false,
      status: "error",
      error: {
        code: "ERP_NOT_CONNECTED",
        message: 'no integration configured for provider "stripe"',
      },
    });
  });

  it("falls back to a status-derived error when the failure body is not route JSON", async () => {
    // A proxy or the auth edge answering ahead of the route — HTML, not JSON.
    const get = vi
      .fn()
      .mockImplementation(async () => new Response("<html>502</html>", { status: 502 }));
    const ctx = ctxWith(get);

    const res = await cloudQueryDataset.handler({ dataset: "campaign" }, ctx);

    // Mutation: drop the try/catch around res.json() → the handler throws and
    // the model sees an opaque tool crash instead of a reportable failure.
    expect(res).toEqual({
      ok: false,
      status: "error",
      error: { code: "CLOUD_QUERY_FAILED", message: "orchestrator returned 502" },
    });
  });

  it("refuses a dataset outside the enum without dispatching", async () => {
    const get = jsonGet(STRIPE_CHARGES);
    const ctx = ctxWith(get);

    const res = await cloudQueryDataset.handler({ dataset: "../write-requests" }, ctx);

    // `dataset` is interpolated into the request PATH. Without the re-check,
    // a model-supplied traversal re-targets the GET at a different route.
    // Mutation: delete the membership check (trusting the schema's `enum`) →
    // red, and the handler would issue GET /api/erp/write-requests.
    expect(get).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("VALIDATION");
    }
  });

  it("exports the eleven dataset names the schema advertises, in one list", async () => {
    const schema = cloudQueryDataset.inputSchema as {
      properties: { dataset: { enum: readonly string[] } };
      required: string[];
      additionalProperties: boolean;
    };

    // The orchestrator route drift-tests against CLOUD_QUERY_DATASETS. If the
    // export and the schema could disagree, that test would pin a vocabulary
    // the model is never shown.
    // Mutation: hard-code a second literal array in the schema instead of
    // referencing the export → red the moment the two lists differ by one name.
    expect(schema.properties.dataset.enum).toEqual(CLOUD_QUERY_DATASETS);
    expect(CLOUD_QUERY_DATASETS).toEqual([
      "charge",
      "invoice",
      // WARP-2383 — money owed BY the business, served by the Xero track.
      // Ordered next to `invoice` rather than appended, because the two are
      // the same shape pointed in opposite directions and a reader scanning
      // this list should meet them together.
      "bill",
      "contact",
      "company",
      "deal",
      "ticket",
      "engagement",
      "campaign",
      "audience_member",
      "ecommerce_order",
    ]);
    // Mutation: drop `additionalProperties: false` → an unknown arg reaches
    // the route as a query param nobody validated.
    expect(schema.required).toEqual(["dataset"]);
    expect(schema.additionalProperties).toBe(false);
  });
});
