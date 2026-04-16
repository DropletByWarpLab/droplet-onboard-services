"""WARP-41: verify the routing-side safe-apply timeout defaults are aligned
with the orchestrator's 60s confirmation token TTL.
"""

from __future__ import annotations

import inspect

from schemas import ApplyConfigRequest


def test_apply_config_default_timeout_is_60():
    """Ensures a token can never outlive the router's rollback window."""
    req = ApplyConfigRequest(configs=["network"])
    assert req.timeout == 60


def test_apply_config_timeout_bounds_still_enforced():
    """Reasonable ceilings keep a stuck apply from hanging forever."""
    import pytest

    with pytest.raises(Exception):
        ApplyConfigRequest(configs=["network"], timeout=9)  # below ge=10
    with pytest.raises(Exception):
        ApplyConfigRequest(configs=["network"], timeout=121)  # above le=120


def test_safe_apply_sdk_default_is_60():
    """SDK default must match schema default so hardcoded callers don't drift."""
    from droplet_openwrt_sdk import DropletRouter

    sig = inspect.signature(DropletRouter.safe_apply)
    timeout_param = sig.parameters["timeout"]
    assert timeout_param.default == 60


def test_no_stale_timeout_30_in_main():
    """Guard: ensure main.py doesn't regress to hardcoded timeout=30."""
    import main

    src = inspect.getsource(main)
    # There should be zero occurrences of literal `timeout=30` in the router
    # call sites. `timeout=30` can appear in SDK docstrings — but not in main.
    assert "timeout=30" not in src, (
        "main.py still calls safe_apply(timeout=30); align with WARP-41 (60s)"
    )
