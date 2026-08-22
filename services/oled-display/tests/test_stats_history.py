"""The panel records THREE metric histories, not one.

`sparks_cpu` has always been fed; MEM and DISK reached the glass as bare
percentages, which cannot answer the question you walk to the rack holding -
is this climbing, or has it been sitting there all week? The wide layout's
tall density tier draws all three, so all three have to be recorded on the
same cadence.

The trap these tests pin: one `try` around all three appends would let a
single unparseable sample stall the other two, and the histories would drift
out of step with each other while still looking plausible on the glass.
"""

from __future__ import annotations

from display import TFTDisplay

SERIES = ("sparks_cpu", "sparks_mem", "sparks_disk")


def test_all_three_series_start_empty(sim_display: TFTDisplay):
    """Empty, not zero-filled: a cold panel must draw "no history yet" rather
    than a flat line at 0% it never measured (WARP-1643)."""
    for key in SERIES:
        assert sim_display._v3[key] == []


def test_a_stats_frame_records_all_three(sim_display: TFTDisplay):
    sim_display.update_stats({"cpu": 12, "mem": 44, "disk": 71})
    assert sim_display._v3["sparks_cpu"] == [12.0]
    assert sim_display._v3["sparks_mem"] == [44.0]
    assert sim_display._v3["sparks_disk"] == [71.0]


def test_the_three_stay_in_step(sim_display: TFTDisplay):
    for i in range(5):
        sim_display.update_stats({"cpu": i, "mem": i * 2, "disk": i * 3})
    lengths = {len(sim_display._v3[k]) for k in SERIES}
    assert lengths == {5}, "the series drifted out of step with each other"


def test_one_bad_sample_does_not_stall_the_others(sim_display: TFTDisplay):
    """A single unparseable reading must cost one series one sample, not stop
    the other two dead - which is what a shared try/except would have done."""
    sim_display.update_stats({"cpu": 10, "mem": 20, "disk": 30})
    sim_display._v3["mem"] = "not a number"
    sim_display.update_stats({"cpu": 11, "disk": 31})
    assert sim_display._v3["sparks_cpu"] == [10.0, 11.0]
    assert sim_display._v3["sparks_disk"] == [30.0, 31.0]
    assert sim_display._v3["sparks_mem"] == [20.0]


def test_every_series_is_capped_at_the_window(sim_display: TFTDisplay):
    for i in range(sim_display._v3_spark_len + 20):
        sim_display.update_stats({"cpu": i, "mem": i, "disk": i})
    for key in SERIES:
        assert len(sim_display._v3[key]) == sim_display._v3_spark_len
        # The window keeps the NEWEST samples: a trend that drops the recent
        # end is worse than no trend at all.
        assert sim_display._v3[key][-1] == float(
            sim_display._v3_spark_len + 19)


def test_dev_seeding_fills_every_series(sim_display: TFTDisplay):
    sim_display._v3.update({"mem": 61, "disk": 44})
    sim_display.seed_cpu_history(34)
    for key in SERIES:
        assert len(sim_display._v3[key]) == sim_display._v3_spark_len


def test_dev_seeding_skips_a_metric_the_box_has_not_read(
        sim_display: TFTDisplay):
    sim_display._v3.update({"mem": None, "disk": 44})
    sim_display.seed_cpu_history(34)
    assert sim_display._v3["sparks_mem"] == []
    assert len(sim_display._v3["sparks_disk"]) == sim_display._v3_spark_len
