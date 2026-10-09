# Local media generation

An internal-only, stateless worker for local image generation, image edits and
short video generation. No weights are included in the image. No cloud API key,
runtime model download, remote code, supplied model URL or arbitrary workflow is
accepted. Built-in Diffusers SDXL and Wan pipelines are fixed in source. LTX is an
operator-selected optional video engine.

The service is **implemented but device inference is unverified**. The test suite
injects fake engines and exercises contracts with real PNG bytes, process cleanup,
mask preservation, local loader arguments and fixed encoding argv. It does not
establish image quality, playable model-generated video, GPU/driver support,
latency or successful Docker image build on the target device. `/capabilities`
reports configured files only and always includes `inferenceVerified: false`.

## API

Port 8040, shared fleet internal mTLS launcher. `GET /health` is open. Other
routes require `Authorization: Bearer $MEDIA_GEN_SERVICE_TOKEN`; unset token
fails closed with 503. Authenticated `GET /capabilities` returns image/video
configured booleans, selected engines, source-image video support, limits and
busy state.

`POST /render` accepts a strict JSON object:

| Field | Contract |
|---|---|
| `kind` | `image` or `video` |
| `prompt` | 1–4,000 characters, nonblank |
| `source_base64` | Optional PNG/JPEG/WebP bytes, standard base64, max 4 MiB decoded; no file path/URL/data URI; single image, max 16 megapixels |
| `mask_base64` | Optional same-size mask for image edits; requires source; white edits, black preserves; unsupported for video |
| `width`, `height` | Image: 512–1024, multiples of 64; video: 256–768, multiples of 32; both default 512 |
| `steps` | 8–50, default 30 |
| `seed` | Integer 0–4294967295; random seed selected if omitted |
| `frames` | Video frames 9–49, `8n+1` (compatible with both engines), default 25 |
| `fps` | Video 8–24, default 12 |

Image source and mask are resized to requested dimensions; mismatched original
source/mask sizes are refused. Unmasked pixels are composited back from the
source after inpainting. Source without mask uses SDXL image-to-image with fixed
strength 0.75. Default Wan is text-to-video only: a video source is refused
with `video_source_requires_ltx_engine`. Optional LTX supports image-to-video.

Success returns **binary bytes**, not base64 or a JSON envelope: `image/png` or
H.264 `video/mp4` with `X-Media-Seed`, `X-Media-Engine` (`sdxl`, `wan`, `ltx`),
and `Cache-Control: no-store`. Maximum output 20 MiB. Errors are JSON FastAPI
`{"detail":"named_code"}`: invalid input 400, busy 429, missing model/auth/engine
or inference failure 503, oversized request/output 413, timeout 504; disconnect
cancels with 499 when a response can still be sent.

One job runs at a time with one API worker; jobs are not queued. Each invocation
loads weights in a fresh process, runs, returns bytes and exits. This trades
startup latency for bounded lifecycle and model memory release. Image deadline
120 seconds, video 300 seconds. The controller caps streamed request bytes at
12 MiB, bounds stdout, discards diagnostics, and kills/reaps the process group
on deadline or caller cancellation. The orchestrator must provide durable jobs
for chat operations longer than its foreground tool deadline.

## Provision and deploy

Provision complete Diffusers-format snapshots outside the running appliance:

| Directory (read-only mount) | Built-in class | Upstream snapshot |
|---|---|---|
| `/models/sdxl` | `StableDiffusionXLPipeline` | [SDXL base 1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) |
| `/models/wan` (default video) | `WanPipeline` | [Wan2.1 T2V 1.3B Diffusers](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B-Diffusers) |
| `/models/ltx` (optional) | `LTXPipeline` | [LTX-Video](https://huggingface.co/Lightricks/LTX-Video) |

Include model_index.json, tokenizer/scheduler configs and every component's
safetensor weights/shards. Pick and record exact revisions, hashes, provenance
and applicable license notices in deployment records. Original non-Diffusers
Wan checkpoints are not accepted directly. Model-path validation requires the
fixed built-in class, allowed library names, required safetensor components,
and directories within the mount. Provisioning does not prove inference.

Operator environment: `MEDIA_GEN_SERVICE_TOKEN`; optional `MEDIA_GEN_MODEL_ROOT`
(default `/models`), `MEDIA_GEN_DEVICE` (`cuda`, default; or `cpu`), and
`MEDIA_GEN_VIDEO_ENGINE` (`wan`, default; or `ltx`). Engine selection is not a
model tool argument. Keep `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, disabled
telemetry/implicit tokens, `HF_HOME=/tmp/huggingface`, `WEB_CONCURRENCY=1`.
The worker receives an OS/accelerator environment allowlist, with no service
bearer, TLS key paths, provider token or proxy settings. It forces offline flags and uses
local_files_only, safetensors and trust_remote_code=False. CPU inference is an
operator fallback and may exceed deadlines; no specific device throughput is
promised. CUDA uses Accelerate model CPU offload and Wan VAE float32 decoding.

Keep the service profile default-off; internal orchestrator-facing network
only, with **no WAN or LAN membership**, no host port, read-only root filesystem,
read-only weights, tmpfs `/tmp`, dropped capabilities, no-new-privileges, PID
and memory limits. CPU/GPU memory limits belong to deployment. A CUDA build
requires a compatible accelerator, driver/runtime and sufficient memory; the
locked Torch 2.14.1 resolves CUDA 13 components. A target image build and real
model inference acceptance run are required before enabling a shipped device.
No provision or cloud fallback is performed by a chat call.

The compose `media` profile is off by default. Set `MEDIA_GEN_MODELS_DIR` to an
existing operator-controlled snapshot directory (default `data/media-models`
at the repository root). A missing directory refuses startup; compose never
creates or downloads it. Setup/OTA provision `MEDIA_GEN_SERVICE_TOKEN` without
adding `media` to `COMPOSE_PROFILES`. The dedicated `droplet-media` internal
network contains only media-gen and the orchestrator. Its read-only CA bundle
supports the shared internal mTLS launcher when enabled.

NVIDIA deployments require a compatible driver and NVIDIA Container Toolkit;
add the optional allocation overlay explicitly:

```sh
docker compose --env-file .env -f docker/docker-compose.yml \
  -f docker/docker-compose.media-gpu.yml --profile media up -d media-gen
```

Persist the same overlay in the operator's boot/update invocation when using
this mode. The overlay grants GPU devices only; it does not change the network,
enable a profile or select/download weights. Default memory cap is 16 GiB CPU
RAM for offload, with 4 CPUs, 256 PIDs and a 256 MiB tmpfs. GPU VRAM is not capped
by compose's CPU memory limit. CPU fallback is `MEDIA_GEN_DEVICE=cpu`; it is
subject to the same deadlines and still needs a provisioned larger host.

CI contract tests use only FastAPI/Pillow/pytest and never install model/GPU
libraries or download weights. The existing docker-build image leg builds the
hash-locked production runtime when its inputs change, and in the weekly full
rebuild. Its cold-cache time/disk usage and target image build remain unmeasured.
Following `docs/ci-cost-budget.md`, a planning estimate is 2 billable minutes
per media unit leg × 370 main pushes + 10 affected PR/canary runs × 2 minutes +
14 image builds × 15 minutes, about 970 minutes/month. Adding web-fetch to the
shared unit matrix while removing its duplicate PR trigger adds at most about
370 minutes/month. Recheck actual runner timings after the first build.

Python dependency versions and hashes are locked in `requirements.lock`;
Docker uses the fleet's pinned Python base digest. Regenerate with
`uv pip compile --universal --python-version 3.12 --generate-hashes -o requirements.lock requirements.txt`.
System FFmpeg is the existing fleet dependency used by file-indexer and is
installed from the base distribution at image build; its resolved package
version must be captured in the release SBOM. See [LICENSES.md](LICENSES.md).

Acceptance on a provisioned device: verify no network egress while generating,
reopen PNG dimensions, test white/black masks and unchanged pixels, generate and
play an MP4, check frame count/duration, timeout/disconnect cleanup, concurrency
refusal, RAM/VRAM limits and signed orchestrator audit/job completion. This
acceptance remains pending; fake-engine tests are not a substitute.
