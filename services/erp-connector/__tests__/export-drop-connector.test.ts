/**
 * WARP-1964 — ExportDropConnector, against REAL directories and REAL files.
 *
 * `fs` is never mocked here, for the same reason the team does not mock a
 * database: the failures this track actually hits are filesystem failures —
 * a half-written export, a symlink out of the share, a file that is not there
 * yet — and a mocked `fs` cannot produce any of them. Temp directories are
 * cheap; the coverage is not.
 *
 * The clock IS injected, because the stability guard is a function of time and
 * a test that sleeps for 30 seconds is a test nobody runs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExportDropConnector, exportProviderFor, vendorFromExportProvider, exportProviders } from "../src/export-drop/connector.js";
import { ConnectorBlockedError } from "../src/connector.js";
import { UnknownReadQueryError, scheduleDayBounds } from "../src/read-queries.js";
import { UnknownWriteCommandError, WRITE_COMMANDS } from "../src/write-commands.js";
import { constants } from "node:fs";
import {
  isInsideRoot,
  readExportBytes,
  resolveDropDirectory,
  DropRootError,
} from "../src/export-drop/scan.js";
import { GENERIC_VENDOR, type ExportProfile } from "../src/export-drop/profiles.js";

/** Fixed clock: 2026-08-14T12:00:00Z. */
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
/** An mtime old enough to clear the 30s quiet period. */
const SETTLED = NOW - 3_600_000;

const ACME: ExportProfile = {
  vendor: "acme",
  label: "Acme Practice Manager",
  verified: true,
  datasets: [
    {
      dataset: "appointment",
      required: ["Appt Ref", "Start Time"],
      columns: {
        appt_id: "Appt Ref",
        appt_time: "Start Time",
        provider_id: "Provider",
        status: "Status",
        patient_id: "Pat Ref",
        // operatory_id deliberately unmapped — the row must still carry the key.
      },
    },
    {
      dataset: "patient",
      required: ["Pat Ref", "Surname"],
      columns: { patient_id: "Pat Ref", first_name: "Given", last_name: "Surname" },
    },
    {
      dataset: "account",
      required: ["Acct Ref", "Balance"],
      columns: { account_id: "Acct Ref", balance: "Balance" },
    },
  ],
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "droplet-export-drop-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function drop(name: string, content: string, mtimeMs = SETTLED): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content, "utf8");
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

function connector(overrides: Partial<{ vendor: string; subdirectory: string; staleAfterMinutes: number }> = {}) {
  return new ExportDropConnector(
    { vendor: overrides.vendor ?? "acme", root, subdirectory: overrides.subdirectory, staleAfterMinutes: overrides.staleAfterMinutes },
    { now: () => NOW, profiles: [ACME], minRefreshMs: Number.POSITIVE_INFINITY },
  );
}

const SCHEDULE_CSV = [
  "Appt Ref,Start Time,Provider,Status,Pat Ref",
  "A1,2026-08-14 09:30,DR1,Confirmed,P1",
  "A2,8/14/2026 2:05 PM,DR2,Scheduled,P2",
  "A3,2026-08-15 09:00,DR1,Scheduled,P3",
  "",
].join("\n");

const PATIENT_CSV = [
  "Pat Ref,Given,Surname",
  "P1,Ada,Lovelace",
  "P2,Grace,Hopper",
  "P3,Alan,Lovelace",
  "",
].join("\n");

const ACCOUNT_CSV = ["Acct Ref,Balance", "AC1,\"$1,234.56\"", "AC2,(45.00)", "AC3,n/a", ""].join("\n");

describe("provider key round-trip", () => {
  it("derives a vendor from a provider key and back", () => {
    expect(exportProviderFor("eaglesoft")).toBe("eaglesoft-export");
    expect(vendorFromExportProvider("eaglesoft-export")).toBe("eaglesoft");
    expect(vendorFromExportProvider("dentrix-export")).toBe("dentrix");
  });

  it("does not claim the other two tracks' provider keys", () => {
    expect(vendorFromExportProvider("eaglesoft")).toBeNull();
    expect(vendorFromExportProvider("eaglesoft-api")).toBeNull();
    expect(vendorFromExportProvider("-export")).toBeNull();
  });

  it("advertises a provider key per known vendor", () => {
    const providers = exportProviders();
    expect(providers).toContain("eaglesoft-export");
    expect(providers).toContain("generic-export");
    expect(providers.every((p) => p.endsWith("-export"))).toBe(true);
  });
});

describe("path containment", () => {
  it("does not treat a sibling with a shared prefix as inside the root", () => {
    // Built with the platform separator so this means the same thing on the
    // Linux box and on a developer's Windows checkout.
    expect(isInsideRoot(root, join(root, "a.csv"))).toBe(true);
    expect(isInsideRoot(root, root)).toBe(true);
    expect(isInsideRoot(root, join(`${root}-evil`, "a.csv"))).toBe(false);
  });

  it("refuses a traversal segment in the per-connection subdirectory", async () => {
    await expect(resolveDropDirectory(root, "../outside")).rejects.toThrow(DropRootError);
    await expect(resolveDropDirectory(root, "a/../../outside")).rejects.toThrow(DropRootError);
  });

  it("refuses a traversal segment even when it resolves back inside the root", async () => {
    // Both directories exist and the path lands inside the root, so the
    // containment check alone would wave this through. A subdirectory field is
    // a plain relative path or nothing — which is what makes the traversal
    // check independently load-bearing rather than incidental.
    await mkdir(join(root, "practice-a"));
    await mkdir(join(root, "practice-b"));
    await expect(resolveDropDirectory(root, "practice-a/../practice-b")).rejects.toThrow(
      DropRootError,
    );
  });

  it("refuses a subdirectory symlink that resolves outside the root", async () => {
    // No traversal segment to catch here — the string is a plain name. Only
    // resolving it and re-checking containment catches this one.
    const outside = await mkdtemp(join(tmpdir(), "droplet-export-outside-"));
    try {
      await symlink(outside, join(root, "elsewhere"), "dir");
      await expect(resolveDropDirectory(root, "elsewhere")).rejects.toThrow(DropRootError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses an absolute subdirectory", async () => {
    await expect(resolveDropDirectory(root, "/etc")).rejects.toThrow(DropRootError);
  });

  it("accepts a plain subdirectory inside the root", async () => {
    await mkdir(join(root, "practice-a"));
    await expect(resolveDropDirectory(root, "practice-a")).resolves.toContain("practice-a");
  });

  it("blocks when no root is configured at all", async () => {
    await expect(resolveDropDirectory("")).rejects.toThrow(DropRootError);
  });

  it("blocks when the configured root does not exist", async () => {
    await expect(resolveDropDirectory(join(root, "nope"))).rejects.toThrow(DropRootError);
  });
});

describe("connect", () => {
  it("blocks with the headers it saw when nothing matches a profile", async () => {
    await drop("mystery.csv", "Column One,Column Two\n1,2\n");
    const c = connector();
    await expect(c.connect()).rejects.toThrow(ConnectorBlockedError);
    await expect(c.connect()).rejects.toThrow(/Column One \| Column Two/);
  });

  it("blocks for a vendor with no profiles rather than pretending", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = new ExportDropConnector(
      { vendor: GENERIC_VENDOR, root },
      { now: () => NOW, profiles: [] },
    );
    await expect(c.connect()).rejects.toThrow(/no built-in profiles/);
  });

  it("connects once a recognised export is present", async () => {
    await drop("patients.csv", PATIENT_CSV);
    await expect(connector().connect()).resolves.toBeUndefined();
  });

  it("reports a malformed operator-profile file rather than blaming the vendor", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = new ExportDropConnector(
      { vendor: "acme", root },
      {
        now: () => NOW,
        profiles: [],
        configError: "ERP_EXPORT_DROP_PROFILES: operator profiles are not valid JSON",
      },
    );
    // Without this the operator is told there is no profile for their vendor,
    // which sends them to write the profile they already wrote.
    await expect(c.connect()).rejects.toThrow(/not valid JSON/);
  });
});

describe("the stability guard", () => {
  it("skips a file written just now, then reads it once it has settled", async () => {
    // inotify does not fire reliably over CIFS, so this is a poll — and a poll
    // will catch a half-flushed export unless the quiet period holds it back.
    await drop("patients.csv", PATIENT_CSV, NOW - 1_000);

    const c = connector();
    await expect(c.connect()).rejects.toThrow(/still being written/);

    await utimes(join(root, "patients.csv"), new Date(SETTLED), new Date(SETTLED));
    await expect(c.connect()).resolves.toBeUndefined();
    const status = await c.status();
    expect(status.datasets.find((d) => d.dataset === "patient")?.rowCount).toBe(3);
  });

  it("reports the pending file rather than calling it broken", async () => {
    await drop("patients.csv", PATIENT_CSV);
    await drop("accounts.csv", ACCOUNT_CSV, NOW - 1_000);
    const c = connector();
    await c.connect();
    const status = await c.status();
    const pending = status.diagnostics.find((d) => d.file === "accounts.csv");
    expect(pending?.reason).toBe("pending");
  });
});

describe("runRead — canonical row shapes", () => {
  it("returns the schedule with the SQL track's exact SELECT identifiers", async () => {
    await drop("schedule.csv", SCHEDULE_CSV);
    const c = connector();
    await c.connect();

    const { from, to } = scheduleDayBounds("2026-08-14");
    const rows = (await c.runRead("get_schedule_today", { from, to })) as Record<string, unknown>[];

    expect(rows).toHaveLength(2);
    // The key set is the contract: a consumer must not be able to tell this
    // track from the SQL or REST track by probing for a key.
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["appt_id", "appt_time", "operatory_id", "patient_id", "provider_id", "status"].sort(),
    );
    // operatory_id is unmapped in this profile — present, undefined, like NULL.
    expect(rows[0].operatory_id).toBeUndefined();
    expect(rows.map((r) => r.appt_id)).toEqual(["A1", "A2"]);
    expect(rows[0].appt_time).toBe("2026-08-14T09:30:00.000Z");
    expect(rows[1].appt_time).toBe("2026-08-14T14:05:00.000Z");
  });

  it("excludes the next day from a one-day window", async () => {
    await drop("schedule.csv", SCHEDULE_CSV);
    const c = connector();
    await c.connect();
    const { from, to } = scheduleDayBounds("2026-08-15");
    const rows = await c.runRead("get_schedule_today", { from, to });
    expect(rows).toHaveLength(1);
  });

  it("returns patients with the minimum-necessary key set, ordered by last then first", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    const rows = (await c.runRead("find_patient", { query: "Love" })) as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual(["first_name", "last_name", "patient_id"]);
    // Both are Lovelace, so first_name breaks the tie: Ada before Alan.
    expect(rows.map((r) => r.first_name)).toEqual(["Ada", "Alan"]);
  });

  it("aggregates AR in the same shape the other tracks return", async () => {
    await drop("accounts.csv", ACCOUNT_CSV);
    const c = connector();
    await c.connect();
    const rows = (await c.runRead("get_ar_summary", {})) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["account_count", "total_balance"]);
    // Three accounts; the unparseable balance counts as a row and contributes
    // nothing to the sum — matching SUM-skips-NULL and api-dto's equivalent.
    expect(rows[0].account_count).toBe(3);
    expect(rows[0].total_balance).toBeCloseTo(1189.56, 6);
  });

  it("returns one patient by id", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    const rows = (await c.runRead("get_patient", { patientId: "P2" })) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].first_name).toBe("Grace");
  });

  it("orders recall-due by last name then first name", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    const rows = (await c.runRead("get_recall_due", {})) as Record<string, unknown>[];
    // Hopper, then the two Lovelaces by first name.
    expect(rows.map((r) => r.patient_id)).toEqual(["P2", "P1", "P3"]);
  });
});

describe("find_patient over-fetch guard", () => {
  it("treats a wildcard as a literal, returning nothing instead of every patient", async () => {
    // The SQL track escapes LIKE metacharacters so "%" cannot become a
    // full-table scan (a PHI minimum-necessary violation). The file track gets
    // the same property by never treating the term as a pattern at all.
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    expect(await c.runRead("find_patient", { query: "%" })).toHaveLength(0);
    expect(await c.runRead("find_patient", { query: "_" })).toHaveLength(0);
    expect(await c.runRead("find_patient", { query: "Lovelace%" })).toHaveLength(0);
  });

  it("matches a prefix case-insensitively", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    expect(await c.runRead("find_patient", { query: "hopp" })).toHaveLength(1);
  });

  it("anchors at the START of the surname — a mid-name substring matches nothing", async () => {
    // The SQL track binds `${escapeLike(query)}%`, a strict prefix. Without a
    // term that is a substring but NOT a prefix, `.startsWith` and `.includes`
    // are indistinguishable, and a regression to substring would return more
    // PHI here than the same named read returns on the other two tracks.
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    expect(await c.runRead("find_patient", { query: "lace" })).toHaveLength(0);
    expect(await c.runRead("find_patient", { query: "opper" })).toHaveLength(0);
    expect(await c.runRead("find_patient", { query: "Lovelace" })).toHaveLength(2);
  });

  it("returns every patient for an empty term, as a bare prefix match does", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    expect(await c.runRead("find_patient", { query: "" })).toHaveLength(3);
  });
});

describe("honest degradation", () => {
  it("blocks rather than returning an empty list when the report is not exported", async () => {
    // "the practice does not export that report" and "there are no matching
    // records" are different answers; [] would state the second.
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    const { from, to } = scheduleDayBounds("2026-08-14");
    await expect(c.runRead("get_schedule_today", { from, to })).rejects.toThrow(
      /no "appointment" dataset/,
    );
  });

  it("validates an unknown read name before any connection state", async () => {
    const c = connector();
    await expect(c.runRead("drop_all_tables", {})).rejects.toThrow(UnknownReadQueryError);
  });

  it("blocks reads before connect", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await expect(c.runRead("find_patient", { query: "a" })).rejects.toThrow(ConnectorBlockedError);
  });

  it("counts appointment rows whose time could not be parsed instead of dropping them silently", async () => {
    await drop(
      "schedule.csv",
      ["Appt Ref,Start Time,Provider,Status,Pat Ref", "A1,2026-08-14 09:30,DR1,C,P1", "A2,sometime next week,DR1,C,P2", ""].join("\n"),
    );
    const c = connector();
    await c.connect();
    const status = await c.status();
    const appt = status.datasets.find((d) => d.dataset === "appointment");
    expect(appt?.rowCount).toBe(2);
    expect(appt?.unplacedRows).toBe(1);
  });
});

describe("writes are impossible by construction", () => {
  it("throws for every registered write command", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    expect(WRITE_COMMANDS.length).toBeGreaterThan(0);
    for (const cmd of WRITE_COMMANDS) {
      await expect(c.applyWrite(cmd.name, {})).rejects.toThrow(ConnectorBlockedError);
      await expect(c.applyWrite(cmd.name, {})).rejects.toThrow(/read-only by construction/);
    }
  });

  it("still rejects an unregistered command name first, as the other tracks do", async () => {
    const c = connector();
    await expect(c.applyWrite("delete_everything", {})).rejects.toThrow(UnknownWriteCommandError);
  });

  it("refuses before connect too — there is no state in which a write succeeds", async () => {
    const c = connector();
    await expect(c.applyWrite(WRITE_COMMANDS[0].name, {})).rejects.toThrow(ConnectorBlockedError);
  });
});

describe("schema drift", () => {
  it("moves the fingerprint when a source header changes", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const first = connector();
    await first.connect();
    const before = (await first.introspect()).fingerprint;

    await rm(join(root, "patients.csv"));
    await drop("patients.csv", PATIENT_CSV.replace("Given", "Given Name").replace("Pat Ref,Given Name,Surname", "Pat Ref,Given Name,Surname"));
    const second = connector();
    await second.connect();

    expect((await second.introspect()).fingerprint).not.toBe(before);
  });

  it("is stable across a re-export with identical headers", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const first = connector();
    await first.connect();
    const before = (await first.introspect()).fingerprint;

    await drop("patients.csv", PATIENT_CSV + "P4,Edsger,Dijkstra\n");
    const second = connector();
    await second.connect();
    expect((await second.introspect()).fingerprint).toBe(before);
  });

  it("does not fingerprint the filename", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const first = connector();
    await first.connect();
    const before = (await first.introspect()).fingerprint;

    await rm(join(root, "patients.csv"));
    await drop("patients-2026-08-14.csv", PATIENT_CSV);
    const second = connector();
    await second.connect();
    expect((await second.introspect()).fingerprint).toBe(before);
  });
});

describe("merging re-exports", () => {
  it("lets a newer file replace rows for the same natural key", async () => {
    await drop("patients-mon.csv", PATIENT_CSV, SETTLED - 60_000);
    await drop(
      "patients-tue.csv",
      ["Pat Ref,Given,Surname", "P1,Augusta,Lovelace", ""].join("\n"),
      SETTLED,
    );
    const c = connector();
    await c.connect();
    const rows = (await c.runRead("get_patient", { patientId: "P1" })) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].first_name).toBe("Augusta");
  });

  it("keeps every row when the natural-key cell is blank", async () => {
    // A PMS that only assigns an appointment id at check-in exports walk-ins
    // with a blank id. Keying those on the empty string collapses them all into
    // one bucket and the rest vanish — the silent appointment loss this
    // module's docstring calls the worst failure it could have.
    await drop(
      "schedule.csv",
      [
        "Appt Ref,Start Time,Provider,Status,Pat Ref",
        ",2026-08-14 09:00,DR1,Walk-in,P1",
        ",2026-08-14 09:30,DR1,Walk-in,P2",
        ",2026-08-14 10:00,DR1,Walk-in,P3",
        "",
      ].join("\n"),
    );
    const c = connector();
    await c.connect();
    const { from, to } = scheduleDayBounds("2026-08-14");
    expect(await c.runRead("get_schedule_today", { from, to })).toHaveLength(3);
  });

  it("skips a row with more fields than headers, and says so", async () => {
    // An unquoted delimiter inside a value shifts every later column, so the
    // balance read for one account is really another's. Reading it is silently
    // wrong money; dropping it without saying so is silently missing money.
    await drop(
      "accounts.csv",
      [
        "Acct Ref,Balance",
        "AC1,1234.56",
        "AC2,2,000.00", // unquoted thousands separator -> three fields
        "AC3,500.00",
        "",
      ].join("\n"),
    );
    const c = connector();
    await c.connect();

    const rows = (await c.runRead("get_ar_summary", {})) as Record<string, unknown>[];
    // AC2 is excluded entirely rather than contributing a shifted "2".
    expect(rows[0].account_count).toBe(2);
    expect(rows[0].total_balance).toBeCloseTo(1734.56, 6);

    const status = await c.status();
    expect(status.datasets.find((d) => d.dataset === "account")?.malformedRows).toBe(1);
    expect(status.diagnostics.some((d) => d.reason === "malformed-rows")).toBe(true);
  });

  it("still accepts a SHORT row — trailing empty columns are legitimately omitted", async () => {
    await drop("patients.csv", ["Pat Ref,Given,Surname", "P1,Ada,Lovelace", "P2,,Hopper", "P3", ""].join("\n"));
    const c = connector();
    await c.connect();
    expect(await c.runRead("get_recall_due", {})).toHaveLength(3);
    expect((await c.status()).datasets[0].malformedRows).toBe(0);
  });

  it("unions rows across files that carry different records", async () => {
    await drop("patients-a.csv", PATIENT_CSV, SETTLED - 60_000);
    await drop("patients-b.csv", ["Pat Ref,Given,Surname", "P9,Edsger,Dijkstra", ""].join("\n"), SETTLED);
    const c = connector();
    await c.connect();
    expect(await c.runRead("get_recall_due", {})).toHaveLength(4);
  });
});

describe("file gates", () => {
  it("reports an ambiguous file and reads no rows from it", async () => {
    const twin: ExportProfile = {
      ...ACME,
      datasets: [
        ACME.datasets[1],
        { dataset: "account", required: ["Pat Ref", "Surname"], columns: { account_id: "Pat Ref", balance: "Surname" } },
      ],
    };
    await drop("patients.csv", PATIENT_CSV);
    const c = new ExportDropConnector({ vendor: "acme", root }, { now: () => NOW, profiles: [twin] });
    await expect(c.connect()).rejects.toThrow(ConnectorBlockedError);
  });

  it("skips a file past the byte ceiling with a diagnostic", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = new ExportDropConnector(
      { vendor: "acme", root },
      { now: () => NOW, profiles: [ACME], limits: { maxFileBytes: 10 } },
    );
    await expect(c.connect()).rejects.toThrow(ConnectorBlockedError);
  });

  it("skips a file past the row ceiling with a diagnostic", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = new ExportDropConnector(
      { vendor: "acme", root },
      { now: () => NOW, profiles: [ACME], limits: { maxRowsPerFile: 1 } },
    );
    await expect(c.connect()).rejects.toThrow(ConnectorBlockedError);
  });

  it("ignores files with an extension we do not open", async () => {
    await drop("patients.csv", PATIENT_CSV);
    await drop("report.pdf", "not really a pdf");
    const c = connector();
    await c.connect();
    const status = await c.status();
    expect(status.diagnostics.some((d) => d.file === "report.pdf")).toBe(false);
  });

  it("refuses a symlink in the drop directory, wherever it points", async () => {
    // Refused outright rather than resolved-and-containment-checked. Resolving
    // proves only where it pointed at CHECK time, and the read happens a whole
    // pass later — every earlier file is read and parsed in between — while the
    // directory entry belongs to whoever writes to the practice's share.
    const outsideDir = await mkdtemp(join(tmpdir(), "droplet-export-outside-"));
    try {
      const outside = join(outsideDir, "secret.csv");
      await writeFile(outside, PATIENT_CSV, "utf8");
      const inside = join(root, "real.csv");
      await writeFile(inside, PATIENT_CSV, "utf8");
      try {
        await symlink(outside, join(root, "escaping.csv"));
        await symlink(inside, join(root, "contained.csv"));
      } catch {
        return; // symlink creation needs privileges on some platforms; CI runs Linux.
      }
      for (const name of ["escaping.csv", "contained.csv", "real.csv"]) {
        await utimes(join(root, name), new Date(SETTLED), new Date(SETTLED));
      }

      const c = connector();
      await c.connect(); // real.csv is a genuine file, so the drop is usable
      const status = await c.status();
      const reasons = status.diagnostics
        .filter((d) => d.file === "escaping.csv" || d.file === "contained.csv")
        .map((d) => d.reason);
      expect(reasons).toEqual(["symlink", "symlink"]);
      // ...and neither contributed rows: only real.csv's three patients.
      expect(await c.runRead("get_recall_due", {})).toHaveLength(3);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses to open a symlink even when handed one directly (O_NOFOLLOW)", async () => {
    // The symlink refusal above happens at scan time; this is the second half,
    // asserted on the open itself. It is what closes the window between the
    // check and the read — every earlier file in the directory is read and
    // parsed in between, so an entry can be swapped after it was approved.
    if (!constants.O_NOFOLLOW) return; // Windows has no O_NOFOLLOW; CI runs Linux.
    const real = join(root, "real.csv");
    await writeFile(real, PATIENT_CSV, "utf8");
    try {
      await symlink(real, join(root, "link.csv"));
    } catch {
      return;
    }
    // The target is readable through its own path...
    await expect(readExportBytes(real, 1024 * 1024)).resolves.toBeInstanceOf(Buffer);
    // ...but not through the symlink.
    await expect(readExportBytes(join(root, "link.csv"), 1024 * 1024)).rejects.toThrow();
  });

  it("re-asserts the size ceiling on the open descriptor, not the earlier stat", async () => {
    const path = join(root, "big.csv");
    await writeFile(path, PATIENT_CSV, "utf8");
    await expect(readExportBytes(path, 5)).rejects.toThrow(/exceeds/);
  });

  it("reads a free-text cell containing an inch mark without losing later rows", async () => {
    // End-to-end guard for the RFC-4180 field-start rule: `#8 crown 5" prep` is
    // a real appointment status, and reading that quote as an opening quote
    // silently deletes every row below it.
    await drop(
      "schedule.csv",
      [
        "Appt Ref,Start Time,Provider,Status,Pat Ref",
        "A1,2026-08-14 09:00,DR1,Scheduled,P1",
        'A2,2026-08-14 10:00,DR1,#8 crown 5" prep,P2',
        "A3,2026-08-14 11:00,DR1,Scheduled,P3",
        "",
      ].join("\n"),
    );
    const c = connector();
    await c.connect();
    const { from, to } = scheduleDayBounds("2026-08-14");
    const rows = (await c.runRead("get_schedule_today", { from, to })) as Record<string, unknown>[];
    expect(rows.map((r) => r.appt_id)).toEqual(["A1", "A2", "A3"]);
    expect(rows[1].status).toBe('#8 crown 5" prep');
    expect(rows[1].patient_id).toBe("P2");
  });
});

describe("freshness", () => {
  it("reports stale without withholding the data", async () => {
    const old = NOW - 48 * 3_600_000;
    await drop("patients.csv", PATIENT_CSV, old);
    const c = connector({ staleAfterMinutes: 26 * 60 });
    await c.connect();

    const health = await c.health();
    expect(health.ok).toBe(true); // readable and serving — old is not broken
    expect(health.stale).toBe(true);

    const status = await c.status();
    expect(status.stale).toBe(true);
    expect(status.datasets[0].ageMinutes).toBeGreaterThan(26 * 60);
    // The rows are still served; the caller labels them "as of".
    expect(await c.runRead("get_recall_due", {})).toHaveLength(3);
  });

  it("is not stale for a fresh export", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    expect((await c.status()).stale).toBe(false);
  });

  it("flags that the profiles in force have never been confirmed against a real export", async () => {
    await drop(
      "patients.csv",
      ["Patient ID,First Name,Last Name", "1,Ada,Lovelace", ""].join("\n"),
    );
    const c = new ExportDropConnector({ vendor: "eaglesoft", root }, { now: () => NOW });
    await c.connect();
    expect((await c.status()).usingUnverifiedProfiles).toBe(true);
  });
});

describe("a share that blips mid-session", () => {
  it("keeps serving the last good snapshot instead of emptying the schedule", async () => {
    // minRefreshMs 0 forces a rescan on every read, which is the only way to
    // reach the failed-rescan path. The share going away must degrade to
    // "serving what we last read", not to a crash and not to zero patients.
    await drop("patients.csv", PATIENT_CSV);
    const c = new ExportDropConnector(
      { vendor: "acme", root },
      { now: () => NOW, profiles: [ACME], minRefreshMs: 0 },
    );
    await c.connect();
    expect(await c.runRead("get_recall_due", {})).toHaveLength(3);

    await rm(root, { recursive: true, force: true });

    // Still three patients, from the snapshot held in memory.
    expect(await c.runRead("get_recall_due", {})).toHaveLength(3);
    // ...and repeatedly, rather than working once and then throwing.
    expect(await c.runRead("get_recall_due", {})).toHaveLength(3);
    expect((await c.status()).ok).toBe(true);

    await mkdir(root, { recursive: true }); // afterEach cleanup expects it
  });
});

describe("close", () => {
  it("drops the snapshot so a reconnect rescans", async () => {
    await drop("patients.csv", PATIENT_CSV);
    const c = connector();
    await c.connect();
    await c.close();
    await expect(c.runRead("find_patient", { query: "a" })).rejects.toThrow(ConnectorBlockedError);
    expect((await c.status()).ok).toBe(false);
  });
});
