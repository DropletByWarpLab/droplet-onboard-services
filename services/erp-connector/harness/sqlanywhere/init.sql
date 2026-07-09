-- =============================================================================
-- WARP-1106 — Mock PattersonPM schema + seed, SQL ANYWHERE dialect
-- =============================================================================
-- Protocol-faithful variant: real dbsrv17. The key difference from the Postgres
-- mock is the watermark — `DEFAULT TIMESTAMP` is a native SQL Anywhere column
-- default that is set on INSERT and re-stamped on EVERY UPDATE, so no trigger is
-- needed (this is exactly what the connector discovers + optimistic-guards on).
--
-- Run against a freshly dbinit'd PattersonPM.db as the DBA, THEN run the real
-- ../../sql/provision.sql to create droplet_ro / droplet_rw. No real PHI.

CREATE TABLE dba.provider (
  provider_id   integer NOT NULL PRIMARY KEY,
  first_name    varchar(60),
  last_name     varchar(60),
  provider_type varchar(20) );

CREATE TABLE dba.operatory (
  operatory_id  integer NOT NULL PRIMARY KEY,
  name          varchar(40) );

CREATE TABLE dba.patient (
  patient_id    integer NOT NULL PRIMARY KEY,
  first_name    varchar(60),
  last_name     varchar(60),
  date_of_birth date,
  phone         varchar(20),
  status        varchar(20) );

CREATE TABLE dba.service (
  service_id    integer NOT NULL PRIMARY KEY,
  code          varchar(20),          -- practice Service Code
  ada_code      varchar(10),          -- ADA/CDT code (separate field)
  description   varchar(120),
  fee           numeric(10,2) );

CREATE TABLE dba.appointment (
  appt_id       integer NOT NULL PRIMARY KEY,
  patient_id    integer,
  provider_id   integer,
  operatory_id  integer,
  appt_time     timestamp NOT NULL,
  status        varchar(20),
  reason        varchar(120),
  last_modified timestamp NOT NULL DEFAULT TIMESTAMP );   -- native watermark

CREATE TABLE dba.serv_trans (
  serv_trans_id integer NOT NULL PRIMARY KEY,
  patient_id    integer,
  service_id    integer,
  provider_id   integer,
  trans_date    date,
  amount        numeric(10,2) );

CREATE TABLE dba.account (
  account_id    integer NOT NULL PRIMARY KEY,
  patient_id    integer,
  balance       numeric(10,2) );

CREATE TABLE dba.recall (
  recall_id     integer NOT NULL PRIMARY KEY,
  patient_id    integer,
  due_date      date,
  recall_type   varchar(30) );

INSERT INTO dba.provider VALUES (1,'Grace','Hopper','dentist'),(2,'Alan','Turing','dentist'),(3,'Ada','Lovelace','hygienist');
INSERT INTO dba.operatory VALUES (1,'Op 1'),(2,'Op 2'),(3,'Hygiene 1');
INSERT INTO dba.patient VALUES
  (1001,'Katherine','Johnson','1960-08-26','555-0101','active'),
  (1002,'Edsger','Dijkstra','1972-05-11','555-0102','active'),
  (1003,'Barbara','Liskov','1985-11-02','555-0103','active'),
  (1004,'Donald','Knuth','1968-01-10','555-0104','active'),
  (1005,'Radia','Perlman','1990-12-30','555-0105','inactive');
INSERT INTO dba.service VALUES
  (1,'EXAM-PER','D0120','Periodic oral evaluation',65.00),
  (2,'PROPHY-AD','D1110','Prophylaxis - adult',110.00),
  (3,'BW-4','D0274','Bitewings - four films',72.00),
  (4,'COMP-1S','D2391','Resin composite - 1 surface',205.00);
INSERT INTO dba.appointment (appt_id,patient_id,provider_id,operatory_id,appt_time,status,reason) VALUES
  (5001,1001,1,1,DATEADD(hour, 9,  CAST(CURRENT DATE AS timestamp)),'confirmed','Recall + exam'),
  (5002,1002,3,3,DATEADD(minute,630,CAST(CURRENT DATE AS timestamp)),'scheduled','Prophy'),
  (5003,1003,2,2,DATEADD(hour, 14, CAST(CURRENT DATE AS timestamp)),'scheduled','Composite #14');
INSERT INTO dba.account VALUES (7001,1001,0.00),(7002,1002,137.00),(7003,1003,0.00),(7004,1004,412.50),(7005,1005,85.00);
INSERT INTO dba.recall VALUES (8001,1001,DATEADD(day,7,CURRENT DATE),'prophy'),(8002,1002,DATEADD(day,-14,CURRENT DATE),'prophy');
COMMIT;
