/**
 * WARP-1294 — the DTO mappers turn Patterson Web-API-2 JSON into the EXACT row
 * shapes the SQL track returns, driven entirely by the discovered field-map so
 * no Patterson field name is ever baked. Pure functions; no I/O.
 *
 * NOTE: the API field names below ("AppointmentId", "Balance", …) are SYNTHETIC
 * fixtures standing in for what /help discovery yields — not claims about the
 * real API contract.
 */
import { describe, it, expect } from "vitest";
import {
  mapRows,
  extractRecords,
  projectRow,
  sortByKey,
  aggregateArSummary,
} from "../src/api-dto.js";
import { type RouteSpec } from "../src/api-route-map.js";

const scheduleRoute: RouteSpec = {
  controller: "Schedule",
  method: "GetAppointmentsByDateRange",
  verb: "GET",
  template: "/api/schedule/range",
  listPath: "Appointments",
  fields: { appt_id: "AppointmentId", appt_time: "StartTime", patient_id: "PatientId" },
};

describe("api-dto mappers", () => {
  it("projects API fields onto canonical row keys (drops un-mapped fields)", () => {
    const row = projectRow(
      { AppointmentId: "a1", StartTime: "2026-07-12T09:00:00Z", PatientId: "p1", Extra: 1 },
      scheduleRoute.fields!,
    );
    expect(row).toEqual({ appt_id: "a1", appt_time: "2026-07-12T09:00:00Z", patient_id: "p1" });
  });

  it("extractRecords reads a listPath array and wraps a lone (get-by-id) object", () => {
    expect(extractRecords({ Appointments: [{ a: 1 }, { a: 2 }] }, scheduleRoute)).toHaveLength(2);
    const rootRoute: RouteSpec = { ...scheduleRoute, listPath: "" };
    expect(extractRecords({ AppointmentId: "a1" }, rootRoute)).toHaveLength(1);
    expect(extractRecords({ Appointments: null }, scheduleRoute)).toHaveLength(0);
  });

  it("mapRows returns rows with EXACTLY the canonical keys", () => {
    const rows = mapRows(
      { Appointments: [{ AppointmentId: "a1", StartTime: "t1", PatientId: "p1" }] },
      scheduleRoute,
    );
    expect(Object.keys(rows[0]).sort()).toEqual(["appt_id", "appt_time", "patient_id"]);
  });

  it("mapRows throws when the route has no discovered field map", () => {
    const noFields: RouteSpec = { controller: "X", method: "Y", verb: "GET", template: "/x" };
    expect(() => mapRows({ items: [] }, noFields)).toThrow();
  });

  it("sortByKey orders ascending with undefined first", () => {
    const sorted = sortByKey([{ appt_time: "09" }, { appt_time: "08" }, { appt_time: undefined }], "appt_time");
    expect(sorted.map((r) => r.appt_time)).toEqual([undefined, "08", "09"]);
  });

  it("aggregateArSummary reproduces COUNT + SUM(balance) client-side", () => {
    const accountRoute: RouteSpec = {
      controller: "Account",
      method: "GetAgedBalanceByResponsibleParty",
      verb: "GET",
      template: "/api/account/aged",
      listPath: "Accounts",
      fields: { balance: "Balance" },
    };
    const agg = aggregateArSummary({ Accounts: [{ Balance: 100 }, { Balance: 50.5 }, { Balance: "x" }] }, accountRoute);
    expect(agg).toEqual({ account_count: 3, total_balance: 150.5 });
  });
});
