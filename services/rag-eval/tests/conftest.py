"""Pytest path setup for services/rag-eval.

Adds the service dir to sys.path so `import run_state` resolves without
installing the heavy RAGAS/torch dependency stack — run_state is pure stdlib.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))
