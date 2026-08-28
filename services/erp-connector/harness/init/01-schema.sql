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

-- =============================================================================
-- WARP-2280 — the SaaS datasets (payments, CRM, commerce, marketing)
-- =============================================================================
--
-- Same standing as the accounting block above, and added for the same reason:
-- `harness-postgres-drift` builds EVERY registered read against this schema, so
-- a dataset whose reads have no lane here would either fail the drift suite or
-- force a carve-out in it — and a universally-quantified drift test with an
-- exemption list stops being one.
--
-- These are not claims that any shipping track has a SQL database behind
-- Stripe or HubSpot; none does, and the cloud connectors are REST. The shapes
-- mirror CANONICAL_COLUMNS in export-drop/profiles.ts exactly, so a drift in
-- either side is caught here at unit-test speed.
--
-- Money columns are numeric(12,2) — DECIMAL MAJOR UNITS, matching the canonical
-- contract. Stripe's API is integer minor units; converting is the connector's
-- job at its boundary, and a minor-units column here would enshrine the bug the
-- convention exists to prevent. Counts are integer, not numeric.
--
-- No real data: everything below is fictional.

-- Payments — a money MOVEMENT, as opposed to accounting's money POSITION.
CREATE TABLE dba.charge (
  charge_id        varchar(64) PRIMARY KEY,
  created_at       timestamp,
  customer_id      varchar(64),
  amount           numeric(12,2),
  amount_refunded  numeric(12,2),
  currency         varchar(3),
  status           varchar(30)
);

CREATE TABLE dba.refund (
  refund_id     varchar(64) PRIMARY KEY,
  created_at    timestamp,
  charge_id     varchar(64),
  amount        numeric(12,2),
  currency      varchar(3),
  status        varchar(30),
  reason        varchar(120)
);

CREATE TABLE dba.payout (
  payout_id     varchar(64) PRIMARY KEY,
  created_at    timestamp,
  arrival_at    timestamp,
  amount        numeric(12,2),
  currency      varchar(3),
  status        varchar(30)
);

-- net_amount = gross_amount - fee_amount, and is the one money column here
-- that may legitimately be negative (a refund takes money off the balance).
CREATE TABLE dba.balance_transaction (
  balance_transaction_id varchar(64) PRIMARY KEY,
  created_at             timestamp,
  type                   varchar(40),
  gross_amount           numeric(12,2),
  fee_amount             numeric(12,2),
  net_amount             numeric(12,2),
  currency               varchar(3)
);

-- amount is the recurring charge per `interval`, never annualized.
CREATE TABLE dba.subscription (
  subscription_id        varchar(64) PRIMARY KEY,
  customer_id            varchar(64),
  status                 varchar(30),
  current_period_start   timestamp,
  current_period_end     timestamp,
  amount                 numeric(12,2),
  currency               varchar(3),
  interval               varchar(20)
);

-- CRM — people and pipeline. `contact` is deliberately NOT `patient`: no PHI,
-- and a contact may have bought nothing.
CREATE TABLE dba.contact (
  contact_id       varchar(64) PRIMARY KEY,
  created_at       timestamp,
  first_name       varchar(80),
  last_name        varchar(80),
  email            varchar(160),
  company_id       varchar(64),
  lifecycle_stage  varchar(40)
);

CREATE TABLE dba.company (
  company_id    varchar(64) PRIMARY KEY,
  created_at    timestamp,
  name          varchar(160),
  domain        varchar(160)
);

-- amount is EXPECTED value, not money that exists. Summing it with invoice
-- balances mixes forecast with fact.
CREATE TABLE dba.deal (
  deal_id       varchar(64) PRIMARY KEY,
  created_at    timestamp,
  closed_at     timestamp,
  company_id    varchar(64),
  name          varchar(160),
  stage         varchar(60),
  amount        numeric(12,2),
  currency      varchar(3)
);

CREATE TABLE dba.ticket (
  ticket_id     varchar(64) PRIMARY KEY,
  created_at    timestamp,
  closed_at     timestamp,
  contact_id    varchar(64),
  subject       varchar(200),
  status        varchar(30),
  priority      varchar(20)
);

-- Commerce. Revenue is total_amount - tax_amount - refunded_amount; the tax
-- was never the business's money, which is why it is its own column.
CREATE TABLE dba."order" (
  order_id            varchar(64) PRIMARY KEY,
  created_at          timestamp,
  customer_id         varchar(64),
  total_amount        numeric(12,2),
  subtotal_amount     numeric(12,2),
  tax_amount          numeric(12,2),
  refunded_amount     numeric(12,2),
  currency            varchar(3),
  financial_status    varchar(30),
  fulfillment_status  varchar(30)
);

-- price_amount is the LIST price for one unit, before discount, excluding tax.
-- inventory_quantity is a count and may be negative where overselling is on.
CREATE TABLE dba.product (
  product_id          varchar(64) PRIMARY KEY,
  created_at          timestamp,
  title               varchar(200),
  sku                 varchar(80),
  price_amount        numeric(12,2),
  currency            varchar(3),
  inventory_quantity  integer,
  status              varchar(30)
);

-- total_spent_amount is lifetime GROSS, not net of refunds — a ranking signal,
-- not a revenue figure.
CREATE TABLE dba.customer (
  customer_id         varchar(64) PRIMARY KEY,
  created_at          timestamp,
  first_name          varchar(80),
  last_name           varchar(80),
  email               varchar(160),
  orders_count        integer,
  total_spent_amount  numeric(12,2),
  currency            varchar(3)
);

-- Marketing. Every number is a count; opens/clicks are UNIQUE recipients, so
-- an open rate cannot exceed 100% and discredit the row.
CREATE TABLE dba.campaign (
  campaign_id   varchar(64) PRIMARY KEY,
  sent_at       timestamp,
  audience_id   varchar(64),
  subject       varchar(200),
  status        varchar(30),
  emails_sent   integer,
  opens_unique  integer,
  clicks_unique integer
);

CREATE TABLE dba.audience (
  audience_id        varchar(64) PRIMARY KEY,
  created_at         timestamp,
  name               varchar(160),
  member_count       integer,
  unsubscribe_count  integer
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
