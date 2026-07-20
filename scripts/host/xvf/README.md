# Vendored XVF3800 `xvf_host` control tool (WARP-1408)

The ReSpeaker XVF3800's XMOS DSP has a known wedge mode (USB audio stream stays
open while delivering digital silence; kernel spams `xhci … buffer overrun`).
The **only** software recoveries are `xvf_host REBOOT 1` (DSP chip reboot over
USB) or a physical power-cycle. Two on-box callers rely on the binary:

- the host self-heal watchdog — `scripts/host/droplet-watchdog.sh` (`voice_dsp` check)
- voice-io's `POST /voice/restart-processor` — `services/voice-io/voice/dsp.py`,
  which sees the binary via the compose bind-mount `/usr/local/bin` →
  `/host/usr-local-bin` (`docker/docker-compose.yml`)

Neither works unless the binary is present on the host. It historically lived at
the ephemeral `/tmp/xvf/xvf_host` and was wiped by every reboot/reflash, so DSP
recovery was inert on real hardware. This payload is vendored so `setup.sh`
(`scripts/lib/single-box.sh` → `install_xvf_host`) installs it durably,
**checksum-verified**, on every deploy.

## Provenance (pinned)

- Source: <https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY>
- Commit: `e4c2073e1470180746580a6ba5468c9bf45026e1` (`master`, 2026-07-14)
- Path: `host_control/linux_x86_64/`
- Files: `xvf_host`, `libcommand_map.so`, `libdevice_usb.so`,
  `transport_config.yaml`, `dfu_cmds.yaml`
- Integrity: `linux_x86_64/SHA256SUMS` (verified by the installer before install;
  install is skipped with a loud error on any mismatch).

## Install layout — why libs sit next to the binary

`xvf_host` `dlopen`s `libcommand_map.so` / `libdevice_usb.so` **relative to the
binary's own directory** (not `cwd`, not the ld cache — verified on-box). So the
installer co-locates the libs with the binary in `/usr/local/bin`. That single
layout serves both callers: the host watchdog runs `/usr/local/bin/xvf_host`, and
the container runs `/host/usr-local-bin/xvf_host` (the same dir, read-only) —
each finds its libs as siblings. USB is the default transport; the I2C/SPI
`transport_config.yaml` is copied for completeness but is not needed for `REBOOT`.

## Updating

Re-download the pinned files, replace them here, regenerate the manifest
(`cd linux_x86_64 && sha256sum xvf_host libcommand_map.so libdevice_usb.so
transport_config.yaml dfu_cmds.yaml > SHA256SUMS`), and bump the commit above.
Other arches (e.g. `rpi_64bit` for the future v2-6 chassis) go in sibling dirs;
`install_xvf_host` selects by `uname -m`.
