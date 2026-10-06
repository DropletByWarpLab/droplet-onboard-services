-- Keep the enum extension in its own migration so later migrations can safely
-- use the new value in PmActivity checks and inserts.
ALTER TYPE "PmActivityVerb" ADD VALUE IF NOT EXISTS 'deleted';
