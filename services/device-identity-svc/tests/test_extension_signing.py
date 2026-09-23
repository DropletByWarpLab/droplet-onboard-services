"""WARP-2900 (ADR-056 slice H1): the box extension-signing key.

The sidecar holds a SECOND ECDSA-P256 key used for one thing only: signing
extension statements the owner promoted. These tests pin the custody rules
the orchestrator cannot enforce from the outside:

  - the key is distinct from the device-id key, in its own file, created
    lazily on the first sign (never by GetStatus, never before provisioning);
  - the sidecar, not the caller, decides what gets signed: the statement
    must parse as a JSON object with kind == keyUsage == "extension", and
    the signed bytes are EXTENSION_STATEMENT_PREFIX || statement;
  - the real (TPM) backend fails closed until it implements the key.

Mutations each test is written to catch are named inline.
"""
import json
import sys
import types
from unittest.mock import MagicMock

import grpc
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from backends.mock import MockBackend
from extension_signing import (
    EXTENSION_KEY_FILE,
    EXTENSION_KEY_USAGE,
    EXTENSION_STATEMENT_PREFIX,
    MAX_STATEMENT_BYTES,
    StatementRefused,
    spki_fingerprint,
    validate_statement,
)
from grpc_generated import device_identity_pb2 as pb
from grpc_server import DeviceIdentityServicer


def _statement(**overrides) -> bytes:
    body = {
        "commit": "0" * 40,
        "extensionId": "word-count",
        "keyUsage": "extension",
        "kind": "extension",
        "manifestSha256": "a" * 64,
        "schemaVersion": 1,
        "tree": "1" * 40,
        "version": "0.1.0",
        "workspaceId": "word-count",
    }
    body.update(overrides)
    body = {k: v for k, v in body.items() if v is not None}
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode()


def _verify(spki_der: bytes, signature: bytes, data: bytes) -> bool:
    pub = serialization.load_der_public_key(spki_der)
    try:
        pub.verify(signature, data, ec.ECDSA(hashes.SHA256()))
        return True
    except InvalidSignature:
        return False


@pytest.fixture
def backend(tmp_path):
    return MockBackend(storage_root=tmp_path)


@pytest.fixture
def provisioned(backend):
    backend.provision(device_id="droplet-test", sealing_pcrs=[0, 2, 4, 7])
    return backend


@pytest.fixture
def servicer(backend):
    return DeviceIdentityServicer(backend)


# ─── the prefix is the sidecar's, and it is distinct ─────────────────────


def test_prefix_is_the_documented_constant():
    # The orchestrator mirrors this literal (extension-verify.ts) and a drift
    # test there reads THIS file as text. Changing it is a protocol version.
    assert EXTENSION_STATEMENT_PREFIX == b"droplet-extension-statement:v1:"
    assert EXTENSION_KEY_USAGE == "extension"


def test_prefix_is_disjoint_from_every_device_key_domain():
    # Every other message the box signs, and its prefix. None may be a prefix
    # of another, or a signature could be replayed across protocols.
    others = [
        b"droplet-cert:v1:",
        b"droplet-provision:v1:",
        b"droplet-claim:v1:",
        b"droplet-release:v1:",
        b"droplet-overlay-poll:v1:",
        b"droplet-overlay-answer:v1:",
        b"droplet-overlay-enroll:v1:",
        b"droplet-overlay-revoke:v1:",
        b"{",  # audit daily root + hardware BOM are bare canonical JSON
        b"[",
    ]
    for other in others:
        assert not EXTENSION_STATEMENT_PREFIX.startswith(other)
        assert not other.startswith(EXTENSION_STATEMENT_PREFIX)


# ─── validate_statement: the sidecar decides what it will sign ──────────


def test_validate_accepts_an_extension_statement():
    parsed = validate_statement(_statement())
    assert parsed["kind"] == "extension"


@pytest.mark.parametrize(
    "statement,why",
    [
        (_statement(kind="release"), "kind release"),
        (_statement(kind=None), "kind missing"),
        (_statement(keyUsage="release"), "usage release"),
        (_statement(keyUsage=None), "usage missing"),
        (_statement(kind="Extension"), "case matters"),
        (b"not json", "not json"),
        (b"[1,2,3]", "json array"),
        (b'"extension"', "json string"),
        (b"\xff\xfe", "not utf-8"),
        # First-wins and last-wins parsers disagree on this one; refuse it
        # outright so the sidecar and any verifier can never read two kinds.
        (
            b'{"kind":"release","keyUsage":"extension","kind":"extension"}',
            "duplicate key",
        ),
    ],
)
def test_validate_refuses(statement, why):
    # MUTATION: drop the kind check or the keyUsage check -> a row goes green.
    with pytest.raises(StatementRefused):
        validate_statement(statement)


def test_validate_refuses_an_oversized_statement():
    padded = _statement(extensionId="x" * MAX_STATEMENT_BYTES)
    assert len(padded) > MAX_STATEMENT_BYTES
    with pytest.raises(StatementRefused):
        validate_statement(padded)


# ─── MockBackend: a distinct, lazily created, persisted key ─────────────


def test_no_key_before_first_sign_and_status_never_creates_one(provisioned, tmp_path):
    assert provisioned.extension_public_key() is None
    provisioned.get_status()
    assert not (tmp_path / EXTENSION_KEY_FILE).exists()
    st = provisioned.get_status()
    assert st["extension_spki_der"] == b""
    assert st["extension_key_fingerprint"] == ""


def test_sign_extension_refuses_before_provisioning(backend, tmp_path):
    with pytest.raises(RuntimeError):
        backend.sign_extension(_statement())
    assert not (tmp_path / EXTENSION_KEY_FILE).exists()


def test_extension_key_lives_in_its_own_file(provisioned, tmp_path):
    before = (tmp_path / "device-id.sealed").read_bytes()
    provisioned.sign_extension(_statement())
    assert (tmp_path / EXTENSION_KEY_FILE).exists()
    # MUTATION: persist into device-id.sealed -> the device blob changes.
    assert (tmp_path / "device-id.sealed").read_bytes() == before
    assert EXTENSION_KEY_FILE != "device-id.sealed"


def test_extension_key_is_not_the_device_key(provisioned):
    provisioned.sign_extension(_statement())
    ext_spki, _ = provisioned.extension_public_key()
    device_spki = serialization.load_pem_public_key(
        provisioned.get_public_key_pem()
    ).public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    # MUTATION: sign with self._private_key -> the SPKIs match.
    assert ext_spki != device_spki


def test_signature_covers_prefix_and_statement_only(provisioned):
    stmt = _statement()
    sig = provisioned.sign_extension(stmt)
    spki, _ = provisioned.extension_public_key()
    # MUTATION: sign the bare statement -> the first assertion fails.
    assert _verify(spki, sig, EXTENSION_STATEMENT_PREFIX + stmt)
    assert not _verify(spki, sig, stmt)


def test_signature_is_not_valid_under_the_device_key(provisioned):
    stmt = _statement()
    sig = provisioned.sign_extension(stmt)
    device_spki = serialization.load_pem_public_key(
        provisioned.get_public_key_pem()
    ).public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    assert not _verify(device_spki, sig, EXTENSION_STATEMENT_PREFIX + stmt)
    assert not _verify(device_spki, sig, stmt)


def test_backend_refuses_a_non_extension_statement_itself(provisioned):
    # Defence in depth: even a caller that skips the gRPC handler cannot get
    # the extension key to sign a release statement.
    with pytest.raises(StatementRefused):
        provisioned.sign_extension(_statement(kind="release", keyUsage="release"))


def test_key_persists_across_a_restart(provisioned, tmp_path):
    provisioned.sign_extension(_statement())
    spki1, fp1 = provisioned.extension_public_key()
    reborn = MockBackend(storage_root=tmp_path)
    spki2, fp2 = reborn.extension_public_key()
    assert spki1 == spki2 and fp1 == fp2
    sig = reborn.sign_extension(_statement(version="0.2.0"))
    assert _verify(spki1, sig, EXTENSION_STATEMENT_PREFIX + _statement(version="0.2.0"))


def test_fingerprint_is_sha256_over_the_spki_der(provisioned):
    provisioned.sign_extension(_statement())
    spki, fp = provisioned.extension_public_key()
    assert fp == spki_fingerprint(spki)
    assert fp.startswith("sha256:") and len(fp) == len("sha256:") + 64


def test_key_file_is_written_once(provisioned, tmp_path):
    provisioned.sign_extension(_statement())
    first = (tmp_path / EXTENSION_KEY_FILE).read_bytes()
    provisioned.sign_extension(_statement(version="0.2.0"))
    assert (tmp_path / EXTENSION_KEY_FILE).read_bytes() == first


# ─── the gRPC handler ────────────────────────────────────────────────────


def test_rpc_unprovisioned_is_failed_precondition(servicer, tmp_path):
    ctx = MagicMock()
    servicer.SignExtensionManifest(
        pb.SignExtensionManifestRequest(statement=_statement()), ctx
    )
    ctx.set_code.assert_called_once_with(grpc.StatusCode.FAILED_PRECONDITION)
    assert not (tmp_path / EXTENSION_KEY_FILE).exists()


@pytest.mark.parametrize(
    "statement",
    [
        _statement(kind="release"),
        _statement(keyUsage="release"),
        _statement(kind=None),
        b"garbage",
    ],
)
def test_rpc_refuses_non_extension_statements_as_invalid_argument(
    provisioned, servicer, statement
):
    ctx = MagicMock()
    resp = servicer.SignExtensionManifest(
        pb.SignExtensionManifestRequest(statement=statement), ctx
    )
    ctx.set_code.assert_called_once_with(grpc.StatusCode.INVALID_ARGUMENT)
    assert resp.signature == b""


def test_rpc_signs_and_returns_the_public_half(provisioned, servicer):
    stmt = _statement()
    ctx = MagicMock()
    resp = servicer.SignExtensionManifest(
        pb.SignExtensionManifestRequest(statement=stmt), ctx
    )
    ctx.set_code.assert_not_called()
    assert resp.algorithm == "ECDSA-P256-SHA256"
    assert resp.key_usage == "extension"
    assert _verify(resp.extension_spki_der, resp.signature, EXTENSION_STATEMENT_PREFIX + stmt)


def test_get_status_reports_the_extension_key_after_first_sign(provisioned, servicer):
    before = servicer.GetStatus(pb.GetStatusRequest(), MagicMock())
    assert before.extension_spki_der == b""
    assert before.extension_key_fingerprint == ""
    servicer.SignExtensionManifest(
        pb.SignExtensionManifestRequest(statement=_statement()), MagicMock()
    )
    after = servicer.GetStatus(pb.GetStatusRequest(), MagicMock())
    assert after.extension_key_fingerprint == spki_fingerprint(after.extension_spki_der)
    assert len(after.extension_spki_der) > 0


def test_rpc_on_a_backend_without_an_extension_key_fails_closed(tmp_path, monkeypatch):
    # The real (TPM) backend has no extension key yet (IDX-002 scaffold). It
    # must refuse with FAILED_PRECONDITION -> the promote route's 503, never
    # fall back to the device key.
    fake = types.ModuleType("tpm2_pytss")
    fake.ESAPI = object  # never entered: sign_extension raises first
    monkeypatch.setitem(sys.modules, "tpm2_pytss", fake)
    from backends.real import RealBackend

    real = RealBackend(storage_root=tmp_path)
    real._storage.write_provisioned({"device_id": "x", "pcrs": [0, 2, 4, 7]})
    assert real.is_provisioned()
    with pytest.raises(NotImplementedError):
        real.sign_extension(_statement())
    assert real.extension_public_key() is None

    ctx = MagicMock()
    resp = DeviceIdentityServicer(real).SignExtensionManifest(
        pb.SignExtensionManifestRequest(statement=_statement()), ctx
    )
    ctx.set_code.assert_called_once_with(grpc.StatusCode.FAILED_PRECONDITION)
    assert resp.signature == b""


# ─── the proto surface ───────────────────────────────────────────────────


def test_proto_rpc_set_is_pinned():
    svc = pb.DESCRIPTOR.services_by_name["DeviceIdentityService"]
    assert sorted(m.name for m in svc.methods) == sorted(
        ["Sign", "GetCert", "GetStatus", "Reseal", "SignExtensionManifest"]
    )


def test_no_proto_field_carries_private_key_material():
    import re

    bad = re.compile(r"priv|private_key|_key_pem$")
    for msg in pb.DESCRIPTOR.message_types_by_name.values():
        for field in msg.fields:
            assert not bad.search(field.name), f"{msg.name}.{field.name}"


def test_dockerfile_copies_every_top_level_module():
    # The image COPYs service files one by one. A new top-level module that
    # is not COPY'd imports fine in pytest and crashes the container at boot.
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
    for module in sorted(p.name for p in root.glob("*.py")):
        assert f"services/device-identity-svc/{module} /app/{module}" in dockerfile, module
