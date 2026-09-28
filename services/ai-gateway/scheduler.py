"""GPU Priority Queue Scheduler.

Implements priority-based request scheduling per design doc Section 14:
- Priority levels: USER=0, AUTOMATION=5, BACKGROUND=10
- Rejects low-priority (>=5) when queue has >=5 pending requests
- Concurrency limit: max active inferences (default 1, single-stream)
- WARP-3306: a USER request that finds every slot busy preempts one slot held
  by a request that opted in (``preempt`` event, sent only by the background
  agent-run worker). The holder's handler sees the event, abandons its model
  call and answers ``preempted_for_chat``; its release lets the chat in.
"""

from __future__ import annotations

import asyncio
import heapq
import logging
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any

logger = logging.getLogger(__name__)


class Priority(IntEnum):
    """Request priority levels."""
    USER = 0
    AUTOMATION = 5
    BACKGROUND = 10


# Thresholds
DEFAULT_MAX_QUEUE_SIZE = 20
DEFAULT_REJECT_THRESHOLD = 5  # reject priority >= 5 when this many pending
DEFAULT_MAX_CONCURRENT = 1    # single-stream inference on the appliance


@dataclass
class QueuedRequest:
    """Priority queue entry. Lower priority value = higher importance."""
    priority: int
    timestamp: float
    future: asyncio.Future = field(repr=False)
    request: Any = field(repr=False)
    _seq: int = field(default=0)  # tiebreaker for same-priority FIFO ordering
    # WARP-3306 — set by the scheduler to ask this request's holder to give
    # the slot up for chat. None = never preempted (the default for everyone
    # but the agent-run worker).
    preempt: asyncio.Event | None = field(default=None, repr=False)

    def __lt__(self, other: QueuedRequest) -> bool:
        if self.priority != other.priority:
            return self.priority < other.priority
        return self._seq < other._seq

    def __le__(self, other: QueuedRequest) -> bool:
        return self == other or self < other

    def __gt__(self, other: QueuedRequest) -> bool:
        return not self <= other

    def __ge__(self, other: QueuedRequest) -> bool:
        return not self < other

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, QueuedRequest):
            return NotImplemented
        return self.priority == other.priority and self._seq == other._seq


class InferenceScheduler:
    """Priority-based inference request scheduler."""

    def __init__(
        self,
        max_queue_size: int = DEFAULT_MAX_QUEUE_SIZE,
        reject_threshold: int = DEFAULT_REJECT_THRESHOLD,
        max_concurrent: int = DEFAULT_MAX_CONCURRENT,
    ):
        self._queue: list[QueuedRequest] = []
        self._max_queue_size = max_queue_size
        self._reject_threshold = reject_threshold
        self._max_concurrent = max_concurrent
        self._active_count = 0
        self._seq_counter = 0
        self._lock = asyncio.Lock()
        self._process_event = asyncio.Event()
        self._processor_task: asyncio.Task | None = None
        # WARP-3306 — preempt events of the slots currently held by
        # preemptible requests. An event leaves the set when it fires or when
        # its holder releases, so one holder is never asked twice.
        self._preemptible: set[asyncio.Event] = set()

        # Metrics
        self.total_enqueued = 0
        self.total_rejected = 0
        self.total_completed = 0
        self.total_preempted = 0

    async def start(self):
        """Start the background queue processor."""
        self._processor_task = asyncio.create_task(self._process_loop())
        logger.info(
            "Scheduler started (max_queue=%d, reject_threshold=%d, max_concurrent=%d)",
            self._max_queue_size, self._reject_threshold, self._max_concurrent,
        )

    async def stop(self):
        """Stop the scheduler and cancel pending requests."""
        if self._processor_task:
            self._processor_task.cancel()
            try:
                await self._processor_task
            except asyncio.CancelledError:
                pass

        # Cancel all pending futures
        async with self._lock:
            for item in self._queue:
                if not item.future.done():
                    item.future.cancel()
            self._queue.clear()

    async def enqueue(
        self, priority: int, request: Any, preempt: asyncio.Event | None = None,
    ) -> asyncio.Future:
        """Add a request to the priority queue.

        Args:
            priority: 0 (user), 5 (automation), 10 (background)
            request: The chat request object
            preempt: WARP-3306 — pass an Event to make this request's slot
                preemptible by a USER request; the scheduler sets it when
                chat needs the slot. Release with ``release(preempt)``.

        Returns:
            Future that resolves when a slot is available and returns the request.
            The caller's task (inbound middleware) already has the request-id
            contextvar set, and that same task runs the provider call after
            `await future`, so the scheduler doesn't need to thread the id.

        Raises:
            QueueFullError: If the queue is full or low-priority is rejected.
        """
        async with self._lock:
            queue_depth = len(self._queue)

            # Reject if queue is full
            if queue_depth >= self._max_queue_size:
                self.total_rejected += 1
                raise QueueFullError(
                    f"Queue full ({queue_depth}/{self._max_queue_size})",
                    queue_depth=queue_depth,
                    retry_after=5,
                )

            # Reject low-priority requests when queue is congested
            if priority >= Priority.AUTOMATION and queue_depth >= self._reject_threshold:
                self.total_rejected += 1
                raise QueueFullError(
                    f"Low-priority request rejected (queue depth {queue_depth} >= {self._reject_threshold})",
                    queue_depth=queue_depth,
                    retry_after=10,
                )

            future: asyncio.Future = asyncio.get_running_loop().create_future()
            self._seq_counter += 1
            item = QueuedRequest(
                priority=priority,
                timestamp=time.monotonic(),
                future=future,
                request=request,
                _seq=self._seq_counter,
                preempt=preempt,
            )

            heapq.heappush(self._queue, item)

            # WARP-3306 — chat must not wait out a background model call.
            if (
                priority == Priority.USER
                and self._active_count >= self._max_concurrent
                and self._preemptible
            ):
                victim = self._preemptible.pop()
                victim.set()
                self.total_preempted += 1
                logger.info("Preempting a background request for a user request")

            self.total_enqueued += 1
            logger.debug(
                "Enqueued request (priority=%d, queue_depth=%d)",
                priority, len(self._queue),
            )

        # Signal the processor
        self._process_event.set()
        return future

    async def release(self, preempt: asyncio.Event | None = None):
        """Signal that an active inference has completed.

        ``preempt`` is the event the request was enqueued with, if any.
        """
        async with self._lock:
            if preempt is not None:
                self._preemptible.discard(preempt)
            self._active_count = max(0, self._active_count - 1)
            self.total_completed += 1
        self._process_event.set()

    async def _process_loop(self):
        """Background loop that dispatches queued requests when slots are available."""
        while True:
            await self._process_event.wait()
            self._process_event.clear()

            async with self._lock:
                while self._queue and self._active_count < self._max_concurrent:
                    item = heapq.heappop(self._queue)
                    if not item.future.done():
                        item.future.set_result(item.request)
                        self._active_count += 1
                        if item.preempt is not None:
                            self._preemptible.add(item.preempt)

    @property
    def queue_depth(self) -> int:
        return len(self._queue)

    @property
    def active_requests(self) -> int:
        return self._active_count

    def metrics(self) -> dict:
        """Return current scheduler metrics."""
        return {
            "queue_depth": self.queue_depth,
            "active_requests": self.active_requests,
            "total_enqueued": self.total_enqueued,
            "total_rejected": self.total_rejected,
            "total_completed": self.total_completed,
            "total_preempted": self.total_preempted,
            "max_queue_size": self._max_queue_size,
            "reject_threshold": self._reject_threshold,
            "max_concurrent": self._max_concurrent,
        }


class QueueFullError(Exception):
    """Raised when the scheduler rejects a request."""

    def __init__(self, message: str, queue_depth: int, retry_after: int):
        super().__init__(message)
        self.queue_depth = queue_depth
        self.retry_after = retry_after
