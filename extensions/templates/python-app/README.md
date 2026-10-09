# Python App

Run `workspace_run` with `["app-check"]` to check health and the root page, then propose for review. Hosting starts after owner promotion. No package installation or network egress is available: vendor dependencies and built assets in this checkout.

Bind only `127.0.0.1` at `PORT`. Routes live under `DROPLET_EXT_BASE_PATH`; writable state belongs under `DROPLET_EXT_DATA_DIR`. No cookies or Droplet credentials arrive at this separate app origin.
