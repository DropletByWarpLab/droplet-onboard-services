/**
 * WARP-2896 — a re-stamped migration can never come back under its old stamp.
 *
 * The team re-stamps a branch migration immediately before merge so the
 * history applies in the order it was written. WARP-2896 is the case that
 * made this a guard: `20260920120000_warp_2896_workspace` moved to
 * `20260924010000_warp_2896_workspace` (#2247, 040ae3c90). The moved SQL is
 * idempotent; the OLD folder's SQL is not (a bare `CREATE TYPE`).
 *
 * The failure it guards against is silent everywhere except on a box. A
 * branch that forked before the re-stamp still carries the old folder, and
 * if it reaches stage with that folder intact (a squash or cherry-pick
 * instead of a merge of stage, a bad conflict resolution), the tree holds
 * BOTH folders. CI stays green, because a fresh DB runs the old folder
 * first and the idempotent new one as a no-op. A box that already ran the
 * new folder is different: it has no row for the old name, so the next
 * deploy runs the old SQL over objects that exist, fails with 42710 / P3018,
 * and migrate-and-start.sh refuses to start the app. The box goes dark.
 *
 * So the check is on the shape of the migrations directory itself, in the
 * DB-less lane every PR runs: no two folders may carry the same name after
 * their 14-digit stamp. That is what a resurrected re-stamp looks like, for
 * this migration and for every future one.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../prisma/migrations");
const STAMPED = /^(\d{14})_(.+)$/;

/** WARP-3474 — the folders deleted with the Security command center and doors modules. */
const REMOVED_BY_WARP_3474: readonly string[] = [
  "20260923010000_warp_2977_module_security",
  "20260923010100_warp_2977_security_event",
  "20260924000000_warp_2977_security_mode_event_values",
  "20260924000100_warp_2977_security_zones_hours_mode",
  "20260925010000_warp_2980_security_baselines",
  "20260925030000_warp_2978_security_incidents",
  "20260925030100_warp_2978_security_event_ongoing_value",
  "20260925030200_warp_2978_security_event_ongoing_shape",
  "20260925050000_warp_2977_security_lock_values",
  "20260925050100_warp_2977_security_lock_rows",
  "20260925060000_warp_2980_security_pattern_codes",
  "20260925060100_warp_2980_security_patterns_verdicts",
  "20260926000000_warp_2979_security_ai_values",
  "20260926000100_warp_2979_security_ai",
  "20261001095900_warp_2977_security_lock_baseline_backfill",
  "20261001100000_warp_2977_security_lock_baseline",
  "20261002110000_adr_055_module_doors",
  "20261002110100_adr_055_doors_enums",
  "20261002110200_adr_055_doors_tables",
  "20261002110300_adr_055_door_position_source_since",
];

function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => statSync(path.join(MIGRATIONS_DIR, name)).isDirectory());
}

describe("migration folder names (WARP-2896)", () => {
  it("every migration folder is <14-digit stamp>_<name>", () => {
    const odd = migrationFolders().filter((name) => !STAMPED.test(name));
    expect(odd).toEqual([]);
  });

  it("no two migration folders share a name after the stamp — a re-stamped migration never comes back under its old stamp", () => {
    const byName = new Map<string, string[]>();
    for (const folder of migrationFolders()) {
      const m = STAMPED.exec(folder);
      if (!m) continue;
      byName.set(m[2]!, [...(byName.get(m[2]!) ?? []), folder]);
    }
    const duplicated = [...byName.values()].filter((folders) => folders.length > 1);
    expect(duplicated).toEqual([]);
  });

  it("the WARP-2896 workspace migration exists once, under its re-stamped name", () => {
    const folders = migrationFolders();
    expect(folders).toContain("20260924010000_warp_2896_workspace");
    expect(folders).not.toContain("20260920120000_warp_2896_workspace");
  });

  it("the WARP-2704 M365 migration exists once, re-stamped to sort after the stage migrations it merged behind", () => {
    // Written as 20260924010000, the stamp #2247 had already given the 2896
    // workspace migration, so `warp_2704` sorted BEFORE a migration stage boxes
    // had applied. Re-stamped before merge to follow stage's newest at the
    // time, 20260924020000_warp_2911_notification_recipient_username (#2349),
    // then again to 20260924040000 when 20260924030000_warp_2900_extensions
    // (#2323) took the 030000 stamp first.
    const folders = migrationFolders();
    expect(folders).toContain("20260924040000_warp_2704_m365_auth_code_per_connection_app");
    expect(folders).not.toContain("20260924030000_warp_2704_m365_auth_code_per_connection_app");
    expect(folders).not.toContain("20260924010000_warp_2704_m365_auth_code_per_connection_app");
    expect(folders).toContain("20260924020000_warp_2911_notification_recipient_username");
  });

  it("the WARP-3059 M365 sync-cursor migration exists once, re-stamped after stage's newest", () => {
    // Written as 20260924020000_warp_3059_m365_cursor_resume_link, which sorts
    // before 20260924030000_warp_2900_extensions (#2326), now on stage.
    // Re-stamped past it before merge, leaving 20260924040000 free for the
    // WARP-2704 migration this branch carries, and renamed because it now also
    // adds M365Connection.cursorLinkHash (#2347 review). A rename escapes the
    // same-name check above, so the old folder is refused by name here.
    const folders = migrationFolders();
    expect(folders).toContain("20260924050000_warp_3059_m365_sync_cursors");
    expect(folders).not.toContain("20260924020000_warp_3059_m365_cursor_resume_link");
    expect(folders).toContain("20260924030000_warp_2900_extensions");
  });

  it("the WARP-3474 cleanup migration exists once, sorts after the previous newest folder, and the 20 removed folders stay gone", () => {
    // The Security command center and doors migrations (WARP-2977 … WARP-2980,
    // ADR-055) are maintained outside this repository (enterprise-functionality);
    // their 20 folders were deleted and ONE forward migration drops what a box
    // that already ran them still holds. It is stamped after
    // 20261002130000_warp_3452_model_access_tokens, the newest folder when it
    // was written, so a box that applied everything before it runs it last.
    // A removed folder coming back (a squash or cherry-pick from an older
    // branch, a bad conflict resolution) would re-create tables schema.prisma
    // no longer declares, and the cleanup would have to run again.
    const folders = migrationFolders();
    const cleanup = folders.filter((name) => name.endsWith("_warp_3474_remove_security_doors_modules"));
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]!.slice(0, 14) > "20261002130000").toBe(true);
    expect(folders).toContain("20261002130000_warp_3452_model_access_tokens");
    expect(folders.filter((name) => REMOVED_BY_WARP_3474.includes(name))).toEqual([]);
    // The department migrations stay: the department feature is not part of
    // the removal, only its `security` template is.
    expect(folders).toContain("20260922160000_warp_2976_department_profile");
    expect(folders).toContain("20260925040000_warp_2981_active_department_choice");
  });
});
