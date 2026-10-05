#!/usr/bin/env bash
# =============================================================================
# WARP-3841 — droplet-deploy: static unit/polkit invariants + stubbed logic
#
# No root, no systemd, no docker: systemctl / runuser / docker / visudo are
# PATH stubs, the checkout is a temp git repo, backups go to a temp dir.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY="$ROOT/scripts/host/droplet-deploy.sh"
UNIT="$ROOT/scripts/host/etc-systemd-system/droplet-deploy.service"
RULES="$ROOT/scripts/host/50-droplet-deploy.rules"
REAPPLY="$ROOT/scripts/host/usr-local-sbin/droplet-reapply-host-integration"
FAILURES=0; TESTS=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }
check() { if "${@:2}"; then pass "$1"; else fail "$1"; fi; }

echo "--- static: unit + polkit rule ---"
check "unit ExecStart has no argv" \
  grep -qxF 'ExecStart=/usr/local/sbin/droplet-deploy' "$UNIT"
check "unit removes the sudoers grant in ExecStopPost=+" \
  grep -qxF 'ExecStopPost=+/bin/rm -f /etc/sudoers.d/droplet-deploy' "$UNIT"
check "unit is never [Install]ed" bash -c "! grep -q '^\[Install\]' '$UNIT'"
check "unit is a root oneshot with the 45min timeout" bash -c \
  "grep -qx 'Type=oneshot' '$UNIT' && grep -qx 'User=root' '$UNIT' && grep -qx 'TimeoutStartSec=45min' '$UNIT'"
check "polkit rule: user droplet, verb start, this unit only" bash -c \
  "grep -q 'subject.user === \"droplet\"' '$RULES' && grep -q 'verb\") === \"start\"' '$RULES' \
   && [ \"\$(grep -c 'action.lookup(\"unit\")' '$RULES')\" = 1 ] \
   && grep -q 'unit\") === \"droplet-deploy.service\"' '$RULES'"
check "deploy script sources the reapply wrapper's resolver (no second resolver)" bash -c \
  "grep -q '^resolve_checkout()' '$REAPPLY' && ! grep -q '^resolve_checkout()' '$DEPLOY'"

echo "--- stubbed logic ---"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"; mkdir -p "$BIN"
for t in systemctl runuser docker visudo; do
  cat > "$BIN/$t" <<STUB
#!/usr/bin/env bash
echo "$t \$*" >> "$WORK/calls.log"
case "$t" in
  docker) echo "-- dump --"; exit 0 ;;
  runuser) [ -e "$WORK/sudoers" ] && echo grant-present >> "$WORK/calls.log"; [ -f "$WORK/setup_fail" ] && exit 7; exit 0 ;;
  systemctl)
    [ "\$1" = is-active ] && [ -f "$WORK/inactive" ] && exit 3
    exit 0 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$BIN/$t"
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/hu"; chmod +x "$WORK/hu"

new_repo() {
  rm -rf "$WORK/repo" "$WORK/backups" "$WORK/sudoers"* "$WORK/calls.log" "$WORK/setup_fail" "$WORK/inactive"
  mkdir -p "$WORK/repo/docker/secrets" "$WORK/repo/docker/certs" "$WORK/repo/data/secrets" "$WORK/repo/.data"
  ( cd "$WORK/repo" && git init -q && git config user.email t@t && git config user.name t
    echo 'name: droplet' > docker/docker-compose.yml
    echo ".data/" > .gitignore
    echo S > docker/secrets/s; echo C > docker/certs/c; echo K > data/secrets/k; echo mq > docker/mosquitto.conf
    echo 'SECRET=hunter2' > "$WORK/envreal"; ln -s "$WORK/envreal" .env
    echo .env >> .gitignore; echo data/ >> .gitignore; echo docker/secrets >> .gitignore; echo docker/certs >> .gitignore
    git add -A && git commit -qm init )
}
run_deploy() { # [ts]
  PATH="$BIN:$PATH" DROPLET_HOST_INTEGRATION_REPO_ROOT="$WORK/repo" \
    DROPLET_DEPLOY_BACKUP_DIR="$WORK/backups" DROPLET_DEPLOY_SUDOERS="$WORK/sudoers" \
    DROPLET_DEPLOY_TS="${1:-20260101T000000Z}" DROPLET_DEPLOY_REQUIRED_UNITS="droplet.service" \
    HU_BIN="$WORK/hu" DROPLET_HOST_UNITS_BIN="$WORK/hu" bash "$DEPLOY" 2>&1
}

new_repo
out="$(run_deploy)"; rc=$?
check "success: exit 0" test "$rc" -eq 0
check "success: setup.sh then host-units hook ran" bash -c \
  "grep -q 'setup.sh --skip-docker --skip-drivers' '$WORK/calls.log' && grep -q 'systemctl start droplet-host-units.service' '$WORK/calls.log'"
check "success: the sudoers grant existed while setup ran" grep -q grant-present "$WORK/calls.log"
check "success: sudoers grant removed" test ! -e "$WORK/sudoers"
bk="$WORK/backups/20260101T000000Z"
check "backup: 0600 secrets.tar + db dump, 0700 dir" bash -c \
  "[ \"\$(stat -c %a '$bk/secrets.tar')\" = 600 ] && [ -s '$bk/db.sql.gz' ] && [ \"\$(stat -c %a '$bk')\" = 700 ]"
check "backup: tar holds .env (through the symlink), secrets, certs, mosquitto" bash -c \
  "t=\$(tar -tf '$bk/secrets.tar'); echo \"\$t\" | grep -qx .env && echo \"\$t\" | grep -q data/secrets/k && echo \"\$t\" | grep -q docker/certs/c && echo \"\$t\" | grep -q docker/secrets/s && echo \"\$t\" | grep -q docker/mosquitto.conf \
   && [ \"\$(tar -xOf '$bk/secrets.tar' .env)\" = SECRET=hunter2 ]"
check "output never prints secret contents" bash -c "! echo '$out' | grep -q hunter2"

new_repo; touch "$WORK/setup_fail"
out="$(run_deploy)"; rc=$?
check "setup failure: exit 1" test "$rc" -eq 1
check "setup failure: restore hint names the backup + sync-secrets + force-recreate" bash -c \
  "echo '$out' | grep -q '$WORK/backups/20260101T000000Z' && echo '$out' | grep -q 'tar -xp' && echo '$out' | grep -q 'sync-secrets' && echo '$out' | grep -q 'force-recreate'"
check "setup failure: sudoers grant removed" test ! -e "$WORK/sudoers"
check "setup failure: host hook not started" bash -c "! grep -q 'droplet-host-units.service' '$WORK/calls.log'"

new_repo; touch "$WORK/inactive"
out="$(run_deploy)"; rc=$?
check "gate failure (required unit inactive): exit 1" test "$rc" -eq 1

new_repo; echo dirt > "$WORK/repo/untracked"
out="$(run_deploy)"; rc=$?
check "dirty checkout refused (exit 1, no backup, no setup)" bash -c \
  "[ $rc -eq 1 ] && [ ! -d '$WORK/backups/20260101T000000Z' ] && ! grep -q setup.sh '$WORK/calls.log'"

new_repo; sleep 300 & lockpid=$!; echo "$lockpid" > "$WORK/repo/.data/.setup.lock"
out="$(run_deploy)"; rc=$?; kill "$lockpid" 2>/dev/null
check "held .setup.lock refused" test "$rc" -eq 1

new_repo
for i in 1 2 3 4 5; do run_deploy "2026010${i}T000000Z" >/dev/null; done
check "rotation keeps the last 3 backup dirs" bash -c \
  "[ \"\$(ls '$WORK/backups' | wc -l | tr -d ' ')\" = 3 ] && [ -d '$WORK/backups/20260105T000000Z' ] && [ ! -d '$WORK/backups/20260101T000000Z' ]"

echo ""
if [ "$FAILURES" -eq 0 ]; then printf "  \033[32mAll %d tests passed\033[0m\n\n" "$TESTS"; exit 0; fi
printf "  \033[31m%d of %d tests FAILED\033[0m\n\n" "$FAILURES" "$TESTS"; exit 1
