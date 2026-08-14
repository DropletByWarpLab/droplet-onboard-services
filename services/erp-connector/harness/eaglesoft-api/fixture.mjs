/**
 * Dummy Eaglesoft REST API — the synthetic contract + practice data.
 *
 * ONE source of truth, deliberately. `ROUTE_MAP` is BOTH:
 *   1. the server's routing table (and what its `/help` page renders), and
 *   2. a valid `EaglesoftApiRouteMap` that drops straight into
 *      `EaglesoftApiConnector`'s config.
 *
 * That is the whole point: the dummy server cannot drift from the route map the
 * connector is driven with, because they are the same object. A test that passes
 * this map to the connector is testing the connector against exactly the
 * contract the server publishes at `/help` — which is the same discovery step an
 * installer performs against a real box.
 *
 * ⚠ The verbs / templates / field names below are SYNTHETIC stand-ins. They are
 * NOT Patterson's real contract — those live in compiled `[Route]`/DTO
 * attributes inside `Patterson.Eaglesoft.Api.Server.dll` and must be DISCOVERED
 * from a live box's `/help` page (see api-route-map.ts). Nothing here is a guess
 * about Patterson presented as fact; it is a stand-in whose only job is to have
 * the right SHAPE.
 *
 * No real PHI: every person is fictional (computer scientists), and the phone
 * numbers are in the 555-01xx reserved range. Mirrors the Postgres mock's seed
 * (../init/02-seed.sql) so the two harnesses tell the same story.
 */

/**
 * The discovered route contract. Keyed by the erp-connector's canonical
 * READ_QUERIES / WRITE_COMMANDS names so it can never silently drift from the
 * shared registries.
 *
 * `params` maps a canonical request param -> this API's query-string name;
 * `fields` maps a canonical row key -> this API's JSON field name. Both mirror
 * how a real discovery pass records Patterson's names without the DTO layer
 * ever baking one in.
 */
export const ROUTE_MAP = {
  authenticate: {
    controller: "Authentication",
    method: "Authenticate",
    verb: "POST",
    template: "/api/authenticate",
    tokenPath: "SessionToken",
  },
  reads: {
    get_schedule_today: {
      controller: "Schedule",
      method: "GetAppointmentsByDateRange",
      verb: "GET",
      template: "/api/schedule/range",
      listPath: "Appointments",
      params: { from: "startDate", to: "endDate" },
      fields: {
        appt_id: "AppointmentId",
        appt_time: "StartTime",
        provider_id: "ProviderId",
        operatory_id: "OperatoryId",
        status: "Status",
        patient_id: "PatientId",
      },
    },
    // ⚠ OPEN QUESTION — matching semantics of `lastName` are UNDISCOVERED.
    // This box treats it as a literal prefix. A real Eaglesoft box might do a
    // substring or LIKE match instead, in which case a "%"-style term could
    // over-fetch and minimum-necessary (§14) would need an answer on the REST
    // track. The SQL track already has one (`escapeLike` in read-queries.ts);
    // this track has NO sanitization — `toApiQuery` passes the value through
    // untouched. Determine the real behaviour during /help discovery against a
    // live box, and if it is not a literal match, add escaping BEFORE any
    // practice data is reachable through it.
    find_patient: {
      controller: "Patient",
      method: "GetPatientByName",
      verb: "GET",
      template: "/api/patients/search",
      listPath: "Patients",
      params: { query: "lastName" },
      fields: { patient_id: "PatientId", first_name: "FirstName", last_name: "LastName" },
    },
    get_patient: {
      controller: "Patient",
      method: "GetPatientById",
      verb: "GET",
      template: "/api/patients/byid",
      listPath: "Patient",
      params: { patientId: "patientId" },
      fields: { patient_id: "PatientId", first_name: "FirstName", last_name: "LastName" },
    },
    get_ar_summary: {
      controller: "Account",
      method: "GetAgedBalanceByResponsibleParty",
      verb: "GET",
      template: "/api/accounts/aged",
      listPath: "Accounts",
      // The connector aggregates COUNT + SUM(balance) client-side and returns
      // ONLY the two numbers — never these raw rows (minimum-necessary).
      fields: { account_id: "AccountId", balance: "AgedBalance" },
    },
    get_recall_due: {
      controller: "Patient",
      method: "GetRecallList",
      verb: "GET",
      template: "/api/patients/recall",
      listPath: "Patients",
      fields: { patient_id: "PatientId", first_name: "FirstName", last_name: "LastName" },
    },
  },
  writes: {
    reschedule_appointment: {
      controller: "Schedule",
      method: "UpdateAppointment",
      verb: "PUT",
      template: "/api/schedule/appointment",
      listPath: "Appointment",
      fields: {
        appt_id: "AppointmentId",
        appt_time: "StartTime",
        provider_id: "ProviderId",
        operatory_id: "OperatoryId",
        status: "Status",
        last_modified: "LastModified",
      },
    },
  },
};

/**
 * The vendor + practice credentials the dummy box accepts. DEV-ONLY throwaway
 * values for a mock that never sees a real network — the real CLIENTID/SERIALKEY
 * bundle and Eaglesoft Provider login live behind a secret_ref and never appear
 * in code. Overridable via env so a container can be run with different ones.
 */
export const DEV_CREDENTIALS = {
  integrationKey: process.env.MOCK_ES_INTEGRATION_KEY ?? "mock-vendor-integration-key",
  userId: process.env.MOCK_ES_USER_ID ?? "droplet_api",
  password: process.env.MOCK_ES_PASSWORD ?? "mock_dev_password",
};

/** Providers (dentists / hygienists). */
export const PROVIDERS = [
  { ProviderId: 1, FirstName: "Grace", LastName: "Hopper", ProviderType: "dentist" },
  { ProviderId: 2, FirstName: "Alan", LastName: "Turing", ProviderType: "dentist" },
  { ProviderId: 3, FirstName: "Ada", LastName: "Lovelace", ProviderType: "hygienist" },
];

/** Patients. Fictional; 555-01xx is the reserved fictional-phone range. */
export const PATIENTS = [
  { PatientId: 1001, FirstName: "Katherine", LastName: "Johnson", DateOfBirth: "1960-08-26", Phone: "555-0101", Status: "active" },
  { PatientId: 1002, FirstName: "Edsger", LastName: "Dijkstra", DateOfBirth: "1972-05-11", Phone: "555-0102", Status: "active" },
  { PatientId: 1003, FirstName: "Barbara", LastName: "Liskov", DateOfBirth: "1985-11-02", Phone: "555-0103", Status: "active" },
  { PatientId: 1004, FirstName: "Donald", LastName: "Knuth", DateOfBirth: "1968-01-10", Phone: "555-0104", Status: "active" },
  { PatientId: 1005, FirstName: "Radia", LastName: "Perlman", DateOfBirth: "1990-12-30", Phone: "555-0105", Status: "inactive" },
];

/** Accounts / AR. `account` is a FORBIDDEN_WRITE_TABLE — read-only here too. */
export const ACCOUNTS = [
  { AccountId: 7001, PatientId: 1001, AgedBalance: 0.0 },
  { AccountId: 7002, PatientId: 1002, AgedBalance: 137.0 },
  { AccountId: 7003, PatientId: 1003, AgedBalance: 0.0 },
  { AccountId: 7004, PatientId: 1004, AgedBalance: 412.5 },
  { AccountId: 7005, PatientId: 1005, AgedBalance: 85.0 },
];

/** Patients overdue for recare (a subset, so the read is distinguishable from
 *  `find_patient` returning everyone). */
export const RECALL_DUE_PATIENT_IDS = [1002, 1004];

/**
 * Appointments as (day offset from the anchor date, UTC wall time) so the
 * schedule always has rows for "today" whenever the harness is started, without
 * anyone editing dates. Materialized to absolute UTC timestamps by
 * {@link materializeAppointments}.
 */
const APPOINTMENT_SEED = [
  { AppointmentId: 5001, PatientId: 1001, ProviderId: 1, OperatoryId: 1, dayOffset: 0, hhmm: "09:00", Status: "confirmed", Reason: "Recall + exam" },
  { AppointmentId: 5002, PatientId: 1002, ProviderId: 3, OperatoryId: 3, dayOffset: 0, hhmm: "10:30", Status: "scheduled", Reason: "Prophy" },
  { AppointmentId: 5003, PatientId: 1003, ProviderId: 2, OperatoryId: 2, dayOffset: 0, hhmm: "14:00", Status: "scheduled", Reason: "Composite #14" },
  { AppointmentId: 5004, PatientId: 1004, ProviderId: 1, OperatoryId: 1, dayOffset: -1, hhmm: "11:00", Status: "complete", Reason: "Bitewings" },
  { AppointmentId: 5005, PatientId: 1005, ProviderId: 2, OperatoryId: 2, dayOffset: 1, hhmm: "08:30", Status: "scheduled", Reason: "New patient exam" },
];

/** The UTC calendar date (YYYY-MM-DD) used to anchor the seed. */
export function anchorDateUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Materialize the appointment seed against an anchor date, producing absolute
 * UTC `StartTime`s plus the `LastModified` watermark the optimistic-concurrency
 * guard compares (SQL Anywhere's `DEFAULT TIMESTAMP` column, mirrored here).
 *
 * Anchoring ONCE at startup — rather than re-deriving "today" per request —
 * keeps the fixture stable across a UTC midnight rollover mid-run, so a test
 * that reads the anchor date and then queries it can never race the clock.
 */
export function materializeAppointments(anchorDate, watermark = "2026-01-01T00:00:00.000Z") {
  return APPOINTMENT_SEED.map((a) => {
    const day = new Date(`${anchorDate}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() + a.dayOffset);
    const [hh, mm] = a.hhmm.split(":");
    day.setUTCHours(Number(hh), Number(mm), 0, 0);
    return {
      AppointmentId: a.AppointmentId,
      PatientId: a.PatientId,
      ProviderId: a.ProviderId,
      OperatoryId: a.OperatoryId,
      StartTime: day.toISOString(),
      Status: a.Status,
      Reason: a.Reason,
      LastModified: watermark,
    };
  });
}
