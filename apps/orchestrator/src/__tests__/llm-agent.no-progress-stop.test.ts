/**
 * WARP-3283 — no-progress early-stop. A model that keeps REPHRASING a search
 * that finds nothing makes distinct calls, so the repetition guard never
 * fires and the loop used to run to the iteration cap and emit the canned
 * "couldn't finish within my step limit" text. After three zero-hit search
 * results in one turn the loop now runs the same finalization pass the
 * repetition / context-budget guards use (no tools, tool_choice "none").
 */
import { describe, it, expect, vi } from "vitest";
import { getTool, type ToolContext } from "@droplet/tools-core";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

/**
 * The wire text mcp-server sends for a tool call: the REAL tools-core handler
 * run against faked upstreams, then `JSON.stringify(result.data)`. Hand-typed
 * result strings are how the business_find-by-id false positive slipped
 * through review (the WARP-1604 anti-pattern), so every payload here comes
 * from the handler that produces it in production.
 */
async function wire(
  name: string,
  args: Record<string, unknown>,
  routes: Record<string, unknown> = {},
): Promise<string> {
  const http = {
    get: async (path: string) => {
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      if (!key) throw new Error(`unrouted GET ${path}`);
      return new Response(JSON.stringify(routes[key]), { status: 200 });
    },
  };
  const ctx = {
    userId: "u1",
    role: "owner",
    ncToken: "t",
    http: { orchestrator: http, nextcloud: http },
    searchHybrid: async () => [],
  } as unknown as ToolContext;
  const result = await getTool(name)!.handler(args, ctx);
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return JSON.stringify(result.data);
}

let n = 0;
const call = (name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id: `c${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
  ],
});
const search = (query: string) => call("search_content", { query });

function makeDeps(turns: unknown[], results: (name: string) => string) {
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: turns[Math.min(chat.mock.calls.length - 1, turns.length - 1)] }],
    }),
  }));
  const callTool = vi.fn().mockImplementation(async (name: string) => ({
    isError: false,
    content: [{ type: "text", text: results(name) }],
  }));
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue(
        ["search_content", "search_files", "email_search", "list_files", "business_find", "search_contacts"].map((name) => ({
          name,
          description: "d",
          inputSchema: {},
        })),
      ),
      callTool,
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

const EMPTY_CONTENT = wire("search_content", { query: "deletion policy" });
const EMPTY_FILES = wire("search_files", { query: "deletion" }, { "/search": { items: [] } });
const EMPTY_EMAIL = wire(
  "email_search",
  { accountId: "a1" },
  { "/api/email/": { filter: "inbox", threads: [] } },
);

type Req = { tools: unknown[]; tool_choice: string; messages: { role: string; content: unknown }[] };

describe("runAgent — no-progress early-stop (WARP-3283)", () => {
  it("finalizes after three zero-hit searches from a model that rephrases forever", async () => {
    const empty = await EMPTY_CONTENT;
    const { deps, chat, callTool } = makeDeps([], () => empty);
    // Rephrases forever; only a request that advertises NO tools (the
    // finalize pass) gets a text answer out of it.
    const rephrasings = ["data-deletion policy", "deletion", "retention policy"];
    chat.mockImplementation(async (req: Req) => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message:
              req.tools.length === 0
                ? { role: "assistant", content: "I couldn't find a data-deletion policy." }
                : search(rephrasings[chat.mock.calls.length % 3]!),
          },
        ],
      }),
    }));

    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "quote our data-deletion policy" }],
      max_iter: 10,
    });

    expect(callTool).toHaveBeenCalledTimes(3);
    expect(chat).toHaveBeenCalledTimes(4);
    const finalReq = chat.mock.calls[3]![0] as Req;
    expect(finalReq.tools).toEqual([]);
    expect(finalReq.tool_choice).toBe("none");
    expect(
      finalReq.messages.some(
        (m) => m.role === "user" && String(m.content).includes("found nothing"),
      ),
    ).toBe(true);
    expect(result.stop_reason).toBe("no_progress");
    expect(result.iterations).toBe(4);
    expect(result.message.content).toBe("I couldn't find a data-deletion policy.");
  });

  it("a fan-out across different search tools is not rephrasing: it keeps its tools", async () => {
    // "Check files, email and the CRM for an Acme contract; if there's none,
    // add a task." Three legitimately empty searches from three tools must
    // leave the conditional write reachable.
    const byName: Record<string, string> = {
      search_content: await EMPTY_CONTENT,
      search_files: await EMPTY_FILES,
      email_search: await EMPTY_EMAIL,
    };
    const { deps, chat, callTool } = makeDeps(
      [
        search("Acme contract"),
        call("search_files", { query: "Acme" }),
        call("email_search", { accountId: "a1" }),
        call("list_files", { path: "/" }),
        { role: "assistant", content: "No contract found; task added." },
      ],
      (name) => byName[name] ?? '[{"path":"/x.md"}]',
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find the Acme contract or add a task" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(4);
    expect((chat.mock.calls[3]![0] as Req).tools.length).toBeGreaterThan(0);
    expect(result.stop_reason).toBe("model_done");
  });

  it("business_find by id is a record read: a new customer with no links is not a zero-hit", async () => {
    // The real customer-by-id payload carries root arrays (contacts,
    // open_deals, projects) that are all empty for a brand-new customer.
    const customer = await wire(
      "business_find",
      { entity: "customer", id: "c1" },
      {
        "/api/crm/companies/c1/record": {
          record: { company: { id: "c1", name: "Acme" }, openDeals: [], closedDeals: [], projects: [] },
        },
        "/api/crm/deals": { deals: [], total: 0 },
        "/api/crm/contacts": { contacts: [], total: 0 },
      },
    );
    expect(JSON.parse(customer)).toMatchObject({ contacts: [], open_deals: [], projects: [] });
    // A project with no open work: `{ entity, project, work_items: [] }`.
    const project = await wire(
      "business_find",
      { entity: "project", id: "p1" },
      {
        "/api/pm/projects/p1/work-items": { work_items: [] },
        "/api/pm/projects/p1": {
          project: { id: "p1", name: "Kitchen", identifier: "KIT", workspaceSlug: "w" },
        },
      },
    );
    expect(JSON.parse(project)).toMatchObject({ project: { id: "p1" }, work_items: [] });
    const { deps, callTool } = makeDeps(
      [
        call("business_find", { entity: "customer", id: "c1" }),
        call("business_find", { entity: "project", id: "p1" }),
        call("business_find", { entity: "project", id: "p2" }),
        call("business_find", { entity: "project", id: "p3" }),
        { role: "assistant", content: "Here is the rundown." },
      ],
      (() => {
        let i = 0;
        return () => (++i === 1 ? customer : project);
      })(),
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "rundown on Acme and its jobs" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(4);
    expect(result.stop_reason).toBe("model_done");
  });

  it("business_find list searches that match nothing do count", async () => {
    const none = await wire(
      "business_find",
      { entity: "customer", query: "Acme" },
      { "/api/crm/companies": { companies: [], total: 0 } },
    );
    const noWork = await wire(
      "business_find",
      { entity: "work_item", query: "Acme" },
      { "/api/pm/work-items": { work_items: [] } },
    );
    let i = 0;
    const { deps, callTool } = makeDeps(
      [
        call("business_find", { entity: "customer", query: "Acme" }),
        call("business_find", { entity: "work_item", query: "Acme" }),
        call("business_find", { entity: "customer", query: "Acme Inc" }),
        { role: "assistant", content: "not found" },
      ],
      () => (++i === 2 ? noWork : none),
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find Acme" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(result.stop_reason).toBe("no_progress");
  });

  it("search_contacts with no mailbox connected counts: rephrasing cannot find what is not indexed", async () => {
    const noMail = await wire(
      "search_contacts",
      { query: "Jane" },
      { "/api/email/contacts": { query: "Jane", accountCount: 0, contacts: [] } },
    );
    expect(JSON.parse(noMail)).toHaveProperty("note");
    const { deps, callTool } = makeDeps(
      [
        call("search_contacts", { query: "Jane" }),
        call("search_contacts", { query: "Jane D" }),
        call("search_contacts", { query: "jane@" }),
        { role: "assistant", content: "not found" },
      ],
      () => noMail,
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "what is Jane's address" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(result.stop_reason).toBe("no_progress");
  });

  it("counts empty searches across the turn: an irrelevant hit in between does not reset it", async () => {
    const empty = await EMPTY_CONTENT;
    // adv-010's real trace: rephrasings interleave low-relevance partial hits.
    const hit = '{"query":"q","results":[{"path":"/a.md","text":"x"}]}';
    let i = 0;
    const { deps, chat, callTool } = makeDeps(
      [search("a"), search("b"), search("c"), search("d"), { role: "assistant", content: "not found" }],
      // empty, HIT, empty, empty
      () => (++i === 2 ? hit : empty),
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find it" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(4);
    expect((chat.mock.calls[4]![0] as Req).tools).toEqual([]);
    expect(result.stop_reason).toBe("no_progress");
  });

  it("two empty searches are not enough", async () => {
    const empty = await EMPTY_CONTENT;
    const { deps, callTool } = makeDeps(
      [search("a"), search("b"), { role: "assistant", content: "not found" }],
      () => empty,
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find it" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.stop_reason).toBe("model_done");
  });

  it("a failed search is not a zero-hit search", async () => {
    const { deps, callTool } = makeDeps(
      [search("a"), search("b"), search("c"), { role: "assistant", content: "done" }],
      () => '{"status":"error","error":{"code":"TIMEOUT","message":"t"}}',
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find it" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(result.stop_reason).toBe("model_done");
  });

  it("non-search tools neither count nor reset", async () => {
    const empty = await EMPTY_CONTENT;
    const { deps, chat, callTool } = makeDeps(
      [
        search("a"),
        call("list_files", { path: "/" }),
        search("b"),
        search("c"),
        { role: "assistant", content: "not found" },
      ],
      (name) => (name === "list_files" ? '[{"path":"/x.md"}]' : empty),
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find it" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(4);
    expect((chat.mock.calls[4]![0] as Req).tools).toEqual([]);
    expect(result.stop_reason).toBe("no_progress");
  });
});
