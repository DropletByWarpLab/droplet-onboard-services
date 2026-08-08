/**
 * WARP-1809 — display-only name for an org unit (department / team /
 * the seeded HOUSEHOLD system unit), keyed off the UPPERCASE
 * `DepartmentKind` vocabulary.
 *
 * The build is business-only (WARP-1341): the server still seeds the
 * HOUSEHOLD unit's name as "Household" — a data contract that ids,
 * lookups, and the Nextcloud mount all key off — but no user-visible
 * surface may render that word. ONLY the presentation maps, and it maps
 * off `kind`, never the name string, so a renamed server row still maps
 * and a user-created unit that happens to be NAMED "Household" renders
 * verbatim. (WARP-1808 established the rule; `spaceRenderName` in
 * `space-attribution.ts` is the lowercase-FileSpace-kind flavor of the
 * same mapping.)
 *
 * `kind` is typed `string | undefined`, deliberately wider than
 * `DepartmentKind`: deptRights entries from an older orchestrator carry
 * no kind at all, and the fail-safe for anything unrecognized is the raw
 * name — never a guess.
 */
export function orgUnitDisplayName(kind: string | undefined, name: string): string {
  return kind === "HOUSEHOLD" ? "Workspace" : name;
}
