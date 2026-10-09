/**
 * WARP-3570 — which tool domains a cloud model may be offered.
 *
 * The off-LAN rule is default-deny: `OFF_LAN_PERMITTED_DOMAINS` lists what
 * may go to a cloud provider and every other catalog domain is withheld. This
 * file pins BOTH halves against the live catalog, so adding a domain to
 * tools-core fails here until someone classifies it, and widening the
 * permitted set is a visible edit in a test, not a quiet one in a constant.
 *
 * Mutations this file is written to catch: add a domain to `DOMAIN_GROUPS`
 * without classifying it → the union check goes red; move `email` into the
 * permitted set → the withheld-tools check goes red; filter by a literal
 * name list instead of the domain → the "every tool of a withheld domain"
 * check goes red.
 */
import { describe, it, expect } from "vitest";
import { TOOL_CATALOG, TOOL_DOMAINS } from "@droplet/tools-core";
import {
  OFF_LAN_PERMITTED_DOMAINS,
  OFF_LAN_WITHHELD_DOMAINS,
  OFF_LAN_WITHHELD_TOOLS,
  withholdStoredContentTools,
} from "../services/stored-content-egress.service.js";

/** Pinned on purpose: classifying a new domain is a decision someone signs. */
const EXPECTED_PERMITTED = [
  "agent_runs",
  "data",
  "network",
  "notifications",
  "reminders",
  "routines",
  "smart-home",
  "switch",
  "system",
  "workspace",
];
const EXPECTED_WITHHELD = [
  "business",
  "calendar",
  "cameras",
  "cloud",
  "connections",
  "crm",
  "email",
  "erp",
  "files",
  "hosted_apps",
  "memory",
  "money",
  "pm",
  "team_chat",
];

describe("off-LAN tool domains (WARP-3570)", () => {
  it("classifies every catalog domain exactly once", () => {
    expect([...OFF_LAN_PERMITTED_DOMAINS].sort()).toEqual(EXPECTED_PERMITTED);
    expect([...OFF_LAN_WITHHELD_DOMAINS].sort()).toEqual(EXPECTED_WITHHELD);
    expect([...EXPECTED_PERMITTED, ...EXPECTED_WITHHELD].sort()).toEqual([...TOOL_DOMAINS].sort());
  });

  it("withholds every tool of every withheld domain, derived from the catalog", () => {
    for (const entry of TOOL_CATALOG) {
      expect(OFF_LAN_WITHHELD_TOOLS.has(entry.name), entry.name).toBe(
        OFF_LAN_WITHHELD_DOMAINS.has(entry.domain),
      );
    }
  });

  it.each([
    "email_accounts",
    "email_read",
    "email_search",
    "email_summarize_thread",
    "list_events",
    "search_calendar_events",
    "team_chat_send_message",
    "list_camera_events",
    "get_camera_snapshot",
    "cloud_query_dataset",
    "list_connections",
    "start_connection",
    "disconnect_connection",
    "money_list_open_documents",
    "erp_find_patient",
    "read_file",
    "memory_recall",
    "business_find",
    "list_hosted_apps",
    "hosted_app_logs",
  ])("%s is not advertised to a cloud model", (name) => {
    expect(withholdStoredContentTools([name, "get_system_health"])).toEqual(["get_system_health"]);
  });

  it("leaves a local-model turn's pool to the caller: the filter only subtracts", () => {
    const all = TOOL_CATALOG.map((e) => e.name);
    const kept = withholdStoredContentTools(all);
    expect(kept.every((n) => !OFF_LAN_WITHHELD_TOOLS.has(n))).toBe(true);
    expect(kept.length).toBe(all.length - OFF_LAN_WITHHELD_TOOLS.size);
    expect(kept).toContain("get_system_health");
    expect(kept).toContain("calculate");
  });
});
