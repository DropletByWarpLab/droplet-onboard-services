#!/bin/bash
# Create the nextcloud database if it doesn't exist.
# PostgreSQL runs this on first init only (when pgdata volume is empty).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    SELECT 'CREATE DATABASE nextcloud OWNER droplet'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'nextcloud')\gexec
EOSQL
