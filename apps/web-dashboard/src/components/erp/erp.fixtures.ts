/**
 * Representative Eaglesoft snapshot for tests (and a reference for what the
 * connected surface renders). Not shipped to users — the live surface is driven
 * by the backend; a 404 renders the honest not-connected state.
 */

import type { EaglesoftDetail } from "@/lib/erp-types";

export const CONNECTED_DETAIL: EaglesoftDetail = {
  connection: {
    provider: "eaglesoft",
    status: "CONNECTED",
    host: "10.0.1.5",
    databaseName: "PattersonPM",
    schemaVersion: "Eaglesoft 21",
    account: "droplet_ro",
    writeEnabled: false,
    lastSyncedAt: "2026-07-07T15:58:00.000Z",
    nextSyncAt: "2026-07-07T16:03:00.000Z",
  },
  kpis: {
    appointmentsToday: 14,
    openChairsPm: 3,
    productionTodayCents: 824000,
    arBalanceCents: 4291000,
    recallDue: 37,
  },
  schedule: [
    { id: "a1", startsAt: "2026-07-07T13:00:00.000Z", patientId: "p1", patientName: "Maria Alvarez", provider: "Dr. Lee", operatory: "Op 1", status: "checked-in" },
    { id: "a2", startsAt: "2026-07-07T13:30:00.000Z", patientId: "p2", patientName: "James Okoro", provider: "Dr. Lee", operatory: "Op 2", status: "scheduled" },
    { id: "a3", startsAt: "2026-07-07T14:00:00.000Z", patientId: "p3", patientName: "Priya Natarajan", provider: "Dr. Kim", operatory: "Op 3", status: "scheduled" },
    { id: "a4", startsAt: "2026-07-07T14:30:00.000Z", patientId: "p4", patientName: "Walter Boyd", provider: "Dr. Kim", operatory: "Op 1", status: "complete" },
  ],
};
