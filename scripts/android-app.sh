#!/usr/bin/env bash
# Wrapper that lets `npm run android-app:<task>` dispatch to gradlew without
# requiring Java on every contributor's machine. If JAVA isn't available we
# fail loud with an actionable hint rather than crashing inside Gradle.
#
# Usage: scripts/android-app.sh <gradlew-task> [args...]
#   e.g. scripts/android-app.sh :app:testDebugUnitTest
#        scripts/android-app.sh :app:assembleDebug
set -euo pipefail

ANDROID_APP_DIR="$(cd "$(dirname "$0")/.." && pwd)/clients/android-app"

if ! command -v java >/dev/null 2>&1; then
  cat >&2 <<EOF
android-app: JDK not found on PATH.

This task needs JDK 17 + Android SDK 35. Contributors who only touch the
Node services / dashboard can skip it — CI builds the APK on every PR.

To install locally:
  • Easiest: download Android Studio (bundles JDK 17 + SDK Manager)
  • Or: install Temurin 17 (https://adoptium.net) + Android command-line
    tools, then set ANDROID_HOME.

If you DID install but PATH isn't picking it up, try:
  export JAVA_HOME=...
  export PATH="\$JAVA_HOME/bin:\$PATH"
EOF
  exit 127
fi

if [ ! -x "$ANDROID_APP_DIR/gradlew" ]; then
  cat >&2 <<EOF
android-app: gradle-wrapper jar isn't present. Bootstrap it once with the
system Gradle:

  cd clients/android-app
  gradle wrapper --gradle-version 8.10.2 --distribution-type bin

Or open clients/android-app/ in Android Studio — sync regenerates the
wrapper automatically.
EOF
  exit 1
fi

cd "$ANDROID_APP_DIR"
exec ./gradlew "$@"
