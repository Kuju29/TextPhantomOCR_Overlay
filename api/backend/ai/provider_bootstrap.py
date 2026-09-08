"""Composition boundary shared by server and standalone AI entry points."""

from __future__ import annotations

from backend.ai.provider_registry import ProviderRegistry, provider_registry
from backend.ai.providers import compose_providers


def ensure_provider_registry(
    registry: ProviderRegistry = provider_registry,
) -> ProviderRegistry:
    """Idempotently compose every concrete provider into ``registry``."""
    return compose_providers(registry)


__all__ = ["ensure_provider_registry"]
