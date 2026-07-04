#!/usr/bin/env bash
# =============================================================================
# WARP-966 — droplet-verify-encryption-lib: pure evaluators + report/manifest/
# signing helpers for the on-hardware encryption verification harness.
#
# This file is SOURCED, never executed. It contains only pure functions:
#   * evaluators that take captured command output (files/strings) and print a
#     single verdict line "PASS|<detail>", "FAIL|<detail>", or "SKIP|<reason>";
#   * JSON/Markdown report rendering;
#   * manifest hashing and offline bundle verification.
# No command execution against the live stack, no root, no Docker — so the whole
# file is unit-testable against committed fixtures (tests/verify-encryption.test.sh).
#
# Mirrors the split proven by droplet-backup.sh + droplet-backup-lib.sh.
# =============================================================================
set -u

# -----------------------------------------------------------------------------
# Verdict + JSON primitives
# -----------------------------------------------------------------------------

# vfy_json_escape STRING — escape backslashes and double-quotes, strip newlines,
# so the result is safe to embed inside a JSON string literal.
vfy_json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n'; }

# vfy_result_line ID FAMILY MAPS_TO THREAT_IDS DESCRIPTION STATUS DETAIL EVIDENCE_CSV
# Emit one NDJSON record for a check result. EVIDENCE_CSV is a comma-separated
# list of relative evidence paths (may be empty).
vfy_result_line() {
  local id="$1" family="$2" maps="$3" threats="$4" desc="$5" status="$6" detail="$7" ev="$8"
  local ev_json="" t
  if [ -n "$ev" ]; then
    for t in ${ev//,/ }; do ev_json="$ev_json\"$(vfy_json_escape "$t")\","; done
    ev_json="${ev_json%,}"
  fi
  printf '{"id":"%s","family":"%s","maps_to":["%s"],"threat_ids":["%s"],"description":"%s","status":"%s","detail":"%s","evidence":[%s]}\n' \
    "$(vfy_json_escape "$id")" "$(vfy_json_escape "$family")" "$(vfy_json_escape "$maps")" \
    "$(vfy_json_escape "$threats")" "$(vfy_json_escape "$desc")" "$status" \
    "$(vfy_json_escape "$detail")" "$ev_json"
}

# vfy_py — resolve a python interpreter (python3 on the box/CI, python on some
# dev hosts). Prints the path or nothing.
vfy_py() { command -v python3 || command -v python || true; }

# vfy_render_json NDJSON META_JSON PREV_MANIFEST_SHA256 OUT
# Fold the per-check NDJSON rows into the machine-readable report.json:
#   schema/ticket/epic/generated_at + box meta + prev-chain hash + summary +
#   the full checks array (status contract: every registered check is present).
vfy_render_json() {
  local ndjson="$1" meta="$2" prev="$3" out="$4" py
  py="$(vfy_py)"; [ -n "$py" ] || return 1
  VFY_NDJSON="$ndjson" VFY_META="$meta" VFY_PREV="$prev" VFY_OUT="$out" \
  "$py" - <<'PYEOF'
import json, os, datetime
rows = []
with open(os.environ["VFY_NDJSON"]) as fh:
    for ln in fh:
        ln = ln.strip()
        if ln:
            rows.append(json.loads(ln))
meta = json.loads(os.environ["VFY_META"] or "{}")
p = sum(1 for r in rows if r["status"] == "PASS")
f = sum(1 for r in rows if r["status"] == "FAIL")
s = sum(1 for r in rows if r["status"] == "SKIP")
blockers = [r["id"] for r in rows if r["status"] == "FAIL"]
report = {
    "schema": "droplet-encryption-evidence/v1",
    "ticket": "WARP-966",
    "epic": "WARP-957",
    "generated_at": datetime.datetime.now(datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "box": meta,
    "prev_manifest_sha256": os.environ["VFY_PREV"],
    "summary": {"pass": p, "fail": f, "skip": s, "release_blockers": blockers},
    "checks": rows,
}
with open(os.environ["VFY_OUT"], "w") as fh:
    json.dump(report, fh, indent=2, sort_keys=False)
    fh.write("\n")
PYEOF
}

# vfy_render_md NDJSON OUT — human-readable acceptance evidence. Renders a
# results table (✅/❌/⏭), a RELEASE BLOCKER bullet list of FAILs, and a SKIP
# table with reasons (status contract: SKIPs are listed, never hidden).
vfy_render_md() {
  local ndjson="$1" out="$2" py
  py="$(vfy_py)"; [ -n "$py" ] || return 1
  VFY_NDJSON="$ndjson" VFY_OUT="$out" "$py" - <<'PYEOF'
import json, os
rows = []
with open(os.environ["VFY_NDJSON"]) as fh:
    for ln in fh:
        ln = ln.strip()
        if ln:
            rows.append(json.loads(ln))
icon = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭"}
p = sum(1 for r in rows if r["status"] == "PASS")
f = sum(1 for r in rows if r["status"] == "FAIL")
s = sum(1 for r in rows if r["status"] == "SKIP")
out = []
out.append("# WARP-966 — encryption verification evidence\n")
out.append("Ticket **WARP-966** · Epic **WARP-957** · "
           "schema `droplet-encryption-evidence/v1`\n")
out.append(f"**Summary:** {p} PASS · {f} FAIL · {s} SKIP\n")
out.append("| Check | Status | Maps to | Threats | Detail |")
out.append("|---|---|---|---|---|")
for r in rows:
    mt = ",".join(r.get("maps_to", []))
    th = ",".join(r.get("threat_ids", []))
    out.append(f"| `{r['id']}` | {icon.get(r['status'], r['status'])} "
               f"{r['status']} | {mt} | {th} | {r.get('detail','')} |")
out.append("")
blockers = [r for r in rows if r["status"] == "FAIL"]
if blockers:
    out.append("## RELEASE BLOCKERS\n")
    out.append("Each FAIL below is a documented plaintext path and, per the "
               "WARP-966 acceptance criteria, a release blocker:\n")
    for r in blockers:
        out.append(f"- **RELEASE BLOCKER** `{r['id']}` "
                   f"({','.join(r.get('maps_to', []))}): {r.get('detail','')}")
    out.append("")
skips = [r for r in rows if r["status"] == "SKIP"]
if skips:
    out.append("## Skipped checks (status contract — listed, not hidden)\n")
    out.append("| Check | Reason |")
    out.append("|---|---|")
    for r in skips:
        out.append(f"| `{r['id']}` | {r.get('detail','')} |")
    out.append("")
with open(os.environ["VFY_OUT"], "w") as fh:
    fh.write("\n".join(out))
    fh.write("\n")
PYEOF
}
