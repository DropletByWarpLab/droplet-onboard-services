-- =============================================================================
-- WARP-1106 — Mock Eaglesoft "PattersonPM" schema (dry-setup harness)
-- =============================================================================
--
-- A SHAPE-FAITHFUL synthetic stand-in for Eaglesoft's PattersonPM database,
-- built on PostgreSQL so the whole dry setup runs with zero SAP dependency.
-- The table/column names, the `dba` schema owner, and the `last_modified`
-- watermark mirror exactly what the erp-connector's read/write SQL targets
-- (services/erp-connector/src/{read-queries,write-commands}.ts), so the
-- connector's built statements run against this DB verbatim.
--
-- This is NOT SQL-Anywhere-protocol-faithful (see ../README.md for the real
-- dbsrv17 variant). Known mock divergences: PostgreSQL identifiers/LIKE are
-- case-SENSITIVE (SQL Anywhere is case-insensitive by default), and the
-- catalog views (SYS.SYSTAB*) do not exist here — introspection is stubbed via
-- a fixture in the harness, not read from pg_catalog.
--
-- No real PHI: every person below is fictional (mathematicians/computer
-- scientists), phones/DOBs are invented.

CREATE SCHEMA IF NOT EXISTS dba;
SET search_path TO dba;

-- Providers (dentists / hygienists) --------------------------------------------
CREATE TABLE dba.provider (
  provider_id   integer PRIMARY KEY,
  first_name    varchar(60),
  last_name     varchar(60),
  provider_type varchar(20)              -- 'dentist' | 'hygienist'
);

-- Operatories / chairs ---------------------------------------------------------
CREATE TABLE dba.operatory (
  operatory_id  integer PRIMARY KEY,
  name          varchar(40)
);

-- Patients (demographics; minimum-necessary is enforced in the read queries) ---
CREATE TABLE dba.patient (
  patient_id    integer PRIMARY KEY,
  first_name    varchar(60),
  last_name     varchar(60),
  date_of_birth date,
  phone         varchar(20),
  status        varchar(20)              -- 'active' | 'inactive'
);

-- Procedure master. Service Code is practice-defined; the ADA/CDT code lives in
-- a SEPARATE column (research §3 / review C-7 — do NOT conflate the two).
CREATE TABLE dba.service (
  service_id    integer PRIMARY KEY,
  code          varchar(20),             -- practice-defined Service Code
  ada_code      varchar(10),             -- ADA/CDT code (distinct field)
  description   varchar(120),
  fee           numeric(10,2)
);

-- Appointments. `last_modified` is the change-tracking watermark: a trigger
-- bumps it on every UPDATE, mimicking SQL Anywhere's `DEFAULT TIMESTAMP`
-- semantics (research §3). The connector uses it for the incremental-sync
-- cursor and the optimistic-concurrency guard (write-commands.ts).
CREATE TABLE dba.appointment (
  appt_id       integer PRIMARY KEY,
  patient_id    integer REFERENCES dba.patient(patient_id),
  provider_id   integer REFERENCES dba.provider(provider_id),
  operatory_id  integer REFERENCES dba.operatory(operatory_id),
  appt_time     timestamp NOT NULL,
  status        varchar(20),             -- 'scheduled'|'confirmed'|'complete'|'cancelled'
  reason        varchar(120),
  last_modified timestamp NOT NULL DEFAULT now()
);

-- Ledger service lines (READ-ONLY for the connector; forbidden write target) ---
CREATE TABLE dba.serv_trans (
  serv_trans_id integer PRIMARY KEY,
  patient_id    integer REFERENCES dba.patient(patient_id),
  service_id    integer REFERENCES dba.service(service_id),
  provider_id   integer REFERENCES dba.provider(provider_id),
  trans_date    date,
  amount        numeric(10,2)
);

-- Accounts / AR (READ-ONLY; forbidden write target) ---------------------------
CREATE TABLE dba.account (
  account_id    integer PRIMARY KEY,
  patient_id    integer REFERENCES dba.patient(patient_id),
  balance       numeric(10,2)
);

-- Recall / recare -------------------------------------------------------------
CREATE TABLE dba.recall (
  recall_id     integer PRIMARY KEY,
  patient_id    integer REFERENCES dba.patient(patient_id),
  due_date      date,
  recall_type   varchar(30)
);

-- =============================================================================
-- WARP-2107 — accounting tables (NOT part of Eaglesoft's PattersonPM)
-- =============================================================================
--
-- Eaglesoft has no accounts-payable ledger and never will; these tables do not
-- claim otherwise. They exist because this harness is the proving ground for
-- the WHOLE read registry, not for one provider — `harness-postgres-drift`
-- builds every registered read against this schema, so the accounting reads
-- need a lane here that can actually fail. The shapes mirror the canonical
-- columns in export-drop/profiles.ts so a drift in either is caught.
--
-- The connectors that ship today refuse these reads up front via
-- `servesDatasets`; that refusal is asserted in the connector suites, not here.
--
-- No real data: vendors and customers below are fictional.

-- Customer invoices — money owed TO the business (accounts receivable).
CREATE TABLE dba.invoice (
  invoice_id    integer PRIMARY KEY,
  issued_at     timestamp,
  due_at        timestamp,
  customer_id   integer,
  amount        numeric(12,2),
  balance       numeric(12,2),
  status        varchar(30)
);

-- Vendor bills — money owed BY the business (accounts payable). This is the
-- half WARP-1991 records as having no data source anywhere in the product.
CREATE TABLE dba.bill (
  bill_id       integer PRIMARY KEY,
  issued_at     timestamp,
  due_at        timestamp,
  vendor_id     integer,
  amount        numeric(12,2),
  balance       numeric(12,2),
  status        varchar(30)
);

-- Pre-aggregated payables by vendor — the AP mirror of `account`.
CREATE TABLE dba.ap_summary (
  vendor_id     integer PRIMARY KEY,
  balance       numeric(12,2)
);

-- Watermark trigger: bump last_modified on every UPDATE (mimics the SQL
-- Anywhere DEFAULT TIMESTAMP column the connector discovers + guards on).
CREATE OR REPLACE FUNCTION dba.touch_last_modified() RETURNS trigger AS $$
BEGIN
  NEW.last_modified := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointment_touch
  BEFORE UPDATE ON dba.appointment
  FOR EACH ROW EXECUTE FUNCTION dba.touch_last_modified();
