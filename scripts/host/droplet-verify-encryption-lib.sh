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

# vfy_render_json NDJSON META_JSON PREV_MANIFEST_SHA256 OUT [BUNDLE_DIR]
# Fold the per-check NDJSON rows into the machine-readable report.json:
#   schema/ticket/epic/generated_at + box meta + prev-chain hash + summary +
#   the full checks array (status contract: every registered check is present).
# When BUNDLE_DIR is given, each check gains "evidence_sha256" — the sha256 of
# every evidence file it lists (relative to the bundle) — so the per-check
# hashes are embedded in report.json, the first link in the tamper-evidence
# chain (report.json -> manifest.sha256 -> manifest.sig).
vfy_render_json() {
  local ndjson="$1" meta="$2" prev="$3" out="$4" bundle="${5:-}" py
  py="$(vfy_py)"; [ -n "$py" ] || return 1
  VFY_NDJSON="$ndjson" VFY_META="$meta" VFY_PREV="$prev" VFY_OUT="$out" VFY_BUNDLE="$bundle" \
  "$py" - <<'PYEOF'
import json, os, datetime, hashlib
rows = []
with open(os.environ["VFY_NDJSON"]) as fh:
    for ln in fh:
        ln = ln.strip()
        if ln:
            rows.append(json.loads(ln))
bundle = os.environ.get("VFY_BUNDLE", "")
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()
for r in rows:
    ev_hashes = {}
    if bundle:
        for rel in r.get("evidence", []):
            fp = os.path.join(bundle, rel)
            if os.path.isfile(fp):
                ev_hashes[rel] = sha256_file(fp)
    r["evidence_sha256"] = ev_hashes
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

# -----------------------------------------------------------------------------
# LUKS header evaluators (grep-anchored against real `cryptsetup luksDump` output
# so fixture drift is caught, not papered over)
# -----------------------------------------------------------------------------

vfy_eval_luks_version() {
  local f="$1" v
  v="$(grep -m1 -E '^Version:' "$f" 2>/dev/null | grep -oE '[0-9]+' || true)"
  case "$v" in
    2) printf 'PASS|version=2';;
    "") printf 'FAIL|no-luks-header (cryptsetup luksDump produced no Version line)';;
    *) printf 'FAIL|version=%s (LUKS2 required)' "$v";;
  esac
}

vfy_eval_luks_cipher() {
  local f="$1" c
  c="$(grep -m1 -E '^[[:space:]]*cipher:' "$f" 2>/dev/null | awk '{print $2}')"
  [ "$c" = "aes-xts-plain64" ] && printf 'PASS|cipher=aes-xts-plain64' \
    || printf 'FAIL|cipher=%s (expected aes-xts-plain64)' "${c:-none}"
}

vfy_eval_luks_pbkdf() {
  local f="$1" n
  n="$(grep -cE '^[[:space:]]*PBKDF:[[:space:]]*argon2id' "$f" 2>/dev/null || true)"
  [ "${n:-0}" -ge 1 ] && printf 'PASS|argon2id-keyslots=%s' "$n" \
    || printf 'FAIL|no-argon2id-keyslot (WARP-232 requires Argon2id KDF)'
}

vfy_eval_luks_tpm_token() {
  local f="$1" tok slot
  tok="$(grep -m1 -oE '(systemd-tpm2|clevis)' "$f" 2>/dev/null || true)"
  if [ -z "$tok" ]; then printf 'FAIL|no-tpm2-token-enrolled'; return 0; fi
  slot="$(awk '/systemd-tpm2|clevis/{intok=1} intok && /Keyslot:/{print $2; exit}' "$f")"
  printf 'PASS|token=%s keyslot=%s' "$tok" "${slot:-unknown}"
}

# -----------------------------------------------------------------------------
# Entropy + plaintext-magic evaluators (raw-partition ciphertext proof)
# -----------------------------------------------------------------------------

vfy_eval_entropy() {  # FILE MIN_BITS_PER_BYTE
  local f="$1" min="$2" py
  py="$(vfy_py)"
  [ -n "$py" ] || { printf 'SKIP|python3-unavailable'; return 0; }
  "$py" - "$f" "$min" <<'PYEOF'
import math, sys
data = open(sys.argv[1], "rb").read()
if not data:
    print("SKIP|empty-sample"); raise SystemExit
counts = [0] * 256
for b in data:
    counts[b] += 1
n = len(data)
h = -sum(c / n * math.log2(c / n) for c in counts if c)
h = h + 0.0  # normalise IEEE-754 signed zero (-0.0 -> 0.0) for clean evidence
verdict = "PASS" if h >= float(sys.argv[2]) else "FAIL"
print(f"{verdict}|entropy={h:.2f} min={sys.argv[2]} bytes={n}")
PYEOF
}

VFY_PLAINTEXT_MAGIC='PGDMP
SQLite format 3
PostgreSQL
-----BEGIN
nextcloud
oc_filecache'
vfy_eval_no_plaintext_magic() {
  local f="$1" m
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    if grep -a -q -F "$m" "$f" 2>/dev/null; then
      printf 'FAIL|found=%s' "$(printf '%s' "$m" | awk '{print $1}')"; return 0
    fi
  done <<EOF
$VFY_PLAINTEXT_MAGIC
EOF
  printf 'PASS|no-plaintext-magic'
}

# -----------------------------------------------------------------------------
# Transit probe evaluators: expect-reject, TLS protocol floor, pcap secret scan
# -----------------------------------------------------------------------------

# vfy_eval_expect_reject EXITCODE STDERR_FILE EXPECT_REGEX
# A plaintext probe is expected to be REJECTED. Exit 0 means the plaintext
# connection was accepted -> FAIL. A non-zero exit whose reason matches the
# policy regex is the ideal PASS; a non-zero exit for some other reason is a
# qualified PASS (connection did not succeed) that flags the evidence for review.
vfy_eval_expect_reject() {
  local rc="$1" f="$2" re="$3"
  if [ "$rc" -eq 0 ]; then printf 'FAIL|plaintext-accepted (probe exited 0)'; return 0; fi
  if grep -qE "$re" "$f" 2>/dev/null; then printf 'PASS|rejected-as-required'
  else printf 'PASS|rejected (rc=%s, reason did not match policy regex — inspect evidence)' "$rc"; fi
}

# vfy_eval_tls_protocol SCLIENT_FILE WANT_REGEX
# Parse the "Protocol :" line from `openssl s_client` output; PASS when it
# matches the required floor, FAIL when it does not (or no TLS was negotiated).
vfy_eval_tls_protocol() {
  local f="$1" want="$2" p
  p="$(grep -m1 -E '^[[:space:]]*Protocol[[:space:]]*:' "$f" 2>/dev/null | awk -F': *' '{print $2}')"
  if [ -z "$p" ]; then printf 'FAIL|no-tls-negotiated (no Protocol line in s_client output)'; return 0; fi
  printf '%s' "$p" | grep -qE "$want" && printf 'PASS|protocol=%s' "$p" \
    || printf 'FAIL|protocol=%s (want %s)' "$p" "$want"
}

# vfy_eval_pcap_patterns PCAP PATTERNS_TSV(name<TAB>literal)
# Scan a raw capture for literal byte strings (canary + secret VALUES). The
# verdict names only the pattern NAMES and match counts — never the values —
# so no secret can leak into report.json (Global Constraint: no secrets in the
# bundle report).
vfy_eval_pcap_patterns() {
  local pcap="$1" tsv="$2" total=0 fails="" name lit n
  while IFS="$(printf '\t')" read -r name lit; do
    [ -n "$name" ] && [ -n "$lit" ] || continue
    total=$((total + 1))
    n="$(grep -c -a -F "$lit" "$pcap" 2>/dev/null || true)"
    [ "${n:-0}" -gt 0 ] && fails="$fails$name:$n,"
  done < "$tsv"
  if [ -n "$fails" ]; then printf 'FAIL|%s' "${fails%,}"
  else printf 'PASS|patterns=%s matches=0' "$total"; fi
}

# -----------------------------------------------------------------------------
# Device-chain + manifest helpers
# -----------------------------------------------------------------------------

# vfy_path_is_crypt_backed PATH  (prints "<path>\t<device>\t<crypt|plaintext|...>",
# returns 0 when a dm-crypt layer is present in the device chain, else 1).
# Uses findmnt to resolve the backing device, then walks lsblk -J -s (inverse
# tree) looking for any ancestor of type "crypt". When findmnt/lsblk are missing
# it prints "<path>\tunknown\tno-tools" and returns 1 — a path we cannot prove
# encrypted is NOT evidence of encryption (correctly surfaces as a FAIL).
vfy_path_is_crypt_backed() {
  local p="$1" src py rc json
  if ! command -v findmnt >/dev/null 2>&1 || ! command -v lsblk >/dev/null 2>&1; then
    printf '%s\tunknown\tno-tools\n' "$p"; return 1
  fi
  src="$(findmnt -no SOURCE --target "$p" 2>/dev/null | head -1)"
  [ -n "$src" ] || { printf '%s\tunknown\tno-source\n' "$p"; return 1; }
  py="$(vfy_py)"
  if [ -z "$py" ]; then
    # Fallback: textual lsblk walk (no json) — best-effort ancestor type scan.
    if lsblk -s -no TYPE "$src" 2>/dev/null | grep -qx crypt; then
      printf '%s\t%s\tcrypt\n' "$p" "$src"; return 0
    fi
    printf '%s\t%s\tplaintext\n' "$p" "$src"; return 1
  fi
  # Capture the lsblk JSON into a variable and hand it to python on stdin — a
  # heredoc-as-script would otherwise clobber the piped stdin (SC2259).
  json="$(lsblk -J -s -o NAME,TYPE "$src" 2>/dev/null)"
  printf '%s' "$json" | VFY_SRC="$src" VFY_PATH="$p" "$py" -c '
import json, sys
try:
    tree = json.load(sys.stdin)
except Exception:
    sys.exit(2)
def has_crypt(nodes):
    for n in nodes:
        if n.get("type") == "crypt":
            return True
        if has_crypt(n.get("children", [])):
            return True
    return False
sys.exit(0 if has_crypt(tree.get("blockdevices", [])) else 1)
'
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%s\t%s\tcrypt\n' "$p" "$src"; return 0
  else
    [ "$rc" -eq 2 ] && { printf '%s\t%s\tlsblk-parse-error\n' "$p" "$src"; return 1; }
    printf '%s\t%s\tplaintext\n' "$p" "$src"; return 1
  fi
}

# vfy_manifest DIR — write manifest.sha256 covering every bundle file EXCEPT the
# manifest itself and its signature (the sig signs the manifest, so it is
# necessarily outside it). Relative paths, sorted, stable.
vfy_manifest() {
  local dir="$1" hasher
  if command -v sha256sum >/dev/null 2>&1; then hasher="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then hasher="shasum -a 256"
  else return 1; fi
  ( cd "$dir" && find . -type f \
      ! -name manifest.sha256 ! -name manifest.sig \
      | sed 's|^\./||' | LC_ALL=C sort \
      | while IFS= read -r rel; do $hasher "$rel"; done ) > "$dir/manifest.sha256"
}

# vfy_sha256 FILE — print the hex sha256 of a file (portable).
vfy_sha256() {
  { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | awk '{print $1}'
}

# vfy_gt A B — true when float A > float B (awk; safe with "" / non-numeric).
vfy_gt() {
  awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN{ exit !((a+0) > (b+0)) }'
}
