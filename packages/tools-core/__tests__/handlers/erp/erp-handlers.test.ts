/**
 * WARP-1094 — ERP tool handlers (brief §10.3, §11.6).
 *
 * Four tools are registered: three Read-tier reads (schedule / patient /
 * AR) and one Write-tier appointment scheduler. In this DB-independent slice
 * every handler returns a typed "ERP not connected yet (WARP-1095+)" result
 * and does NO database access — the live read/write paths land once the
 * connector's copy-DB-gated phases ship. These tests pin registration, the
 * safety flags, and the not-connected contract.
 */
import { describe, it, expect } from "vitest";
import type { ToolContext } from "../../../src/types.js";

import erpGetScheduleToday from "../../../src/handlers/erp/get-schedule-today.js";
import erpFindPatient from "../../../src/handlers/erp/find-patient.js";
import erpGetArSummary from "../../../src/handlers/erp/get-ar-summary.js";
import erpScheduleAppointment from "../../../src/handlers/erp/schedule-appointment.js";

const ctx = {} as unknown as ToolContext;

describe("ERP read tools (Read-tier)", () => {
  const readTools = [erpGetScheduleToday, erpFindPatient, erpGetArSummary];

  it("register with the expected names", () => {
    expect(readTools.map((t) => t.name).sort()).toEqual(
      ["erp_find_patient", "erp_get_ar_summary", "erp_get_schedule_today"].sort(),
    );
  });

  it("are read-only and need no confirmation", () => {
    for (const t of readTools) {
      expect(t.requiresWrite).toBe(false);
      expect(t.requiresConfirmation).toBe(false);
    }
  });

  it("return a typed not-connected error without touching the DB", async () => {
    for (const t of readTools) {
      const res = await t.handler({}, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe("error");
        expect(res.error.code).toBe("ERP_NOT_CONNECTED");
        expect(res.error.message).toMatch(/WARP-1095/);
      }
    }
  });
});

describe("erp_schedule_appointment (Write-tier)", () => {
  it("is a write tool that requires confirmation (brief §11.6)", () => {
    expect(erpScheduleAppointment.name).toBe("erp_schedule_appointment");
    expect(erpScheduleAppointment.requiresWrite).toBe(true);
    expect(erpScheduleAppointment.requiresConfirmation).toBe(true);
  });

  it("returns the typed not-connected error and writes nothing", async () => {
    const res = await erpScheduleAppointment.handler(
      { patient_id: 42, appt_time: "2026-07-08T15:00:00Z", provider_id: 7 },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("ERP_NOT_CONNECTED");
      expect(res.error.message).toMatch(/WARP-1095/);
    }
  });
});
