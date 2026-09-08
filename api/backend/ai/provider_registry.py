"""Explicit provider registration without provider-name conditionals."""

from __future__ import annotations

from collections.abc import Iterator

from backend.ai.provider_contract import ProviderSpec

def normalize_provider_name(value: str) -> str:
    return str(value or "").strip().lower()

class ProviderRegistry:
    """Own canonical providers and their globally unique aliases."""

    def __init__(self) -> None:
        self._providers: dict[str, ProviderSpec] = {}
        self._names: dict[str, str] = {}

    def register(self, spec: ProviderSpec) -> ProviderSpec:
        """Register one explicit spec or reject every ambiguous name."""

        names = (spec.provider_id, *spec.aliases)
        collisions = [name for name in names if name in self._names]
        if collisions:
            joined = ", ".join(sorted(collisions))
            raise ValueError(f"provider name already registered: {joined}")
        self._providers[spec.provider_id] = spec
        for name in names:
            self._names[name] = spec.provider_id
        return spec

    def resolve_id(self, name: str) -> str | None:
        """Return a canonical id for a provider id or alias."""

        return self._names.get(normalize_provider_name(name))

    def get(self, name: str) -> ProviderSpec | None:
        provider_id = self.resolve_id(name)
        return self._providers.get(provider_id) if provider_id is not None else None

    def require(self, name: str) -> ProviderSpec:
        spec = self.get(name)
        if spec is None:
            raise KeyError(f"provider is not registered: {normalize_provider_name(name)}")
        return spec

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and self.resolve_id(name) is not None

    def __iter__(self) -> Iterator[ProviderSpec]:
        return iter(self._providers.values())

    def __len__(self) -> int:
        return len(self._providers)

# Provider modules register themselves here during composition.  This module
# imports no concrete adapters, which keeps dependencies one-way and prevents
# provider-module import cycles.
provider_registry = ProviderRegistry()

def register_provider(spec: ProviderSpec) -> ProviderSpec:
    return provider_registry.register(spec)

__all__ = [
    "ProviderRegistry",
    "normalize_provider_name",
    "provider_registry",
    "register_provider",
]
