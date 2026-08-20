# Export-drop — the file-export integration track

> **Audience:** an operator standing up an integration at a practice, and any engineer reviewing or extending it.
> **Scope:** the vendor-agnostic **export-drop** track — Droplet reads the report files a practice exports from its own practice-management system.
>
> **See also:** [`README.md`](README.md) (how integrations work) · [`SETUP.md`](SETUP.md) (connect an integration) · [`ADD-A-PROVIDER.md`](ADD-A-PROVIDER.md) (build a new provider) · [`eaglesoft.md`](eaglesoft.md) (the direct-SQL / REST provider reference).
>
> **Ticket:** WARP-1964 · **Epic:** WARP-1093 · **Code:** `services/erp-connector/src/export-drop/`

---

## 1. What this is, and why it exists

Droplet has three ways to reach a practice-management system. Two of them are blocked on somebody else:

| Track | Provider key | Blocked on |
|---|---|---|
| Direct SQL | `eaglesoft` | **Patterson's EULA §5(a) gate on direct-database connections** (WARP-1294), plus SAP's licence-governed, account-walled SQL Anywhere client, which an operator must vendor per deployment |
| Official REST | `eaglesoft-api` | Patterson vendor enrolment, plus the route contract discovered from a live box |
| **Export drop** | **`<vendor>-export`** | **Nothing. The practice already runs these reports.** |

The export-drop track needs no driver and no vendor approval. The practice exports its own reports into a folder on its own network; Droplet mounts that folder read-only and reads the files. It is the only track that can be stood up during a first site visit, and it is the right thing to run while the other two are being pursued properly — not a replacement for them.

Note what the legal shape is, because it is the part that does not show up in a diff: this track never opens a connection to the practice's database. It reads files the practice itself produced and owns, from a share the practice controls. That is a materially different posture from direct-SQL access, and it is the reason this track can run while the sanctioned route is being pursued rather than instead of it.

**Secondary, and not a factor on current hardware:** the direct-SQL sidecar is x86_64-only — SAP ships no aarch64 Linux client ([`eaglesoft.md`](eaglesoft.md) §"x86_64-only"). Today's shipping `single-box` shape is x86, so this constrains no deployment we run; it matters only if the control plane ever lands on an aarch64 host, where the export-drop and REST tracks would be the only options.

It is **vendor-agnostic by construction**. The transport is one connector; each product is a declarative *export profile*. Adding a practice-management system is a profile, not a code change — and an operator can add one on site without waiting for a release.

---

## 2. Two properties this track gets from its shape

**Writes are impossible, permanently.** `applyWrite` runs the same registry and forbidden-target validation as the other two tracks, so a caller's bug surfaces identically — and then always refuses. An export is a one-way copy; there is no channel back through a file somebody printed. This is not a deferred slice like the REST track's write path. Enabling writes for a practice means connecting the SQL or REST track.

The read-only posture is enforced three times over, deliberately:

1. the connector refuses every write;
2. the compose bind mount is `:ro`, so the container could not write even if (1) changed;
3. the practice's share grants Droplet's account read access only, so the box could not write even if (2) changed.

**No patient data is persisted.** The snapshot lives in memory for the life of the connector, matching the read-through posture of the other two tracks. `ErpEntityCache` exists in `schema.prisma` but has no application code behind it, and its "PHI is encrypted at rest by the application layer" docstring is unimplemented — this track deliberately does not become that model's first writer. Nothing about a patient is written to Droplet's database by reading an export.

---

## 3. Standing it up at a practice

### 3.1 On the practice's side

1. **A folder the front desk exports into.** On the machine that runs the PMS, or any always-on office machine. Share it so the exporting staff can write and Droplet's account can only **read**.
2. **A dedicated account for Droplet**, not a staff login — a shared login makes the practice's own audit trail wrong. Read access to the share, nothing else.
3. **The exports themselves.** Whatever the practice's daily routine already produces is the best starting point; the end-of-day report run is usually the cheapest place to hang this, because it is a habit that already exists rather than a new one somebody has to remember.

CSV, TSV, pipe- or semicolon-delimited all work — the delimiter is sniffed. UTF-8 and UTF-16 are both decoded, which matters because a Windows report writer emits UTF-16 by default.

### 3.2 On the box

Mount the share read-only at the host path, then point the two variables at it:

```bash
ERP_EXPORT_DROP_HOST_PATH=/mnt/practice-exports
ERP_EXPORT_DROP_ROOT=/data/erp-exports
```

The first is the **host** path compose bind-mounts (read-only) at `/data/erp-exports`; the second is the **container** path the orchestrator reads. Leaving `ERP_EXPORT_DROP_ROOT` empty is what keeps the track off: the mount can exist while nothing reads it.

Then connect the integration with the provider key for the practice's product — `eaglesoft-export`, `dentrix-export`, `opendental-export`, `quickbooks-export`, or `generic-export`.

### 3.3 The first connect will probably fail, and that is the useful part

Report layouts are configurable in every one of these products, so the built-in profiles are starting points, not claims. When nothing matches, the connection blocks with the files it saw and **the headers they actually had**:

```
connect (no exported report in /data/erp-exports matched a "eaglesoft" profile;
saw schedule.csv [Appointment ID | Appt Date/Time | Provider | Op | Status | Patient ID])
```

That is everything needed to write the right profile, which is the next section. A profile that does not match declines the file — it never guesses at it — so a wrong built-in costs one edit and can never produce wrong rows.

---

## 4. Export profiles

A profile maps one product's exported column headers onto the canonical row shapes the read registry already returns. Set `ERP_EXPORT_DROP_PROFILES` to a JSON file:

```json
[
  {
    "vendor": "eaglesoft",
    "label": "Eaglesoft — Maple Street Dental",
    "datasets": [
      {
        "dataset": "appointment",
        "required": ["Appointment ID", "Appt Date/Time"],
        "columns": {
          "appt_id": "Appointment ID",
          "appt_time": "Appt Date/Time",
          "provider_id": "Provider",
          "operatory_id": "Op",
          "status": "Status",
          "patient_id": "Patient ID"
        }
      }
    ]
  }
]
```

* **`required`** is the signature: every one of these headers must be present for the profile to claim a file. Detection is on headers, **never on filename** — the front desk will eventually name a file wrong, and column names are the stable thing.
* **`columns`** maps canonical column → that product's header. Matching ignores case and extra whitespace.
* A profile for a vendor **replaces** that vendor's built-in rather than merging with it.
* The file is re-read on every connect, so fixing it and reconnecting is enough — no restart.
* A malformed file blocks the connection *naming the parse error*, rather than the misleading "no profile is registered for this vendor".

### Canonical columns

| Dataset | Columns | Must map |
|---|---|---|
| `appointment` | `appt_id`, `appt_time`, `provider_id`, `operatory_id`, `status`, `patient_id` | `appt_id`, `appt_time` |
| `patient` | `patient_id`, `first_name`, `last_name` | `patient_id`, `last_name` |
| `account` | `account_id`, `balance` | `balance` |
| `invoice` | `invoice_id`, `issued_at`, `due_at`, `customer_id`, `amount`, `balance`, `status` | `invoice_id`, `balance` |
| `bill` | `bill_id`, `issued_at`, `due_at`, `vendor_id`, `amount`, `balance`, `status` | `bill_id`, `balance` |
| `ap_summary` | `vendor_id`, `balance` | `balance` |

A canonical column a profile does not map is present-and-undefined on every row, exactly as a NULL column is on the SQL track. A consumer cannot tell the three tracks apart by probing for a key.

Each canonical column also declares how its cell is **parsed** (`COLUMN_KIND` in `profiles.ts`: text, money, or timestamp). That declaration travels with the column rather than living as a list of special-cased names in the scanner, and it is asserted complete at module load — a canonical column with no declared kind is a startup failure, not a column that silently parses as text. A money column read as text would serialize an amount as the string `"1,234.56"` and make every aggregate over it wrong.

### Row-shape parity across tracks, and what changed

The original rule was that `runRead` returns **byte-identical row shapes to the SQL and REST tracks for all five named reads**. That rule is what stops three transports quietly diverging, and it still holds — but WARP-2107 had to say what it means once the registry carries reads no practice-management track can answer. `EaglesoftConnector` cannot serve a profit-and-loss statement; there is no schema behind it and never will be.

Two options were on the table. **Per-dataset parity** — "identical *where both tracks serve the dataset*" — is the cheap one, but it turns a flat invariant into a conditional one that nobody can check at a glance. **Per-track capability declaration** is what shipped: every connector declares `servesDatasets`, and a read whose `dependsOnTables` are not all declared is refused with a typed `DatasetNotServedError` before any I/O.

That was the right trade because it makes "this track cannot answer that" a **first-class, testable state** rather than an absence:

* `DatasetNotServedError` means *this connection works perfectly and will never have that data*. A QuickBooks connection has no appointments; a Dentrix connection has no vendor bills. Neither is a fault and neither is fixed by anything an installer can do.
* `ConnectorBlockedError` means *this connection is not working, and here is what would fix it* — including "the practice has not dropped that report yet", which **is** actionable.

The rejected third option was returning an empty array. `[]` from `get_open_bills` reads as "you owe nobody anything" — a confident false statement about money that no caller can distinguish from a genuinely clear payables ledger.

Capability is not the same as presence. A profile declaring `bill` means *this vendor's export can carry bills*; whether the practice actually ran that report is a freshness question, answered by a blocked error naming the missing report.

### Built-in profiles

| Vendor | Provider key | Confirmed against a real export? |
|---|---|---|
| Eaglesoft (Patterson) | `eaglesoft-export` | **No** — shaped from the report columns the product presents |
| Dentrix (Henry Schein) | `dentrix-export` | **No** — same |
| Open Dental | `opendental-export` | **No** — modelled on Open Dental's published schema (`AptNum`, `AptDateTime`, `PatNum`, …) |
| QuickBooks (Intuit) | `quickbooks-export` | **No** — shaped from the columns QuickBooks prints in *Open Invoices*, *Unpaid Bills Detail* and *A/P Aging Summary*. Desktop and Online emit the same report names and broadly the same headers, so one profile covers both products |
| *(any other product)* | `generic-export` | n/a — ships no datasets; an operator profile supplies them |

Every built-in is marked `verified: false` in code and surfaced as `usingUnverifiedProfiles` on the connector's status. That is not hedging: an unconfirmed mapping is exactly the thing to check on day one, and hiding it would be the only way it could hurt.

---

## 5. What the reads do

The same five named reads as the other tracks, returning the same row shapes.

| Read | Behaviour on this track |
|---|---|
| `get_schedule_today` | Appointment rows inside the `[from, to)` window, ordered by time |
| `find_patient` | **Literal** prefix match on last name, case-insensitive |
| `get_patient` | One patient by id |
| `get_recall_due` | Patients ordered by last then first name |
| `get_ar_summary` | `{account_count, total_balance}` — the aggregate only, never raw ledger rows |

**`find_patient` treats the search term as literal text, never a pattern.** The SQL track escapes `LIKE` metacharacters so a `%` cannot turn a name lookup into a full-table scan (a PHI minimum-necessary violation); this track gets the same property by never treating the term as a pattern at all. A `%` search returns nothing.

**A report the practice does not export is an error, not an empty list.** Asking for the schedule when only a patient export is present blocks with `no "appointment" dataset in the export drop`. "The practice does not export that report" and "there are no matching records" are different answers, and `[]` would state the second.

---

## 6. Freshness, and the failure mode that matters

The expected failure here is not a crash. It is **the front desk forgetting to run the export**, and the schedule quietly being yesterday's.

* Each dataset carries the mtime of the newest file that fed it. The connector reports `generatedAt` and `ageMinutes` per dataset, and a `stale` flag once the newest export is older than `staleAfterMinutes` (default **26 hours** — a daily-export practice would flap on a 24-hour threshold).
* **Stale never means empty.** `health()` reports `ok: true, stale: true` for readable-but-old data: old is not broken, and collapsing the two would either hide the age or throw away real data. The caller labels it "as of".
* Appointment rows whose time cell cannot be parsed are counted in `unplacedRows` rather than silently dropped. Silently dropping an appointment is the worst thing this track could do.

---

## 7. Reading the files safely

Everything below is enforced in `src/export-drop/scan.ts` and covered by tests that were confirmed to fail when each guard is removed.

* **Nothing is read outside the drop root.** The root (and any subdirectory) is resolved through symlinks once and containment-checked. Inside the drop, **symlinks are refused outright** rather than resolved and checked — resolving one proves only where it pointed *at check time*, and the read happens a whole pass later, with every earlier file read and parsed in between, while the directory entry belongs to whoever writes to the share. Refusing removes that race instead of narrowing it, and an export drop has no legitimate use for a symlink.
* **The checked inode is the read inode.** Files are opened with `O_NOFOLLOW` and re-stat'd on the open descriptor — regular-file and size ceilings are asserted there, not trusted from the earlier pass. A symlink swapped in after the check fails the open rather than being followed. (`O_NOFOLLOW` exists on Linux and macOS; a Windows developer checkout loses this one defence and keeps every other. The appliance is Linux.)
* **A file being written is never parsed.** Change notifications are not reliable over CIFS — the kernel does not see writes made by the Windows host — so this is a **poll**, not a watcher, and a poll will catch a half-flushed export. A file becomes eligible only after a quiet period (default 30 s) and is reported as `pending` until then, not as broken.
* **Memory is bounded** by per-file byte, per-file row, per-dataset row and per-directory file ceilings. Exceeding one skips the file with a diagnostic; a runaway export cannot take the orchestrator down.
* **A row with more fields than headers is skipped and counted, never read.** That shape means a value contained an unquoted delimiter — `AC5,2,000.00` where the thousands separator was not quoted — which shifts every column after it, so the balance read for one account is really part of another's. Reading it is silently wrong money; dropping it quietly is silently missing money. It is reported per dataset as `malformedRows` and as a `malformed-rows` diagnostic naming the file. A **short** row stays supported: trailing empty columns are legitimately omitted by plenty of report writers, and a missing value is just a NULL.
* **Diagnostics carry file names and column headers, never cell values.** That is the line between "an operator can fix this" and "PHI in a log".

### Re-exports and history

Files are merged oldest-first and deduplicated by natural key (`appt_id`, `patient_id`, `account_id`), so re-exporting a day overwrites that day's rows rather than duplicating them, and exports accumulated over several days union into one view.

### Schema drift

The observed header signature is fingerprinted with the **same** `computeSchemaFingerprint` the SQL track uses on a database catalog. A vendor changing a report's columns moves the hash exactly as a database upgrade does, and the connection drift-locks rather than quietly serving a shape nobody has checked. The fingerprint is over headers, not filenames — a date-stamped filename changing daily does not trip it.

---

## 8. Timestamps

Exported date/times are read as ISO-8601 or the US layout a Windows report writer emits (`8/14/2026 2:05 PM`). An explicit `Z` or `±HH:MM` is honoured.

**A value with no zone is treated as UTC.** That is deliberate and matches the other tracks: `scheduleDayBounds` builds its window as `${date}T00:00:00.000Z`, so the SQL track already compares a practice's local wall-clock column against UTC bounds. Converting here would make this track disagree with the other two about which appointments are "today", and would make the box's own timezone setting change the answer. Real local-timezone day boundaries are the WARP-1095 refinement noted in `read-queries.ts`, and belong in one place for all three tracks.

---

## 8a. Amounts

Balances are read from whatever the report writer printed, which is rarely a bare number.

* A currency symbol and thousands separators are stripped. When both `.` and `,` appear the **last** one is the decimal point, which resolves `1,234.56` and `1.234,56` correctly; a lone comma followed by exactly two digits is a decimal separator, anything else is thousands.
* **Parentheses mean negative only when they wrap the whole amount** — `(1,234.56)` and `$(1,234.56)`, the Accounting format where the symbol sits outside. A cell like `500.00 (30 days)` is a positive balance with an ageing annotation after it, and is **refused** rather than read: treating any parenthesised text as negative both inverted the sign and spliced the annotation's digits into the number.
* **A trailing `CR` is a credit, i.e. negative**, and `DR` is a debit. The marker must follow a digit, a closing paren or whitespace, so `100 SCR` (a currency code) stays `100`.
* Anything that does not reduce cleanly to a number is `undefined` rather than a guess. An unparseable balance contributes nothing to an AR total; a confidently wrong one moves it.

## 9. What this track does not do

* **No writes** — see §2. Permanent, by construction.
* **No history beyond what is in the folder.** Droplet is not the system of record; if the practice deletes the exports, the data is gone from Droplet's view.
* **No real-time.** Data is as fresh as the last export. A practice that needs live data wants the SQL or REST track.
* **No dashboard hub entry yet** for the new vendors, and the four `tools-core/handlers/erp/*` tools are still the stubs they were before this track existed. Both are follow-ups; this slice is the transport.

---

## 10. Where it lives

| Concern | Path |
|---|---|
| Connector | `services/erp-connector/src/export-drop/connector.ts` |
| Profiles (built-in + operator JSON) | `services/erp-connector/src/export-drop/profiles.ts` |
| Scanner (containment, quiet period, bounds) | `services/erp-connector/src/export-drop/scan.ts` |
| Delimited reader + BOM decoding | `services/erp-connector/src/export-drop/csv.ts` |
| Cell normalization (timestamps, money) | `services/erp-connector/src/export-drop/values.ts` |
| Provider selection | `apps/orchestrator/src/services/erp-provider.ts` |
| Tests | `services/erp-connector/__tests__/export-drop-*.test.ts` |
