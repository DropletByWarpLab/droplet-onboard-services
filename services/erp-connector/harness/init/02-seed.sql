-- =============================================================================
-- WARP-1106 — Mock PattersonPM seed data (fictional; NO real PHI)
-- =============================================================================
SET search_path TO dba;

INSERT INTO dba.provider (provider_id, first_name, last_name, provider_type) VALUES
  (1, 'Grace',  'Hopper',   'dentist'),
  (2, 'Alan',   'Turing',   'dentist'),
  (3, 'Ada',    'Lovelace', 'hygienist');

INSERT INTO dba.operatory (operatory_id, name) VALUES
  (1, 'Op 1'),
  (2, 'Op 2'),
  (3, 'Hygiene 1');

INSERT INTO dba.patient (patient_id, first_name, last_name, date_of_birth, phone, status) VALUES
  (1001, 'Katherine', 'Johnson',   '1960-08-26', '555-0101', 'active'),
  (1002, 'Edsger',    'Dijkstra',  '1972-05-11', '555-0102', 'active'),
  (1003, 'Barbara',   'Liskov',    '1985-11-02', '555-0103', 'active'),
  (1004, 'Donald',    'Knuth',     '1968-01-10', '555-0104', 'active'),
  (1005, 'Radia',     'Perlman',   '1990-12-30', '555-0105', 'inactive');

-- Service Code != ADA/CDT code (they are deliberately different values).
INSERT INTO dba.service (service_id, code, ada_code, description, fee) VALUES
  (1, 'EXAM-PER',  'D0120', 'Periodic oral evaluation', 65.00),
  (2, 'PROPHY-AD', 'D1110', 'Prophylaxis - adult',      110.00),
  (3, 'BW-4',      'D0274', 'Bitewings - four films',   72.00),
  (4, 'COMP-1S',   'D2391', 'Resin composite - 1 surface', 205.00);

-- Appointments: three anchored to TODAY (so get_schedule_today returns rows on
-- any run date) + one yesterday + one tomorrow.
INSERT INTO dba.appointment
  (appt_id, patient_id, provider_id, operatory_id, appt_time, status, reason) VALUES
  (5001, 1001, 1, 1, (now()::date + time '09:00'), 'confirmed', 'Recall + exam'),
  (5002, 1002, 3, 3, (now()::date + time '10:30'), 'scheduled', 'Prophy'),
  (5003, 1003, 2, 2, (now()::date + time '14:00'), 'scheduled', 'Composite #14'),
  (5004, 1004, 1, 1, (now()::date - 1 + time '11:00'), 'complete',  'Bitewings'),
  (5005, 1005, 2, 2, (now()::date + 1 + time '08:30'), 'scheduled', 'New patient exam');

INSERT INTO dba.serv_trans (serv_trans_id, patient_id, service_id, provider_id, trans_date, amount) VALUES
  (9001, 1004, 3, 1, (now()::date - 1), 72.00),
  (9002, 1004, 1, 1, (now()::date - 1), 65.00);

INSERT INTO dba.account (account_id, patient_id, balance) VALUES
  (7001, 1001,   0.00),
  (7002, 1002, 137.00),
  (7003, 1003,   0.00),
  (7004, 1004, 412.50),
  (7005, 1005,  85.00);

INSERT INTO dba.recall (recall_id, patient_id, due_date, recall_type) VALUES
  (8001, 1001, (now()::date + 7),  'prophy'),
  (8002, 1002, (now()::date - 14), 'prophy'),
  (8003, 1004, (now()::date + 30), 'perio');
