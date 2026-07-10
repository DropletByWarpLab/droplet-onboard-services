"""IDX-002 — device-identity backend selection guard.

The 'real' (tpm2-pytss) backend is an unfinished scaffold whose crypto
methods return PLACEHOLDER bytes, so selecting it in production yields a
cryptographically void device identity. ``make_backend`` must fail closed
on it unless the operator explicitly opts into the scaffold with
``DROPLET_TPM_ALLOW_SCAFFOLD``. The auto-selected default path ('mock')
must always start cleanly — that is what a legitimately TPM-equipped host
provisions against until the tss2 wiring lands.
"""
import pytest

from backends import make_backend


@pytest.mark.parametrize("optin", [None, "", "0", "false", "no", "off"])
def test_real_without_optin_fails_closed(monkeypatch, tmp_path, optin):
    """Genuinely-misconfigured path: real backend, no knowing opt-in."""
    if optin is None:
        monkeypatch.delenv("DROPLET_TPM_ALLOW_SCAFFOLD", raising=False)
    else:
        monkeypatch.setenv("DROPLET_TPM_ALLOW_SCAFFOLD", optin)
    with pytest.raises(RuntimeError, match="scaffold"):
        make_backend("real", storage_root=tmp_path)


@pytest.mark.parametrize("optin", ["1", "true", "TRUE", "yes", "on"])
def test_real_with_optin_passes_guard(monkeypatch, tmp_path, optin):
    """Knowing opt-in must get PAST the guard and construct RealBackend.

    RealBackend is stubbed so the test does not need tpm2-pytss / a TPM;
    the assertion is that the guard did not block construction.
    """
    monkeypatch.setenv("DROPLET_TPM_ALLOW_SCAFFOLD", optin)

    class _StubReal:
        name = "real"

        def __init__(self, *, storage_root):
            self.storage_root = storage_root

    monkeypatch.setattr("backends.real.RealBackend", _StubReal)
    backend = make_backend("real", storage_root=tmp_path)
    assert backend.name == "real"


def test_mock_always_selectable(monkeypatch, tmp_path):
    """The default / auto-selected provisioning path starts cleanly,
    regardless of whether the scaffold opt-in is present."""
    monkeypatch.delenv("DROPLET_TPM_ALLOW_SCAFFOLD", raising=False)
    backend = make_backend("mock", storage_root=tmp_path)
    assert backend.name == "mock"


def test_unknown_backend_rejected(tmp_path):
    with pytest.raises(ValueError, match="Unknown DROPLET_TPM_BACKEND"):
        make_backend("bogus", storage_root=tmp_path)
