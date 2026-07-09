# Protocol-faithful mock — real SQL Anywhere 17 (WARP-1106)

This variant stands up a **real `dbsrv17` engine** serving a synthetic
`PattersonPM.db` on port **2638** over the actual SQL Anywhere wire protocol —
the exact target the erp-connector's native driver bridge connects to. Unlike
the Postgres mock (`../`), it exercises the real catalog views (`SYS.SYSTAB*`),
the native `DEFAULT TIMESTAMP` watermark, and the **real** `../../sql/provision.sql`.

> ⚠️ **Not runnable out of the box, and not run in CI.** SQL Anywhere is
> proprietary — its binaries can't be bundled. This is a working template you
> complete with the SAP binaries. **x86_64 only** (no aarch64 SAP client exists).

## Steps

1. **Get the binaries.** Download **SQL Anywhere 17 Developer Edition** for
   Linux x86_64 from SAP (free for dev; account-gated). Place the tarball here as
   `sqla17-linux-x86_64.tar.gz`.
2. **Finish the Dockerfile.** Adjust the silent-install invocation (marked
   `TODO`) to match your download's installer layout, and accept the SAP license
   per your org's terms.
3. **Build + run.**
   ```bash
   docker compose -f services/erp-connector/harness/sqlanywhere/docker-compose.yml up --build -d
   ```
   The entrypoint `dbinit`s `PattersonPM.db`, loads `init.sql` (schema + seed
   with a native `DEFAULT TIMESTAMP` watermark), runs the real `provision.sql`
   (dev passwords substituted for the `<GENERATED_*_PASSWORD>` placeholders), and
   starts `dbsrv17 -x tcpip` on 2638.
4. **Smoke-test with SQL Anywhere's own client** (no PHI):
   ```bash
   docker exec -it eaglesoft-mock-sqla \
     dbisql -c "Host=localhost:2638;ServerName=PattersonPM;DBN=PattersonPM;UID=droplet_ro;PWD=droplet_ro_dev_pw" \
     "SELECT appt_id, appt_time, status FROM dba.appointment ORDER BY appt_time"
   ```
5. **Point the connector at it.** Once the WARP-1106 driver bridge exists, its
   connection string is what `connection-string.ts` builds:
   ```
   Host=<host>:2638;ServerName=PattersonPM;DatabaseName=PattersonPM;UID=droplet_ro;PWD=…;Encryption=NONE
   ```

## Why bother, vs the Postgres mock?

The Postgres mock proves the **schema, data shapes, queries, and privilege
model**. This variant additionally proves the pieces that are SQL-Anywhere-specific
and can't be faked: the **native driver/ODBC path**, **`SYS.SYSTAB*` introspection**,
the **`DEFAULT TIMESTAMP` watermark semantics**, and the **real `provision.sql`
grants** (including that column-scoped `INSERT` doesn't exist — review B-3). It is
the last mile before a live practice.
