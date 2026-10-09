"""Pin the offline media boundary in the actual compose/release tree."""
import json
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[3]


def test_media_network_profile_and_readonly_models_are_fixed():
    compose = yaml.safe_load((REPO / "docker/docker-compose.yml").read_text(encoding="utf-8"))
    service = compose["services"]["media-gen"]
    assert service["profiles"] == ["media"]
    assert service["networks"] == ["droplet-media"]
    assert compose["networks"]["droplet-media"]["internal"] is True
    peers = {name for name, item in compose["services"].items() if "droplet-media" in item.get("networks", [])}
    assert peers == {"media-gen", "orchestrator"}
    assert "ports" not in service and "network_mode" not in service and "env_file" not in service
    assert service["read_only"] is True and service["init"] is True
    assert service["cap_drop"] == ["ALL"] and service["security_opt"] == ["no-new-privileges:true"]
    models = [mount for mount in service["volumes"] if isinstance(mount, dict)]
    assert models == [{"type": "bind", "source": "${MEDIA_GEN_MODELS_DIR:-../data/media-models}", "target": "/models", "read_only": True, "bind": {"create_host_path": False}}]
    assert "../data/secrets/service-tls/media-gen:/data/service-tls:ro" in service["volumes"]
    assert service["healthcheck"]["test"] == ["CMD", "python", "-m", "_shared.healthcheck", "8040", "/health"]
    for key in ("mem_limit", "cpus", "pids_limit", "tmpfs"):
        assert key in service


def test_media_env_delivers_only_own_bearer_and_fixed_offline_settings():
    service = yaml.safe_load((REPO / "docker/docker-compose.yml").read_text(encoding="utf-8"))["services"]["media-gen"]
    env = dict(entry.partition("=")[::2] for entry in service["environment"])
    assert env["MEDIA_GEN_SERVICE_TOKEN"] == "${MEDIA_GEN_SERVICE_TOKEN:-}"
    assert env["MEDIA_GEN_MODEL_ROOT"] == "/models"
    assert env["HF_HUB_OFFLINE"] == env["TRANSFORMERS_OFFLINE"] == "1"
    assert env["HF_HUB_DISABLE_IMPLICIT_TOKEN"] == env["HF_HUB_DISABLE_TELEMETRY"] == "1"
    assert not {"DATABASE_URL", "JWT_SECRET", "DEVICE_SECRET", "DEVICE_SECRET_KEY", "HF_TOKEN", "BRAVE_SEARCH_API_KEY"} & env.keys()
    overlay = yaml.safe_load((REPO / "docker/docker-compose.media-gpu.yml").read_text())
    assert overlay == {"services": {"media-gen": {"gpus": "all"}}}


def test_release_and_ci_cover_media_without_installing_gpu_dependencies_in_unit_tests():
    manifest = json.loads((REPO / "scripts/release/services.json").read_text())
    media = next(item for item in manifest["services"] if item["name"] == "media-gen")
    assert media == {"name": "media-gen", "context": ".", "dockerfile": "services/media-gen/Dockerfile", "healthcheck": {"type": "http", "port": 8040, "path": "/health"}}
    dev = (REPO / "services/media-gen/requirements-dev.txt").read_text()
    assert "-r requirements.txt" not in dev and "torch==" not in dev and "diffusers==" not in dev
    ci = (REPO / ".github/workflows/ci.yml").read_text()
    assert 'media-gen:\n' in ci and '"services/media-gen/**"' in ci and '"media-gen"' in ci
    image_ci = (REPO / ".github/workflows/docker-build.yml").read_text()
    assert "--profile media" in image_ci and '"media-gen"' in image_ci


def test_media_bearer_is_backfilled_without_enabling_profile():
    setup = (REPO / "scripts/lib/secrets.sh").read_text()
    ota = (REPO / "docker/ota/env-reconcile.sh").read_text()
    assert "MEDIA_GEN_SERVICE_TOKEN=$media_gen_service_token" in setup
    assert '_migrate_ensure_key MEDIA_GEN_SERVICE_TOKEN "$(openssl rand -hex 32)"' in setup
    assert "MEDIA_GEN_SERVICE_TOKEN hex32" in ota
    # OTA's profile additions are deliberate; media must remain operator opt-in.
    assert "ADD_PROFILES='media" not in ota
