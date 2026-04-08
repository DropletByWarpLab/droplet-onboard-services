"""Tests for the GPU priority queue scheduler."""

from __future__ import annotations

import asyncio

import pytest

from scheduler import InferenceScheduler, Priority, QueueFullError


@pytest.mark.asyncio
async def test_basic_enqueue_and_dequeue():
    """A single enqueued request should be dispatched immediately."""
    scheduler = InferenceScheduler(max_concurrent=1)
    await scheduler.start()

    try:
        future = await scheduler.enqueue(Priority.USER, {"prompt": "hello"})
        result = await asyncio.wait_for(future, timeout=1.0)
        assert result == {"prompt": "hello"}
        assert scheduler.active_requests == 1
    finally:
        await scheduler.stop()


@pytest.mark.asyncio
async def test_priority_ordering():
    """P0 (USER) should be dispatched before P5 (AUTOMATION) before P10 (BACKGROUND)."""
    scheduler = InferenceScheduler(max_concurrent=1)
    await scheduler.start()

    try:
        # Fill the active slot so subsequent enqueues stay queued
        first = await scheduler.enqueue(Priority.USER, "blocker")
        await asyncio.wait_for(first, timeout=1.0)

        # Enqueue in reverse priority order
        f_background = await scheduler.enqueue(Priority.BACKGROUND, "bg")
        f_automation = await scheduler.enqueue(Priority.AUTOMATION, "auto")
        f_user = await scheduler.enqueue(Priority.USER, "user")

        dispatched_order = []

        # Release the blocker and collect results in dispatch order
        await scheduler.release()
        result = await asyncio.wait_for(f_user, timeout=1.0)
        dispatched_order.append(result)
        await scheduler.release()

        result = await asyncio.wait_for(f_automation, timeout=1.0)
        dispatched_order.append(result)
        await scheduler.release()

        result = await asyncio.wait_for(f_background, timeout=1.0)
        dispatched_order.append(result)

        assert dispatched_order == ["user", "auto", "bg"]
    finally:
        await scheduler.stop()


@pytest.mark.asyncio
async def test_concurrency_limit():
    """Only max_concurrent requests should be active at once."""
    scheduler = InferenceScheduler(max_concurrent=2)
    await scheduler.start()

    try:
        f1 = await scheduler.enqueue(Priority.USER, "req1")
        f2 = await scheduler.enqueue(Priority.USER, "req2")
        await asyncio.wait_for(f1, timeout=1.0)
        await asyncio.wait_for(f2, timeout=1.0)

        assert scheduler.active_requests == 2

        # Third request should remain queued
        f3 = await scheduler.enqueue(Priority.USER, "req3")
        # Give the processor a chance to run
        await asyncio.sleep(0.05)
        assert not f3.done()
        assert scheduler.active_requests == 2

        # Release one slot -- f3 should now dispatch
        await scheduler.release()
        result = await asyncio.wait_for(f3, timeout=1.0)
        assert result == "req3"
        assert scheduler.active_requests == 2
    finally:
        await scheduler.stop()


@pytest.mark.asyncio
async def test_reject_threshold():
    """Priority >= AUTOMATION should be rejected when queue depth >= reject_threshold."""
    scheduler = InferenceScheduler(
        max_queue_size=20,
        reject_threshold=5,
        max_concurrent=1,
    )
    await scheduler.start()

    try:
        # Fill the active slot
        first = await scheduler.enqueue(Priority.USER, "blocker")
        await asyncio.wait_for(first, timeout=1.0)

        # Queue 5 requests to hit the reject threshold
        for i in range(5):
            await scheduler.enqueue(Priority.USER, f"fill-{i}")

        assert scheduler.queue_depth == 5

        # AUTOMATION (priority 5) should be rejected
        with pytest.raises(QueueFullError) as exc_info:
            await scheduler.enqueue(Priority.AUTOMATION, "should-reject")
        assert exc_info.value.queue_depth == 5

        # BACKGROUND (priority 10) should also be rejected
        with pytest.raises(QueueFullError):
            await scheduler.enqueue(Priority.BACKGROUND, "also-rejected")

        # USER (priority 0) should still be accepted
        f = await scheduler.enqueue(Priority.USER, "still-ok")
        assert not f.done() or f.result() == "still-ok"
    finally:
        await scheduler.stop()


@pytest.mark.asyncio
async def test_queue_full():
    """All priorities should be rejected when max_queue_size is reached."""
    scheduler = InferenceScheduler(
        max_queue_size=3,
        reject_threshold=10,
        max_concurrent=1,
    )
    await scheduler.start()

    try:
        # Fill the active slot
        first = await scheduler.enqueue(Priority.USER, "blocker")
        await asyncio.wait_for(first, timeout=1.0)

        # Fill the queue to capacity
        for i in range(3):
            await scheduler.enqueue(Priority.USER, f"fill-{i}")

        assert scheduler.queue_depth == 3

        # Even USER priority should be rejected now
        with pytest.raises(QueueFullError) as exc_info:
            await scheduler.enqueue(Priority.USER, "overflow")
        assert exc_info.value.queue_depth == 3
        assert exc_info.value.retry_after == 5
    finally:
        await scheduler.stop()


@pytest.mark.asyncio
async def test_metrics():
    """Metrics should reflect scheduler state after operations."""
    scheduler = InferenceScheduler(
        max_queue_size=5,
        reject_threshold=2,
        max_concurrent=1,
    )
    await scheduler.start()

    try:
        m = scheduler.metrics()
        assert m["queue_depth"] == 0
        assert m["active_requests"] == 0
        assert m["total_enqueued"] == 0
        assert m["total_rejected"] == 0
        assert m["total_completed"] == 0
        assert m["max_queue_size"] == 5
        assert m["reject_threshold"] == 2
        assert m["max_concurrent"] == 1

        # Enqueue and dispatch one request
        f = await scheduler.enqueue(Priority.USER, "req")
        await asyncio.wait_for(f, timeout=1.0)

        m = scheduler.metrics()
        assert m["total_enqueued"] == 1
        assert m["active_requests"] == 1

        # Release
        await scheduler.release()
        m = scheduler.metrics()
        assert m["total_completed"] == 1
        assert m["active_requests"] == 0

        # Trigger a rejection
        f2 = await scheduler.enqueue(Priority.USER, "blocker")
        await asyncio.wait_for(f2, timeout=1.0)
        await scheduler.enqueue(Priority.USER, "q1")
        await scheduler.enqueue(Priority.USER, "q2")

        with pytest.raises(QueueFullError):
            await scheduler.enqueue(Priority.AUTOMATION, "rejected")

        m = scheduler.metrics()
        assert m["total_rejected"] == 1
        assert m["total_enqueued"] == 4  # blocker + q1 + q2 + initial req
    finally:
        await scheduler.stop()


@pytest.mark.asyncio
async def test_fifo_within_same_priority():
    """Requests at the same priority level should be dispatched in FIFO order."""
    scheduler = InferenceScheduler(max_concurrent=1)
    await scheduler.start()

    try:
        # Fill the active slot
        blocker = await scheduler.enqueue(Priority.USER, "blocker")
        await asyncio.wait_for(blocker, timeout=1.0)

        # Enqueue three requests at the same priority
        f1 = await scheduler.enqueue(Priority.AUTOMATION, "first")
        f2 = await scheduler.enqueue(Priority.AUTOMATION, "second")
        f3 = await scheduler.enqueue(Priority.AUTOMATION, "third")

        dispatched_order = []

        # Release slots one at a time and collect dispatch order
        await scheduler.release()
        result = await asyncio.wait_for(f1, timeout=1.0)
        dispatched_order.append(result)

        await scheduler.release()
        result = await asyncio.wait_for(f2, timeout=1.0)
        dispatched_order.append(result)

        await scheduler.release()
        result = await asyncio.wait_for(f3, timeout=1.0)
        dispatched_order.append(result)

        assert dispatched_order == ["first", "second", "third"]
    finally:
        await scheduler.stop()


@pytest.mark.asyncio
async def test_release_frees_slot_and_dispatches_next():
    """Calling release() should free a slot and dispatch the next queued request."""
    scheduler = InferenceScheduler(max_concurrent=1)
    await scheduler.start()

    try:
        # Fill the active slot
        f1 = await scheduler.enqueue(Priority.USER, "active")
        await asyncio.wait_for(f1, timeout=1.0)
        assert scheduler.active_requests == 1

        # Enqueue a second request -- it should stay queued
        f2 = await scheduler.enqueue(Priority.USER, "waiting")
        await asyncio.sleep(0.05)
        assert not f2.done()
        assert scheduler.queue_depth == 1

        # Release the active slot
        await scheduler.release()
        result = await asyncio.wait_for(f2, timeout=1.0)
        assert result == "waiting"
        assert scheduler.active_requests == 1
        assert scheduler.queue_depth == 0
    finally:
        await scheduler.stop()
