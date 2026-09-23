#!/usr/bin/env bash
# WARP-2548 — every secret a container mounts must be readable by the uid that
# actually opens it, under the modes and ownership setup really writes.
#
# The broker crash-looped 6,000+ times because a 0600 install-user-owned key
# was bind-mounted into eclipse-mosquitto, which drops to uid 1883 before
# loading TLS. This suite makes that class fail CI instead of a box:
#
#   1. Run the REAL setup writers in a sandbox (internal_ca_issue for every
#      service-tls bundle compose mounts, _generate_redis_acl, the single-file
#      key syncs) and read back the modes they produce.
#   2. For every `../data/secrets/...` mount in docker/docker-compose.yml,
#      derive the reader uid independently: a staging wrapper (`install -o …`
#      from the mount in `command`) → root; else compose `user:`; else the
#      Dockerfile's final USER (none → root); else a known-image table. An
#      image the table doesn't know FAILS — declare it here, deliberately.
#   3. Owner is always "the install user" (relocate_secrets_to_data chown -Rs
#      the tree), never the reader: a non-root reader passes only on o+r.
#   4. SECRET_READERS (scripts/lib/secret-readers.sh) — the host-side check's
#      table — must equal the derived non-root readers, file for file.
#   5. The host-side lib: the check names file/owner/mode/uid and fails on a
#      tightened file; the repair normalises a 1883-era/0644 key and is
#      idempotent.
#   6. The db/cache/broker staging wrappers run the start-time secret-guard
#      over every file they stage, before the first `install`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE="$REAL/docker/docker-compose.yml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

python3 -c 'import yaml' 2>/dev/null || fail "python3-yaml required (apt-get install python3-yaml)"

export REPO_ROOT="$WORK"
LOG_FILE="$WORK/setup.log"; export LOG_FILE
# shellcheck disable=SC1091
source "$REAL/scripts/lib/logging.sh"
# shellcheck disable=SC1091
source "$REAL/scripts/lib/secrets.sh"

# --- 1. real writers into the sandbox ---------------------------------------
export REDIS_PASSWORD=p0 REDIS_HOST_PASSWORD=p1 REDIS_PASSWORD_ORCHESTRATOR=p2 \
       REDIS_PASSWORD_AI_GATEWAY=p3 REDIS_PASSWORD_MCP=p4
for svc in $(grep -oE 'data/secrets/service-tls/[a-z0-9-]+' "$COMPOSE" | sort -u | sed 's#.*/##'); do
  internal_ca_issue "$svc" >/dev/null 2>&1 || fail "internal_ca_issue $svc"
done
_generate_redis_acl >/dev/null 2>&1 || fail "_generate_redis_acl"
sync_audit_signing_key >/dev/null 2>&1 || fail "sync_audit_signing_key"
sync_doc_kek_key >/dev/null 2>&1 || fail "sync_doc_kek_key"
sync_email_fernet_key >/dev/null 2>&1 || fail "sync_email_fernet_key"

# --- 2-4. derive readers from compose, evaluate against written modes -------
readers_tsv="$WORK/readers.tsv"
for row in "${SECRET_READERS[@]}"; do echo "$row"; done > "$readers_tsv"

python3 - "$REAL" "$WORK" "$readers_tsv" <<'PY' || exit 1
import os, re, stat, sys, yaml
real, work, readers_tsv = sys.argv[1:4]
compose = yaml.safe_load(open(os.path.join(real, "docker/docker-compose.yml")))

# Upstream images and the uid that opens a DIRECTLY mounted file. Adding a
# secret mount to an image not listed here fails on purpose: find out what
# uid it runs as (entrypoint gosu/su-exec/setpriv, or `user` in its config)
# and record it.
KNOWN_IMAGES = {
    "eclipse-mosquitto": 1883,   # drops to mosquitto BEFORE loading TLS (the incident)
    "redis": 999,                # docker-entrypoint.sh: setpriv --reuid redis
    "pgvector/pgvector": 999,    # postgres entrypoint: gosu postgres
    "postgres": 999,
    "nextcloud": 33,             # apache master root, mod_php workers www-data
    "ghcr.io/blakeblackshear/frigate": 0,
}
def image_uid(image):
    image = re.sub(r"^\$\{[A-Z_]+:-(.*)\}$", r"\1", image)   # ${FRIGATE_IMAGE:-…}
    name = image.split("@")[0]
    if ":" in name.split("/")[-1]:
        name = name.rsplit(":", 1)[0]                              # drop the tag
    return KNOWN_IMAGES.get(name)

def dockerfile_uid(build):
    df = os.path.join(real, "docker", build.get("context", "."), build.get("dockerfile", "Dockerfile"))
    uid = 0
    for line in open(os.path.normpath(df)):
        m = re.match(r"\s*FROM\s", line, re.I)
        if m: uid = 0                      # a new stage resets USER
        m = re.match(r"\s*USER\s+(\S+)", line, re.I)
        if m:
            u = m.group(1).split(":")[0]
            if not u.isdigit():
                sys.exit(f"FAIL: {df}: USER {u} — use a numeric uid so the secret-reader check can evaluate it")
            uid = int(u)
    return uid

errors, derived = [], set()
for name, svc in compose["services"].items():
    cmd = svc.get("command") or ""
    cmd = " ".join(cmd) if isinstance(cmd, list) else cmd
    for v in svc.get("volumes") or []:
        src, tgt = (v.split(":")[:2] if isinstance(v, str) else (v.get("source", ""), v.get("target", "")))
        if not src.startswith("../data/secrets/"):
            continue
        rel = src[len("../data/secrets/"):]
        if re.search(r"install -o \S+ -g \S+ -m \d+ " + re.escape(tgt) + r"[/ ]", cmd):
            if "user" in svc:
                errors.append(f"{name}: staging wrapper with `user:` — the wrapper must run as container root")
            uid, why = 0, "staged by the command wrapper as container root"
        elif "user" in svc:
            u = str(svc["user"]).split(":")[0]
            if not u.isdigit():
                errors.append(f"{name}: user: {u} — use a numeric uid"); continue
            uid, why = int(u), "compose user:"
        elif "build" in svc:
            uid, why = dockerfile_uid(svc["build"]), "Dockerfile USER"
        else:
            uid = image_uid(svc["image"])
            if uid is None:
                errors.append(f"{name}: mounts data/secrets/{rel} but image {svc['image']} is not in KNOWN_IMAGES "
                              "(tests/secret-readers.test.sh) — record the uid it reads secrets as")
                continue
            why = "image default"
        host = os.path.join(work, "data/secrets", rel)
        if not os.path.exists(host):
            errors.append(f"{name}: data/secrets/{rel} is mounted but no setup writer produced it"); continue
        files = [rel] if os.path.isfile(host) else sorted(os.path.join(rel, f) for f in os.listdir(host) if f.endswith(".pem"))
        if uid == 0:
            continue
        for f in files:
            derived.add((name, f, uid))

declared = set()
for line in open(readers_tsv):
    svc, rel, uid, _ = line.rstrip("\n").split("|", 3)
    declared.add((svc, rel, int(uid)))
    mode = stat.S_IMODE(os.stat(os.path.join(work, "data/secrets", rel)).st_mode)
    if not mode & 0o004:
        errors.append(f"{svc} runs as uid {uid} but setup writes data/secrets/{rel} {oct(mode)[2:]} "
                      "install-user-owned — unreadable, it would crash-loop (WARP-2548)")

# A non-root reader of a directory mount must declare the files it opens
# (nextcloud reads only ca.pem of its bundle); a declared row must match a
# derived (service, file, uid).
for (svc, rel, uid) in declared - derived:
    errors.append(f"SECRET_READERS row {svc}|{rel}|{uid} matches no compose mount/derived uid")
for svc, uid in {(s, u) for (s, _, u) in derived}:
    if not any(d[0] == svc and d[2] == uid for d in declared):
        errors.append(f"{svc} reads data/secrets as non-root uid {uid} but has no SECRET_READERS row "
                      "(scripts/lib/secret-readers.sh) — declare the files it opens, or stage them")
if errors:
    print("\n".join("FAIL: " + e for e in errors), file=sys.stderr); sys.exit(1)
print(f"ok: {len(declared)} non-root secret reader(s) verified")
PY

# --- 5. host-side lib: check + repair ----------------------------------------
secret_readers_check >/dev/null 2>&1 || fail "secret_readers_check fails on a fresh sandbox"
chmod 600 "$WORK/data/secrets/redis/users.acl"
out="$(secret_readers_check 2>&1)" && fail "secret_readers_check passed a 0600 users.acl (redis uid 999 can't read it)"
echo "$out" | grep -q 'cache runs as uid 999 but cannot read data/secrets/redis/users.acl (owner uid [0-9]*, mode 600)' \
  || fail "check message must name service, uid, file, owner and mode — got: $out"
chmod 644 "$WORK/data/secrets/redis/users.acl"

key="$WORK/data/secrets/service-tls/broker/key.pem"
chmod 644 "$key"                      # the pre-WARP-2154 no-sudo fallback
secret_readers_guard >/dev/null 2>&1 || fail "secret_readers_guard failed after a repairable state"
m="$(stat -c %a "$key" 2>/dev/null || stat -f %Lp "$key")"
[ "$m" = "600" ] || fail "repair left broker key.pem at $m (want 600)"
: > "$LOG_FILE"
secret_readers_guard >/dev/null 2>&1
grep -q 'repaired' "$LOG_FILE" && fail "repair is not idempotent — second run touched: $(cat "$LOG_FILE")"

# --- 6. start-time guard precedes staging in every wrapper -------------------
for svc in db cache broker; do
  body="$(python3 -c "import yaml,sys;c=yaml.safe_load(open(sys.argv[1]))['services'][sys.argv[2]]['command'];print(c if isinstance(c,str) else c[-1])" "$COMPOSE" "$svc")"
  guard="${body%%install -*}"
  echo "$guard" | grep -qF "FATAL secret-guard (WARP-2548) $svc cannot read" \
    || fail "compose $svc: secret-guard missing before the first install"
  for src in $(echo "$body" | grep -oE 'install -o [a-z]+ -g [a-z]+ -m [0-9]+ /[^ ]+' | awk '{print $NF}'); do
    echo "$guard" | grep -qF " $src" || fail "compose $svc: staged $src is not covered by the secret-guard"
  done
done

echo "PASS: secret-readers (WARP-2548)"
