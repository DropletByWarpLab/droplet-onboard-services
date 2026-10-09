"""safe_apply must not confirm a change before the router has actually
reconfigured (2026-10-09 lab incident: the first bridge-vlan on an RB5009
turned on VLAN filtering; the probe answered over the old link, the change was
confirmed, and the router's rollback never fired)."""
from __future__ import annotations

from unittest.mock import MagicMock, call, patch

import pytest

import droplet_openwrt_sdk as sdk
from droplet_openwrt_sdk import ConnectionLost, DropletRouter


def _router() -> DropletRouter:
    r = DropletRouter.__new__(DropletRouter)
    r.uci = MagicMock()
    r.system = MagicMock()
    return r


def test_defaults_wait_and_probe_more_than_once():
    assert sdk.SAFE_APPLY_SETTLE_S >= 3
    assert sdk.SAFE_APPLY_PROBES >= 2


def test_each_probe_waits_for_the_router_to_settle_then_confirms():
    r = _router()
    with patch.object(sdk.time, "sleep") as sleep:
        with r.safe_apply(timeout=60, settle=5, probes=2):
            r.uci.commit("network")
    r.uci.apply.assert_called_once_with(timeout=60, rollback=True)
    assert sleep.call_args_list == [call(5), call(5)]
    assert r.system.board_info.call_count == 2
    r.uci.confirm.assert_called_once()


def test_connectivity_lost_after_settle_raises_and_never_confirms():
    r = _router()
    r.system.board_info.side_effect = [{"hostname": "ok"}, ConnectionLost("bridge cut us off")]
    with patch.object(sdk.time, "sleep"):
        with pytest.raises(ConnectionLost):
            with r.safe_apply(timeout=60, settle=5, probes=2):
                r.uci.commit("network")
    r.uci.apply.assert_called_once_with(timeout=60, rollback=True)
    r.uci.confirm.assert_not_called()


def test_zero_settle_single_probe_is_the_old_fast_path():
    r = _router()
    with patch.object(sdk.time, "sleep") as sleep:
        with r.safe_apply(timeout=60, settle=0, probes=1):
            pass
    sleep.assert_not_called()
    assert r.system.board_info.call_count == 1
    r.uci.confirm.assert_called_once()
