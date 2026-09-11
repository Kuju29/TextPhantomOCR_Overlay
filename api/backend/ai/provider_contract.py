"""Stable contracts between translation orchestration and provider adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, Mapping, Protocol, runtime_checkable

CancelCheck = Callable[[], bool]

@dataclass(frozen=True, slots=True)
class SystemPromptSection:
    """One named, ordered provider-neutral system instruction block."""

    name: str
    text: str
    cacheable: bool = False

    def __post_init__(self) -> None:
        name = str(self.name or "").strip()
        if not name:
            raise ValueError("system prompt section name is required")
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "text", str(self.text or "").strip())

def _frozen_mapping(value: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return MappingProxyType(dict(value or {}))

@dataclass(frozen=True, slots=True)
class GenerationRequest:
    """Provider-neutral input for exactly one generation attempt.

    An adapter translates this object into its own native payload.  It must not
    mutate the request or silently substitute the provider/model.
    """

    provider: str
    model: str
    system_text: str
    user_parts: tuple[str, ...]
    system_sections: tuple[SystemPromptSection, ...] = ()
    api_key: str = field(default="", repr=False)
    base_url: str = ""
    image_b64: str = field(default="", repr=False)
    image_mime: str = "image/jpeg"
    thinking: str = "off"
    response_schema: Mapping[str, Any] | None = None
    unit_count: int | None = None
    expected_ids: tuple[str, ...] = ()
    model_capabilities: Mapping[str, Any] = field(default_factory=dict)
    workload: Mapping[str, Any] = field(default_factory=dict)
    cancel_check: CancelCheck | None = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        provider = self.provider.strip().lower()
        model = self.model.strip()
        if not provider:
            raise ValueError("provider is required")
        if not model:
            raise ValueError("model is required")
        if self.unit_count is not None and self.unit_count < 0:
            raise ValueError("unit_count cannot be negative")
        thinking = str(self.thinking or "off").strip().lower()
        if thinking not in {"off", "on"}:
            thinking = "off"
        object.__setattr__(self, "provider", provider)
        object.__setattr__(self, "model", model)
        object.__setattr__(self, "thinking", thinking)
        object.__setattr__(self, "workload", _frozen_mapping(self.workload))
        object.__setattr__(self, "user_parts", tuple(self.user_parts))
        object.__setattr__(self, "system_sections", tuple(self.system_sections))
        object.__setattr__(self, "expected_ids", tuple(self.expected_ids))
        object.__setattr__(
            self,
            "response_schema",
            None if self.response_schema is None else _frozen_mapping(self.response_schema),
        )
        object.__setattr__(
            self, "model_capabilities", _frozen_mapping(self.model_capabilities)
        )

@dataclass(frozen=True, slots=True)
class ModelListResult:
    """Normalized model discovery result returned by every adapter."""

    models: tuple[str, ...] = ()
    status: str = "missing"
    http_status: int = 0
    error: str = ""
    capabilities: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    # Backward-compatible enrichment. ``models`` remains the stable ID list;
    # candidates records what the provider actually proved about each ID.
    candidates: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "models", tuple(self.models))
        object.__setattr__(self, "error", str(self.error or "")[:240])
        object.__setattr__(self, "capabilities", MappingProxyType(dict(self.capabilities)))
        object.__setattr__(self, "candidates", MappingProxyType(dict(self.candidates)))

@dataclass(frozen=True, slots=True)
class ProbeRequest:
    """Credential-safe input for one provider-owned connectivity probe.

    ``model_capabilities`` comes only from the live provider/account catalogue.
    A probe may use it directly or feature-detect controls on this exact selected
    model. Model-name inference alone is never accepted as verified capability.
    """

    model: str
    api_key: str = field(default="", repr=False)
    base_url: str = ""
    timeout_sec: float = 15.0
    model_capabilities: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "model_capabilities", _frozen_mapping(self.model_capabilities))

@dataclass(frozen=True, slots=True)
class ProbeResponse:
    """Provider-neutral result after native response validation.

    ``capabilities`` contains only controls proved by this selected-model probe.
    It supplements (never replaces) authoritative catalogue metadata.
    """

    ok: bool
    http_status: int = 0
    status: str = ""
    error: str = ""
    capabilities: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "error", str(self.error or "")[:240])
        object.__setattr__(self, "capabilities", _frozen_mapping(self.capabilities))

@runtime_checkable
class ProviderAdapter(Protocol):
    """Provider-owned generation and discovery behavior."""

    def generate(self, request: GenerationRequest) -> Any:
        """Perform exactly one provider request and return its normalized result."""

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        """Discover models without changing generation state."""

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        """Perform one tiny native request and validate its success body."""

@dataclass(frozen=True, slots=True)
class ProviderSpec:
    """Immutable provider identity and routing metadata.

    Payload construction, response parsing, model quirks and retry decisions
    deliberately do not belong here; those remain inside ``adapter``.
    """

    provider_id: str
    protocol: str
    default_model: str
    default_base_url: str
    aliases: tuple[str, ...] = ()
    model_aliases: Mapping[str, str] = field(default_factory=dict)
    key_prefixes: tuple[str, ...] = ()
    default_local: bool = False
    local: bool = False
    rate_rpm: float | None = None
    rate_burst: int | None = None
    rate_rpm_min: float | None = None
    rate_rpm_max: float | None = None
    # None follows the provider locality default. A cloud provider that owns
    # an independent throttle may explicitly opt out of the shared batch gate.
    proactive_rate_gate: bool | None = None
    adapter: ProviderAdapter | None = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        provider_id = self.provider_id.strip().lower()
        protocol = self.protocol.strip()
        if not provider_id:
            raise ValueError("provider_id is required")
        if not protocol:
            raise ValueError("protocol is required")
        aliases = tuple(alias.strip().lower() for alias in self.aliases)
        if any(not alias for alias in aliases):
            raise ValueError("provider aliases cannot be empty")
        if provider_id in aliases:
            raise ValueError("provider_id must not also be an alias")
        if len(set(aliases)) != len(aliases):
            raise ValueError("provider aliases must be unique")
        if self.rate_rpm is not None and self.rate_rpm <= 0:
            raise ValueError("rate_rpm must be positive")
        if self.rate_burst is not None and self.rate_burst <= 0:
            raise ValueError("rate_burst must be positive")
        if self.rate_rpm_min is not None and self.rate_rpm_min <= 0:
            raise ValueError("rate_rpm_min must be positive")
        if self.rate_rpm_max is not None and self.rate_rpm_max <= 0:
            raise ValueError("rate_rpm_max must be positive")
        if (
            self.rate_rpm_min is not None
            and self.rate_rpm_max is not None
            and self.rate_rpm_min > self.rate_rpm_max
        ):
            raise ValueError("rate_rpm_min cannot exceed rate_rpm_max")
        object.__setattr__(self, "provider_id", provider_id)
        object.__setattr__(self, "protocol", protocol)
        object.__setattr__(self, "aliases", aliases)
        object.__setattr__(self, "model_aliases", _frozen_mapping(self.model_aliases))
        object.__setattr__(self, "key_prefixes", tuple(self.key_prefixes))

    @property
    def rate_metadata(self) -> Mapping[str, float | int]:
        values = {
            "rpm": self.rate_rpm,
            "burst": self.rate_burst,
            "rpm_min": self.rate_rpm_min,
            "rpm_max": self.rate_rpm_max,
        }
        return MappingProxyType({key: value for key, value in values.items() if value is not None})

    @property
    def uses_proactive_rate_gate(self) -> bool:
        if self.proactive_rate_gate is not None:
            return bool(self.proactive_rate_gate)
        return not self.local

__all__ = [
    "CancelCheck",
    "GenerationRequest",
    "ModelListResult",
    "ProbeRequest",
    "ProbeResponse",
    "ProviderAdapter",
    "ProviderSpec",
    "SystemPromptSection",
]
