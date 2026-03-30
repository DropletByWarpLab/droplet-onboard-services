#!/bin/bash
# Create the nextcloud database if it doesn't exist.
# This script runs during PostgreSQL container init (docker-entrypoint-initdb.d).
# Note: It only runs when the pgdata volume is first created. For existing
# volumes, the database must be created manually or via setup.sh.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    SELECT 'CREATE DATABASE nextcloud OWNER ${POSTGRES_USER}'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'nextcloud')\gexec
EOSQL
