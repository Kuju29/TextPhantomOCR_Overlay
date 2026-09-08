"""Select translation output from capability evidence, before generation."""

from __future__ import annotations

from typing import Any, Final

from dataclasses import dataclass

STRICT_JSON: Final[str] = "strict_json"
ID_MARKERS: Final[str] = "id_markers"
SCHEMA_OBJECT: Final[str] = "json_schema_object_v1"
COMPACT_MARKERS: Final[str] = "compact_markers_v1"

@dataclass(frozen=True)
class OutputCapability:
    requested_contract: str
    selected_contract: str
    native_schema: bool
    reason: str

def select_output_capability(
    provider: str, model: str, base_url: str, *, requested_contract: str = STRICT_JSON,
    model_capabilities: dict[str, Any] | None = None,
) -> OutputCapability:
    """Keep the existing provider defaults for callers without a planned contract."""
    del base_url
    provider_id = str(provider or "").strip().lower()
    model_id = str(model or "").strip().lower()
    caps = model_capabilities if isinstance(model_capabilities, dict) else {}
    structured = caps.get("structured_output")
    if isinstance(structured, dict) and structured.get("supported") is True:
        return OutputCapability(requested_contract, SCHEMA_OBJECT, True,
                                "model_catalogue_confirms_json_schema")
    if isinstance(structured, dict) and structured.get("supported") is False:
        return OutputCapability(requested_contract, COMPACT_MARKERS, False,
                                "model_catalogue_rejects_json_schema")
    if provider_id == "ollama":
        return OutputCapability(requested_contract, SCHEMA_OBJECT, True,
                                "ollama_native_format_schema")
    if provider_id == "openai" and (
        model_id in {"gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-5"}
        or model_id.startswith(("gpt-4.1-", "gpt-5-", "gpt-5."))
    ):
        return OutputCapability(requested_contract, SCHEMA_OBJECT, True,
                                "openai_model_supports_json_schema")
    if provider_id == "gemini" and model_id in {
        "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
        "gemini-3-flash-preview", "gemini-3.1-pro-preview",
        "gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview",
        "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash",
    }:
        return OutputCapability(requested_contract, SCHEMA_OBJECT, True,
                                "gemini_model_supports_json_schema")
    return OutputCapability(requested_contract, COMPACT_MARKERS, False,
                            "structured_output_unknown")


class OutputCapabilityChanged(ValueError):
    code = "ai_output_capability_changed"
    requestDispatched = False
    providerAttempts = 0
    generationAttempts = 0


def select_planned_output_capability(provider, model, base_url, *, model_capabilities=None, planned_contract=""):
    """Never silently change a contract after the client already packed its units.

    Markers require no native-schema capability. JSON still needs affirmative
    evidence; fresh server negative metadata must not be overridden by a client.
    Legacy/standalone callers with no plan keep the existing auto selection.
    """
    if planned_contract not in ("", SCHEMA_OBJECT, COMPACT_MARKERS):
        raise ValueError("Invalid planned translation output contract")
    selected = select_output_capability(provider, model, base_url, model_capabilities=model_capabilities)
    if planned_contract == COMPACT_MARKERS:
        return OutputCapability(COMPACT_MARKERS, COMPACT_MARKERS, False, "client_planned_compact_records")
    if planned_contract == SCHEMA_OBJECT and not selected.native_schema:
        raise OutputCapabilityChanged("Model capabilities no longer support the planned JSON schema; refresh model capabilities before translating")
    return selected
