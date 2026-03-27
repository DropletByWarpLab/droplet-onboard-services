"""Per-model settings (context window, parameters)."""

# Static config for known models — supplements dynamic discovery
MODEL_DEFAULTS = {
    "claude-sonnet-4-20250514": {"context_window": 200000, "max_tokens": 8192},
    "claude-3-5-sonnet-20241022": {"context_window": 200000, "max_tokens": 8192},
    "claude-3-5-haiku-20241022": {"context_window": 200000, "max_tokens": 8192},
    "gpt-4o": {"context_window": 128000, "max_tokens": 4096},
    "gpt-4o-mini": {"context_window": 128000, "max_tokens": 16384},
    "gpt-4-turbo": {"context_window": 128000, "max_tokens": 4096},
}


def get_model_defaults(model_id: str) -> dict:
    """Get default settings for a known model."""
    return MODEL_DEFAULTS.get(model_id, {})
