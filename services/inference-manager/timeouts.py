"""Named httpx.Timeout objects for the four call shapes inference-manager makes.

The previous flat ``timeout=600.0`` meant a hung Ollama held the connection pool
for 10 minutes regardless of the operation. These differentiated timeouts give
each call shape an SLA matched to its real-world expected duration.
"""

from __future__ import annotations

import httpx

# Health probe — must be very fast or we interpret as down.
TIMEOUT_HEALTH = httpx.Timeout(connect=2.0, read=3.0, write=2.0, pool=1.0)

# Management endpoints (/api/tags, /api/ps, etc.) — fast.
TIMEOUT_MGMT = httpx.Timeout(connect=3.0, read=10.0, write=5.0, pool=2.0)

# Steady-state inference proxy — cold loads gate via 503+Retry-After, so
# the read leg only covers warm inference.
TIMEOUT_PROXY = httpx.Timeout(connect=3.0, read=120.0, write=5.0, pool=5.0)

# Model pulls — multi-GB download, no read cap.
TIMEOUT_PULL = httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0)
