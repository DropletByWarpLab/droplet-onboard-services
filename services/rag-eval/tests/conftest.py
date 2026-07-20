"""Pytest path setup for services/rag-eval.

Adds the service dir to sys.path so `import run_state` resolves without
installing the heavy RAGAS/torch dependency stack — run_state is pure stdlib.
Also adds services/ so `_shared.internal_tls` (a stdlib-only helper imported
by config.py, which server.py / runner.py / run-record persistence pull in)
resolves the same way it does in the image.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

_SERVICES_DIR = _SERVICE_DIR.parent
if str(_SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICES_DIR))
