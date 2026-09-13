"""Hugging Face Router identity, catalogue and selected-model controls."""

from __future__ import annotations

from backend.ai.generation_defaults import DEFAULT_GENERATION
from backend.ai.provider_contract import (
    GenerationRequest,
    ProbeRequest,
    ProbeResponse,
    ProviderSpec,
)
from backend.ai.providers.openai_provider_runtime import (
    OpenAIProviderAdapter,
    OpenAIProviderPolicy,
    bearer_headers,
    build_payload,
)
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.openai_chat import execute_chat_completion

PROVIDER_ID = "huggingface"
DEFAULT_MODEL = "google/gemma-2-2b-it"
DEFAULT_BASE_URL = "https://router.huggingface.co/v1"
ALIASES = ("hf", "huggingface_router", "hf_router")
FALLBACK_PRIORITY = (
    "gemma-3", "gemma-2", "llama-3.1", "llama-3", "mistral", "qwen", "glm",
)


def filter_model_items(items) -> list[str]:
    models = []
    for item in items or []:
        if not isinstance(item, dict) or not str(item.get("id") or "").strip():
            continue
        architecture = item.get("architecture")
        if isinstance(architecture, dict):
            inputs = architecture.get("input_modalities")
            outputs = architecture.get("output_modalities")
            if isinstance(inputs, list) and inputs and "text" not in {str(value).lower() for value in inputs}:
                continue
            if isinstance(outputs, list) and outputs and "text" not in {str(value).lower() for value in outputs}:
                continue
        providers = item.get("providers")
        # HF's chat catalogue exposes per-provider routing status. Do not show a
        # model whose providers are all errored/offline.
        if not isinstance(providers, list) or not any(
            isinstance(entry, dict) and str(entry.get("status") or "").lower() == "live"
            for entry in providers
        ):
            continue
        models.append(str(item["id"]).strip())
    return models


def pick_fallback_model(models) -> str:
    candidates = [(model, model.lower()) for model in models]
    for family in FALLBACK_PRIORITY:
        for original, lowered in candidates:
            if family in lowered and ("instruct" in lowered or lowered.endswith("-it") or ":" in lowered):
                return original
    for original, lowered in candidates:
        if "instruct" in lowered or lowered.endswith("-it") or ":" in lowered:
            return original
    return models[0] if models else ""


POLICY = OpenAIProviderPolicy(
    provider_id=PROVIDER_ID,
    trace_file="ai/providers/cloud_huggingface.py",
    temperature=0.7,
    output_budget_field="max_tokens",
    reasoning_policy="requires_verified_capability",
    model_filter=filter_model_items,
    catalogue_evidence="huggingface_live_text_route",
)


def _probe_effort(request: ProbeRequest, effort: str) -> ProbeResponse:
    # The HF OpenAI-compatible schema accepts reasoning_effort, but support and
    # defaults are provider/model dependent. Probe the exact selected route.
    return openai_chat_probe(
        request,
        payload_extra={"max_tokens": 256, "reasoning_effort": effort},
    )


def _accepted_reasoning_effort(request: GenerationRequest) -> str | None:
    """Select an accepted request control, not a verified behavioral effect."""
    reasoning = request.model_capabilities.get("reasoning", {})
    reasoning = reasoning if isinstance(reasoning, dict) else {}
    efforts = [
        str(value).strip().lower()
        for value in reasoning.get("supported_efforts", [])
        if isinstance(value, str)
    ]
    if reasoning.get("supported") is not True or reasoning.get("control") != "levels":
        return None
    if request.thinking == "off" and "none" in efforts:
        return "none"
    if request.thinking == "on":
        for effort in ("low", "minimal", "medium", "high", "xhigh"):
            if effort in efforts:
                return effort
    return None


class HuggingFaceAdapter(OpenAIProviderAdapter):
    """HF Router adapter with selected-model reasoning feature detection.

    A successful model-list entry proves that a route is available; it does not
    prove that the selected upstream accepts or obeys reasoning controls. The
    probe therefore tests acceptance of native controls on that exact route.
    A successful short response does not prove their semantic effect.
    Runtime telemetry remains authoritative if an upstream accepts ``none`` but
    still reports hidden reasoning tokens.
    """

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        off = _probe_effort(request, "none")
        if off.ok:
            on = _probe_effort(request, "low")
            if on.ok:
                return ProbeResponse(
                    True,
                    off.http_status,
                    capabilities={
                        "reasoning": {
                            "supported": True,
                            "mandatory": False,
                            "control": "levels",
                            "supported_efforts": ["none", "low"],
                            "dynamic": True,
                        }
                    },
                )
            # Native Off was accepted, but a non-zero effort was not. Keep the
            # model usable without inventing a user-facing On switch.
            return ProbeResponse(
                True,
                off.http_status,
                capabilities={
                    "reasoning": {
                        "supported": True,
                        "mandatory": False,
                        "control": "levels",
                        "supported_efforts": ["none"],
                    }
                },
            )
        if off.http_status == 400:
            # Unsupported reasoning_effort must not make an otherwise healthy
            # selected model appear unavailable.
            return openai_chat_probe(request, payload_extra={"max_tokens": 256})
        return off

    def generate(self, request: GenerationRequest):
        model = request.model
        payload = build_payload(request, model, POLICY)
        effort = _accepted_reasoning_effort(request)
        if effort:
            payload["reasoning_effort"] = effort
            # Preserve the compatibility policy, including effort="none".
            # Acceptance of reasoning_effort does not verify compatibility of
            # the combined sampling controls or reveal the upstream defaults.
            payload.pop("temperature", None)
        result = execute_chat_completion(
            url=(request.base_url or DEFAULT_BASE_URL).rstrip("/") + "/chat/completions",
            headers=bearer_headers(request.api_key),
            payload=payload,
            model=model,
            provider_id=PROVIDER_ID,
            timeout=DEFAULT_GENERATION.timeout_sec,
            timeout_policy="cloud_default",
            expected_ids=list(request.expected_ids),
            cancel_check=request.cancel_check,
            trace_event="huggingface.generate",
            trace_file="ai/providers/cloud_huggingface.py",
            trace_fields={
                "temperatureSent": "temperature" in payload,
                "sampling": {
                    "requestedTemperature": payload.get("temperature"),
                    "temperatureOmissionReason": "reasoning_compatibility_policy" if effort else None,
                    "effectiveTemperature": "unknown",
                    "topPSent": "top_p" in payload,
                },
                "reasoningEvidence": {
                    "control": "capability_reported_acceptance" if effort else "unknown",
                    "behavior": "not_verified_by_probe",
                },
                "outputBudgetField": POLICY.output_budget_field,
                "requestedOutputTokens": payload.get("max_tokens"),
                "reasoningPolicy": "selected_model_reasoning_effort" if effort else POLICY.reasoning_policy,
                "reasoningControlSent": bool(effort),
                "reasoningEffortSent": effort,
                "thinkingMode": request.thinking,
                "capabilityKnown": bool(request.model_capabilities),
            },
        )
        if not effort:
            applied = "unverified"
        elif effort == "none" and isinstance(result.thinking_tokens, int) and result.thinking_tokens > 0:
            # The route accepted the field but did not actually suppress hidden
            # reasoning. Workload telemetry will reserve those measured tokens
            # for subsequent unsent batches instead of trusting the toggle.
            applied = "provider_ignored_off"
        else:
            applied = f"requested_{request.thinking}_effort_{effort}"
        return result._replace(thinking_applied=applied)


ADAPTER = HuggingFaceAdapter(POLICY)
SPEC = ProviderSpec(
    PROVIDER_ID,
    "openai_chat_completions",
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    ALIASES,
    key_prefixes=("hf_",),
    proactive_rate_gate=False,
    adapter=ADAPTER,
)

__all__ = [
    "ADAPTER",
    "SPEC",
    "FALLBACK_PRIORITY",
    "HuggingFaceAdapter",
    "filter_model_items",
    "pick_fallback_model",
]
