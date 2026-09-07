/**
 * `business_find` — ONE read over the whole business graph (ADR-045 slice C).
 *
 * ## What it replaced, and why two tools instead of ten
 *
 * `crm_search_customers`, `crm_get_customer`, `crm_list_deals`,
 * `crm_get_deal`, `crm_pipeline_summary`, `pm_list_workspaces`,
 * `pm_list_projects`, `pm_list_work_items`, `pm_get_work_item` and
 * `pm_search_work_items` are gone. Ten noun-shaped tools split across two
 * silos meant three separate failures:
 *
 *   1. Only the five `crm_*` reads were ever in chat scope — every `pm_*` read
 *      was in `EXCLUDED_FROM_CHAT_TOOLS`, so "how is the Acme job going" could
 *      reach the deal and never the work. One `business` tool crosses that
 *      boundary because the boundary was an artefact of two suites, not of
 *      what an owner wants to know.
 *   2. The PM reads demanded a `workspace_slug` the model had to fetch first
 *      (`pm_list_workspaces` existed for almost nothing else). `/api/pm/projects`
 *      and `/api/pm/work-items` both take an OPTIONAL workspace, so the extra
 *      turn was never necessary and this tool does not ask for one.
 *   3. Ten schemas cost ten descriptions. Measured: the five in-scope reads
 *      serialised to 1,853 chars; these two serialise to 1,583, and the ten
 *      registry rows collapse to two.
 *
 * ## `entity` is an enum — the WARP-1839 question, answered by measurement
 *
 * `enum` is the one bounded keyword the ai-gateway's DMR sanitizer does NOT
 * strip: `ollama_local.py`'s `_SCHEMA_DATA_KEYS` treats enum/const/default/
 * examples as DATA and copies them through untouched, so these six
 * alternations reach llama.cpp's GBNF compiler. That is deliberate and it is
 * safe here, on evidence rather than on hope:
 *
 *   • WARP-1839 was blown by `maxLength`/`pattern`, which expand into BOUNDED
 *     REPETITION rules. An enum expands into one alternation of literals — a
 *     different construct, which is why the sanitizer strips the first and
 *     keeps the second.
 *   • The shipping registry already carries 26 enum keywords, 14 of them in
 *     the chat pool, the largest being `get_audit_log.kind` (11 members) and
 *     `cloud_query_dataset.dataset` (10). Six is unremarkable next to those.
 *
 * THE FALLBACK, WRITTEN DOWN so a regression is a revert and not a redesign.
 * If a local model's grammar ever chokes on this, drop the `enum` line and
 * leave `entity` a plain string:
 *
 *     entity: { type: "string", description:
 *       "One of: customer, contact, deal, project, work_item, pipeline." },
 *
 * Nothing else changes: `FIND_ENTITIES` in `_graph.ts` is already the
 * server-side validator and the handler already refuses an unknown value by
 * name. The cost is ~30 chars of description and a self-heal iteration when
 * the model guesses. Do NOT reach for `maxLength`/`pattern` in either shape.
 *
 * ## Why `pipeline` is an entity and not a `group_by` property
 *
 * `crm_pipeline_summary` had to survive somewhere. A `group_by` property would
 * have cost a seventh property AND a second result shape on `entity:"deal"`,
 * which is the shape a 20B local model is worst at. A sixth enum member costs
 * twelve characters, adds no property, and reads correctly: the answer to
 * "how is the quarter looking" is a pipeline, not a list of deals. `id`
 * narrows it to one named pipeline, the same way `id` narrows every other
 * entity — one rule, six entities.
 *
 * ## History is NOT here
 *
 * `crm_get_customer` and `crm_get_deal` each inlined a timeline. That moved to
 * `business_timeline`, which serves CRM and PM feeds through one shape. It
 * costs a second call on "what has been happening with Acme" and buys a
 * timeline that works on a work item too. Both tools live in the `business`
 * domain, so per-turn selection always advertises them together.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  businessError,
  callOrch,
  clampLimit,
  fail,
  FIND_ENTITIES,
  normalizeStatus,
  normalizeFindingStatus,
  rejectMisusedArgs,
  toGraphCompany,
  toGraphContact,
  toGraphDeal,
  toGraphWorkItem,
  toPlaneProject,
  toStageRollup,
  toBrainFinding,
  toBrainDigest,
  type ApiCrmContactRow,
  type FindEntity,
} from "./_graph.js";

const inputSchema = {
  type: "object",
  properties: {
    entity: {
      type: "string",
      enum: [
        "customer",
        "contact",
        "deal",
        "project",
        "work_item",
        "pipeline",
        "finding",
        "digest",
      ],
      description: "What to look for.",
    },
    id: { type: "string", description: "One record plus its links; omit to search." },
    query: { type: "string", description: "Free text over name, title or web domain." },
    status: {
      type: "string",
      description:
        "Deals: OPEN, WON or LOST. Findings: new, acknowledged, actioned, dismissed or stale (default new).",
    },
    parent_id: {
      type: "string",
      description: "Customer id for deal/contact; project id for work_item.",
    },
    idle_days: {
      type: "number",
      minimum: 0,
      maximum: 3650,
      description: "Deals only: untouched this long — finds who needs chasing.",
    },
    limit: { type: "number", minimum: 1, maximum: 50 },
  },
  required: ["entity"],
  additionalProperties: false,
} as const;

interface Args {
  entity?: string;
  id?: string;
  query?: string;
  status?: string;
  parent_id?: string;
  idle_days?: number;
  limit?: number;
}

/** How many projects to pull when resolving a customer's delivery work: the
 *  route's maximum (`listProjects` clamps to 200), and `GET /pm/projects`
 *  has no `page`, so this is one call — and anything it cannot show is read
 *  by id. See the customer branch. */
const PROJECT_LOOKUP_PAGE = 200;

/** The slice of `GET /api/crm/companies/:id/record` (WARP-2563) the customer
 *  branch reads. The route returns more — people, the timeline, party links —
 *  for which this tool has its own reads, or `business_timeline` does. */
interface CustomerRecordSlice {
  company: Parameters<typeof toGraphCompany>[0];
  openDeals?: Array<{ projectId?: string | null }>;
  closedDeals?: Array<{ projectId?: string | null }>;
  projects?: Array<{ id: string }>;
}

/** The deal route's maximum page (`listDeals` clamps to 200). Read whole
 *  when a free-text query has to be matched here — see the deal branch. */
const DEAL_SEARCH_PAGE = 200;

/** Same reasoning as `DEAL_SEARCH_PAGE`: a client-side free-text filter can
 *  only match what it fetched, so a search reads the route's maximum page. */
const DIGEST_SEARCH_PAGE = 200;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const a = args as unknown as Args;

  // Validated here as well as in the schema, because the plain-string fallback
  // documented in the header has no schema enum to lean on — and because a
  // remote client may call this tool with anything at all.
  const entity = a.entity as FindEntity;
  if (!entity || !(FIND_ENTITIES as readonly string[]).includes(entity)) {
    return fail(
      "BUSINESS_INVALID_REQUEST",
      `entity must be one of ${FIND_ENTITIES.join(", ")}`,
    );
  }

  const misuse = rejectMisusedArgs(entity, a as unknown as Record<string, unknown>);
  if (misuse) return misuse;

  // WARP-2752 — `status` carries TWO vocabularies and the normalizer only
  // knows one. `normalizeStatus` upper-cases and checks against DEAL_STATUSES
  // (OPEN/WON/LOST); a finding's status is a lower-case review state
  // (new/acknowledged/...), so running it unconditionally rejected every
  // finding filter before its branch was reached.
  //
  // Gated on the entity rather than widened, because the two sets must not
  // merge: accepting "WON" for a finding, or "dismissed" for a deal, would
  // make a filter that silently matches nothing — worse than a refusal,
  // because the model believes the answer applied it. `HONOURED_ARGS` decides
  // WHETHER an arg is accepted; this decides what it MEANS.
  const status = entity === "deal" ? normalizeStatus(a.status) : undefined;
  if (status !== undefined && typeof status !== "string") return status;
  const findingStatus = entity === "finding" ? normalizeFindingStatus(a.status) : undefined;
  if (findingStatus !== undefined && typeof findingStatus !== "string") return findingStatus;

  const limit = clampLimit(a.limit);
  const id = a.id?.trim() ? encodeURIComponent(a.id.trim()) : null;
  const parent = a.parent_id?.trim() ? encodeURIComponent(a.parent_id.trim()) : null;
  const q = a.query?.trim();

  try {
    switch (entity) {
      // ── customer ────────────────────────────────────────────────────────
      case "customer": {
        if (!id) {
          const params = new URLSearchParams();
          if (q) params.set("q", q);
          params.set("per_page", String(limit));
          const data = await callOrch<{
            companies?: Parameters<typeof toGraphCompany>[0][];
            total?: number;
          }>(ctx, "get", `/api/crm/companies?${params.toString()}`);
          return {
            ok: true,
            data: {
              entity,
              // The model needs to know when it is looking at a page rather
              // than the whole list, or it answers "you have 20 customers".
              customers: (data.companies ?? []).map(toGraphCompany),
              total: data.total ?? 0,
            },
          };
        }
        // Three reads that all depend only on `id`, so they go in parallel:
        // awaiting the record first would cost a round trip on every call
        // for no correctness benefit (WARP-2556 made the same fix).
        const [record, deals, contacts] = await Promise.all([
          callOrch<{ record: CustomerRecordSlice }>(
            ctx,
            "get",
            `/api/crm/companies/${id}/record`,
          ),
          callOrch<{ deals?: Parameters<typeof toGraphDeal>[0][]; total?: number }>(
            ctx,
            "get",
            `/api/crm/deals?company=${id}&kind=OPEN&per_page=${limit}`,
          ),
          callOrch<{ contacts?: ApiCrmContactRow[]; total?: number }>(
            ctx,
            "get",
            `/api/crm/contacts?company=${id}&per_page=${limit}`,
          ),
        ]);
        const openDeals = (deals.deals ?? []).map(toGraphDeal);
        const rec = record.record;

        // A customer reaches its delivery work by TWO edges, and this reads
        // both. This paragraph used to claim `PmProject` carries no company
        // column; it does — `PmProject.companyId` (WARP-2562, ADR-044) is the
        // DIRECT edge, for work that never came through a deal at all: a
        // warranty callout, a second phase, anything begun before the CRM was
        // switched on. The other edge is the deal's, `CrmDeal.projectId`
        // (WARP-2117): a WON deal becomes the job that delivers it — so by
        // construction the deals that carry a project are mostly CLOSED, and
        // deriving from the OPEN page above dropped exactly those. The record
        // route (WARP-2563) is the reader the customer page uses: every deal
        // of the customer's, open and closed, plus the projects that name the
        // company. Reading it here means the tool and the page cannot disagree
        // about what work exists. What the record lacks is the project's
        // workspace slug, which `toPlaneProject` needs, so the ids are
        // resolved below in ONE listing call rather than one per project, and
        // only when there is at least one to resolve.
        const wanted = new Set<string>();
        for (const d of [...(rec.openDeals ?? []), ...(rec.closedDeals ?? [])]) {
          if (typeof d.projectId === "string") wanted.add(d.projectId);
        }
        for (const p of rec.projects ?? []) wanted.add(p.id);
        let projects: ReturnType<typeof toPlaneProject>[] = [];
        if (wanted.size > 0) {
          const page = await callOrch<{ projects?: Parameters<typeof toPlaneProject>[0][] }>(
            ctx,
            "get",
            `/api/pm/projects?per_page=${PROJECT_LOOKUP_PAGE}`,
          );
          const listed = (page.projects ?? []).filter((p) => wanted.has(p.id));
          // The listing has no `page` and hides archived rows, so a project a
          // deal points to can be absent from it — a box past 200 projects,
          // or a job archived after its deal. Each such id is read directly
          // rather than silently left out: the model would otherwise report
          // "no delivery project" for one that exists. Rare by construction,
          // and bounded by the customer's deals and projects, never by the
          // table.
          const missing = [...wanted].filter((pid) => !listed.some((p) => p.id === pid));
          const direct = await Promise.all(
            missing.map((pid) =>
              callOrch<{ project: Parameters<typeof toPlaneProject>[0] }>(
                ctx,
                "get",
                `/api/pm/projects/${encodeURIComponent(pid)}`,
              ),
            ),
          );
          projects = [...listed, ...direct.map((d) => d.project)].map(toPlaneProject);
        }
        const contactRows = (contacts.contacts ?? []).map(toGraphContact);
        // Both lists are pages of `limit`, and each route says how big the
        // whole set is — the same `total` every search branch in this file
        // carries, so the model knows when it is looking at twenty of
        // forty-one and can say so (or ask for the rest by entity) instead of
        // answering "Acme has 20 contacts". `truncated` is the one-bit form,
        // for a caller that only wants to know whether it saw everything.
        // Falls back to the page length rather than to 0: a route that omits
        // `total` must not read as "twenty rows of nothing".
        const contactsTotal = contacts.total ?? contactRows.length;
        const openDealsTotal = deals.total ?? openDeals.length;
        return {
          ok: true,
          data: {
            entity,
            customer: toGraphCompany(rec.company),
            contacts: contactRows,
            contacts_total: contactsTotal,
            open_deals: openDeals,
            open_deals_total: openDealsTotal,
            projects,
            truncated: contactRows.length < contactsTotal || openDeals.length < openDealsTotal,
          },
        };
      }

      // ── contact ─────────────────────────────────────────────────────────
      case "contact": {
        if (id) {
          const data = await callOrch<{ contact: ApiCrmContactRow }>(
            ctx,
            "get",
            `/api/crm/contacts/${id}`,
          );
          return { ok: true, data: { entity, contact: toGraphContact(data.contact) } };
        }
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (parent) params.set("company", parent);
        params.set("per_page", String(limit));
        const data = await callOrch<{ contacts?: ApiCrmContactRow[]; total?: number }>(
          ctx,
          "get",
          `/api/crm/contacts?${params.toString()}`,
        );
        return {
          ok: true,
          data: {
            entity,
            contacts: (data.contacts ?? []).map(toGraphContact),
            total: data.total ?? 0,
          },
        };
      }

      // ── deal ────────────────────────────────────────────────────────────
      case "deal": {
        if (id) {
          const data = await callOrch<{ deal: Parameters<typeof toGraphDeal>[0] }>(
            ctx,
            "get",
            `/api/crm/deals/${id}`,
          );
          return { ok: true, data: { entity, deal: toGraphDeal(data.deal) } };
        }
        const params = new URLSearchParams();
        if (typeof status === "string") params.set("kind", status);
        if (parent) params.set("company", parent);
        if (a.idle_days !== undefined) params.set("idle_days", String(a.idle_days));
        // `/api/crm/deals` has no `q` (`listDeals` filters on stage, company,
        // owner, kind and idle time only), so free text is matched HERE over
        // the title and the customer's name — the same client-side rule the
        // project branch uses, so `query` means one thing across the six
        // entities. A query reads the route's whole page rather than `limit`:
        // filtering twenty rows and calling the survivors "the deals named
        // Acme" would be a lie by omission. At household scale 200 is the
        // whole table; when it is not, the answer says so.
        params.set("per_page", String(q ? DEAL_SEARCH_PAGE : limit));
        const data = await callOrch<{
          deals?: Parameters<typeof toGraphDeal>[0][];
          total?: number;
        }>(ctx, "get", `/api/crm/deals?${params.toString()}`);
        const all = (data.deals ?? []).map(toGraphDeal);
        if (!q) return { ok: true, data: { entity, deals: all, total: data.total ?? 0 } };
        const needle = q.toLowerCase();
        const matches = all.filter((d) =>
          `${d.title} ${d.company ?? ""}`.toLowerCase().includes(needle),
        );
        const tableSize = data.total ?? all.length;
        return {
          ok: true,
          data: {
            entity,
            deals: matches.slice(0, limit),
            total: matches.length,
            ...(tableSize > all.length
              ? { note: `matched within the first ${all.length} of ${tableSize} deals` }
              : {}),
          },
        };
      }

      // ── project ─────────────────────────────────────────────────────────
      case "project": {
        if (id) {
          // The project AND its open work, because "how is the kitchen job
          // going" is one question and used to be two tools.
          const [project, items] = await Promise.all([
            callOrch<{ project: Parameters<typeof toPlaneProject>[0] }>(
              ctx,
              "get",
              `/api/pm/projects/${id}`,
            ),
            callOrch<{ work_items?: Parameters<typeof toGraphWorkItem>[0][] }>(
              ctx,
              "get",
              `/api/pm/projects/${id}/work-items?per_page=${limit}`,
            ),
          ]);
          return {
            ok: true,
            data: {
              entity,
              project: toPlaneProject(project.project),
              work_items: (items.work_items ?? []).map((w) => toGraphWorkItem(w, { full: false })),
            },
          };
        }
        // No workspace argument on purpose: `/api/pm/projects` takes an
        // OPTIONAL workspace, which is what let `pm_list_workspaces` go.
        const data = await callOrch<{ projects?: Parameters<typeof toPlaneProject>[0][] }>(
          ctx,
          "get",
          `/api/pm/projects?per_page=${limit}`,
        );
        const all = (data.projects ?? []).map(toPlaneProject);
        // The route has no `q`; filtering here keeps ONE search vocabulary
        // across the six entities rather than making `query` mean nothing on
        // this one.
        const projects = q
          ? all.filter((p) => `${p.name} ${p.identifier}`.toLowerCase().includes(q.toLowerCase()))
          : all;
        return { ok: true, data: { entity, projects, total: projects.length } };
      }

      // ── work_item ───────────────────────────────────────────────────────
      case "work_item": {
        if (id) {
          const data = await callOrch<{ work_item: Parameters<typeof toGraphWorkItem>[0] }>(
            ctx,
            "get",
            `/api/pm/work-items/${id}`,
          );
          return {
            ok: true,
            data: { entity, work_item: toGraphWorkItem(data.work_item, { full: true }) },
          };
        }
        if (parent) {
          const params = new URLSearchParams();
          if (q) params.set("q", q);
          params.set("per_page", String(limit));
          const data = await callOrch<{ work_items?: Parameters<typeof toGraphWorkItem>[0][] }>(
            ctx,
            "get",
            `/api/pm/projects/${parent}/work-items?${params.toString()}`,
          );
          return {
            ok: true,
            data: {
              entity,
              work_items: (data.work_items ?? []).map((w) => toGraphWorkItem(w, { full: false })),
            },
          };
        }
        const params = new URLSearchParams({ q: q ?? "" });
        params.set("per_page", String(limit));
        const data = await callOrch<{ work_items?: Parameters<typeof toGraphWorkItem>[0][] }>(
          ctx,
          "get",
          `/api/pm/work-items?${params.toString()}`,
        );
        return {
          ok: true,
          data: {
            entity,
            work_items: (data.work_items ?? []).map((w) => toGraphWorkItem(w, { full: false })),
          },
        };
      }

      // ── pipeline ────────────────────────────────────────────────────────
      // WARP-2752 (ADR-051) — the brain. What the box worked out about this
      // business overnight, and what it thinks you should do about it.
      //
      // These read the SAME `visibleScopeFilter` the /brief page does, on the
      // orchestrator side: a company-scope row never reaches a family or guest
      // caller even though the model asked on their behalf. The filter lives
      // next to the data, not here.
      case "finding": {
        const qs = new URLSearchParams();
        // Default `new`: the model asking "what needs attention" means open
        // work, and returning dismissed rows alongside would make the answer
        // an archive rather than a to-do list.
        qs.set("status", typeof findingStatus === "string" ? findingStatus : "new");
        if (a.limit) qs.set("limit", String(a.limit));
        const data = await callOrch<{
          findings?: Array<Record<string, unknown>>;
          total?: number;
        }>(ctx, "get", `/api/brain/findings?${qs.toString()}`);
        return {
          ok: true,
          data: {
            entity,
            findings: (data.findings ?? []).map(toBrainFinding),
            total: data.total ?? 0,
          },
        };
      }

      case "digest": {
        const q = typeof a.query === "string" ? a.query.trim().toLowerCase() : "";
        const qs = new URLSearchParams();
        // A free-text search reads the WIDEST page the route allows, the
        // `DEAL_SEARCH_PAGE` treatment: /api/brain/digests has no query
        // parameter, so anything not fetched cannot be matched.
        qs.set("limit", String(q ? DIGEST_SEARCH_PAGE : clampLimit(a.limit)));
        const data = await callOrch<{
          digests?: Array<Record<string, unknown>>;
          total?: number;
        }>(ctx, "get", `/api/brain/digests?${qs.toString()}`);

        const rows = (data.digests ?? []).map(toBrainDigest);
        const serverTotal = data.total ?? 0;
        if (!q) return { ok: true, data: { entity, digests: rows, total: serverTotal } };

        const shown = rows.filter(
          (d) => d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q),
        );
        // `total` is the MATCH count, not the corpus count. Reporting the
        // server's full total beside a filtered list said "I searched
        // everything and found 2 of 900" when what happened was "I searched the
        // newest 200 and found 2". `searched` names the window so a model that
        // finds nothing can say WHY rather than assert absence — the
        // never-infer-absence-from-a-listing rule.
        return {
          ok: true,
          data: {
            entity,
            digests: shown,
            total: shown.length,
            searched: { most_recent: rows.length, corpus_total: serverTotal },
            ...(rows.length < serverTotal
              ? {
                  note: `searched the ${rows.length} most recently confirmed digests of ${serverTotal}; older ones were not read`,
                }
              : {}),
          },
        };
      }

      case "pipeline": {
        type Board = { id: string; name: string; isDefault: boolean };
        const data = await callOrch<{
          pipelineId: string;
          stages?: Parameters<typeof toStageRollup>[0][];
          covered?: Board[];
          omitted?: Board[];
        }>(ctx, "get", `/api/crm/summary${id ? `?pipeline=${id}` : ""}`);
        const omitted = data.omitted ?? [];
        return {
          ok: true,
          data: {
            entity,
            // WARP-2750 — the id was declared here and then dropped on the
            // floor, so an answer never said which board it described.
            pipeline_id: data.pipelineId,
            stages: (data.stages ?? []).map(toStageRollup),
            ...(omitted.length > 0
              ? {
                  // 🔴 THE SILENCE WAS THE BUG. Every connector pipeline is
                  // created `isDefault: false`, and a no-id summary resolves
                  // only the default board — so a business whose deals live in
                  // HubSpot was handed an empty local funnel with nothing
                  // saying another board existed. The model can already ask
                  // for one by id; it could not find out there was one.
                  covers_only: data.pipelineId,
                  other_pipelines: omitted.map((b) => ({ id: b.id, name: b.name })),
                  note: `this roll-up covers one pipeline; ${omitted.length} other${
                    omitted.length === 1 ? "" : "s"
                  } exist and are NOT included — ask again with that pipeline's id`,
                }
              : {}),
          },
        };
      }
    }
  } catch (err) {
    return businessError(err, entity);
  }
}

const tool: Tool = {
  name: "business_find",
  description:
    "Look up business records: customers, contacts, deals, projects, work items, the pipeline roll-up, or what the box worked out on its own — `finding` (something that needs attention: overdue money, a slipping deal) and `digest` (standing facts read out of documents). With `id`, that one record plus what links to it, each linked list with its `_total`; without, a search with a `total`. History lives in business_timeline. Amounts are minor-unit strings, never numbers.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
