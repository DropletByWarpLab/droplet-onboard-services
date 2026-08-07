# Vendored SAP SQL Anywhere client (operator-supplied)

This directory is empty in the repository, and that is deliberate.

The direct-SQL Eaglesoft track reaches Patterson's `PattersonPM` database
through unixODBC and SAP's SQL Anywhere client, `libdbodbc17_r.so`. That client
is license-governed and only distributed from behind an SAP account. It cannot
be downloaded during a build, and shipping it inside Droplet's image would be a
redistribution we have no license for. So the image is built without it, and the
direct-SQL track stays honestly blocked (`ERP_NOT_CONNECTED`) until an operator
supplies one.

## Enabling the track

1. Obtain the **SQL Anywhere Client for Linux x86_64** matching the practice's
   engine (Eaglesoft 16+ ships on SQL Anywhere 16/17) from SAP, and accept its
   license.
2. Run its installer on a scratch machine and extract the resulting tree.
3. Copy the tree here so that the driver lands at:

   ```
   services/erp-sql-bridge/vendor/sqlanywhere/lib64/libdbodbc17_r.so
   ```

4. Rebuild the image. The Dockerfile detects `vendor/sqlanywhere/lib64`,
   registers the driver in `/etc/odbcinst.ini` as `SQL Anywhere 17`, and prints
   a confirmation line. Without it, it prints the "stay blocked" note instead.
5. Set `ERP_SQL_BRIDGE_URL` (orchestrator) and the `ERP_DB_*` variables
   (bridge). See `../README.md`.

Everything under `sqlanywhere/` is gitignored — do not commit the binaries.

## Architecture

SAP publishes **no aarch64 Linux client**. On an ARM appliance the direct-SQL
track cannot run at all; use the Patterson REST API track (`eaglesoft-api`
provider, `services/erp-connector/src/api-connector.ts`) instead.
