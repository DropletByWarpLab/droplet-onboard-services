# 2 uncommitted files on the box — Phase 0 review needed

The box has two files in its working tree that aren't committed to any
branch. Phase 0 captures them for review; a follow-up PR (separate from
the Phase 0 capture) should resolve each one.

## 1. `docker/frigate/config.yml` — modified

**Recommendation: do NOT commit as-is. Treat as in-flight work.**

```diff
@@ -83,4 +83,21 @@ objects:
 # `T3stCamPw!`, not `T3stCamPw%21` — because the bundled ffmpeg
 # does not URL-decode userinfo and the camera returns 401 + locks the
 # account after ~5 retries on percent-escapes.
-cameras: {}
+cameras:
+  camera_192_168_20_176:
+    ffmpeg:
+      inputs:
+        - path: rtsp://192.168.20.176:554/stream1
+          roles:
+            - detect
+            - record
+    detect:
+      enabled: true
+      width: 1280
+      height: 720
+      fps: 5
+    record:
+      enabled: true
+    snapshots:
+      enabled: true
+version: 0.17-0
```

Why not commit:
- Hardcoded camera IP `192.168.20.176` is environment-specific (this
  box's br-lan DHCP pool) — not a portable default.
- No credentials in the URL — the comment block right above says creds
  should be raw `T3stCamPw!`, but the URL has neither user nor password.
  Either auth-less RTSP works on this camera or the entry would fail at
  runtime.
- `version: 0.17-0` at the bottom is a Frigate schema-version pin
  worth keeping IF intentional; needs verification against the running
  Frigate image (`ghcr.io/blakeblackshear/frigate:stable`).

What to do instead:
- The dashboard's camera-discovery service is the canonical path for
  adding cameras (`POST /api/cameras/discover` → operator confirms →
  Frigate config rewritten). If this entry was hand-added during a
  test, it should land via that flow instead.
- Stash on the box (`cd /home/droplet/edge-platform && git stash push
  docker/frigate/config.yml`) to keep the working tree clean. Re-add
  via the dashboard.

## 2. `services/oled-display/tools/repl_upload.py` — new file (untracked)

**Recommendation: commit in a separate PR after Phase 0 lands.**

A useful utility — minimal CircuitPython REPL file-pusher for
PyPortal Titano. Reproduces the upload subset of `mpremote` without
the dependency (mpremote isn't installed on the PoC box).

```python
"""Write files to a CircuitPython board over the USB-serial REPL.

When CircuitPython has flash write access (the default for storage.remount
or the typical settings.toml setup), the host-side USB-MSC view of
CIRCUITPY is read-only. The only way to update boot.py / code.py / lib from
the host is over the REPL on /dev/ttyACM0 — which is what mpremote does,
but mpremote isn't installed on the POC box. This is a minimal stand-in
for the upload subset.

Usage:
    sudo python3 repl_upload.py --port /dev/ttyACM0 \\
        --push pyportal/code.py:code.py \\
        --push pyportal/boot.py:boot.py
"""
```

Why commit:
- Standalone tool, no host-specific paths or secrets.
- Solves a documented gap (no `mpremote` in PoC dependencies).
- Other developers will hit the same problem when iterating on
  `services/oled-display/pyportal/*` firmware.

What to do:
- After Phase 0 PR lands, open a tiny separate PR:
  `feat(oled-display): add REPL upload tool for PyPortal Titano`
- Include the file as captured on the box (no edits required).
- The full file content is on the box at
  `/home/droplet/edge-platform/services/oled-display/tools/repl_upload.py`
  — pull it directly into that follow-up PR.
