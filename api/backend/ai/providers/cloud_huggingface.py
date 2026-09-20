"""Hugging Face Router identity, catalogue and selected-model controls."""

from __future__ import annotations

import re

import httpx

from backend.ai.generation_defaults import DEFAULT_GENERATION
from backend.ai.provider_contract import (
    GenerationRequest,
    ModelListResult,
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
from backend.ai.transports.huggingface_chat import execute_huggingface_chat


_HF_PROVIDER_SUFFIX = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

def _base_model_id(model: str) -> str:
    value = str(model or "").strip()
    if ":" not in value:
        return value
    base, suffix = value.rsplit(":", 1)
    return base if base and _HF_PROVIDER_SUFFIX.fullmatch(suffix.lower()) else value

def _effective_conversation_model(request: GenerationRequest) -> tuple[str, str]:
    """Keep HF Router on automatic fastest/failover unless the user pins it.

    Hugging Face Router already performs backend selection and failover.  A
    provider suffix is therefore honored only when it is part of the user's
    selected model.  Observed upstreams and catalogue hints remain diagnostics;
    they must not silently turn into sticky routing for later Conversation turns.
    This mirrors Hermes' default HF strategy and prevents one slow backend from
    being pinned merely because it served an earlier turn.
    """
    requested = str(request.model or "").strip()
    if _base_model_id(requested) != requested:
        return requested, requested.rsplit(":", 1)[-1].lower()
    return requested, ""

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
    if request.thinking in efforts:
        return request.thinking
    if request.thinking == "on":
        for effort in ("low", "minimal", "medium", "high", "xhigh", "max", "ultra"):
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
            prior = request.model_capabilities.get("reasoning", {})
            prior = prior if isinstance(prior, dict) else {}
            # Keep previously scoped, verified options, but never invent Low
            # or require another generation to enable Lowest available.
            efforts = ["none"]
            if prior.get("supported") is True and prior.get("control") == "levels":
                efforts += [value for value in prior.get("supported_efforts", [])
                            if value in {"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}]
            return ProbeResponse(
                True, off.http_status,
                capabilities={"reasoning": {
                    "supported": True, "mandatory": False, "control": "levels",
                    "supported_efforts": list(dict.fromkeys(efforts)),
                }},
            )
        if off.http_status == 400:
            # Unsupported reasoning_effort must not make an otherwise healthy
            # selected model appear unavailable.
            return openai_chat_probe(request, payload_extra={"max_tokens": 256})
        return off

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        if not api_key or not base_url:
            return ModelListResult(status="missing")
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.get(base_url.rstrip("/") + "/models", headers=bearer_headers(api_key))
        except httpx.RequestError as exc:
            return ModelListResult(status="unreachable", error=type(exc).__name__)
        if not response.is_success:
            status = "invalid_key" if response.status_code == 401 else "forbidden" if response.status_code == 403 else "error"
            return ModelListResult(status=status, http_status=response.status_code)
        try:
            body = response.json()
        except ValueError:
            return ModelListResult(status="error", http_status=response.status_code, error="invalid_json")
        items = body.get("data", []) if isinstance(body, dict) else []
        models = filter_model_items(items)
        capabilities, candidates = {}, {}
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict) or str(item.get("id") or "").strip() not in models:
                continue
            model_id = str(item["id"]).strip()
            live = [entry for entry in (item.get("providers") or [])
                    if isinstance(entry, dict) and str(entry.get("status") or "").lower() == "live"
                    and _HF_PROVIDER_SUFFIX.fullmatch(str(entry.get("provider") or "").strip().lower())]
            if live:
                # HF documents :fastest/auto as the highest-throughput live
                # provider. Mirror that policy once, then pin the selected
                # provider for the whole Conversation cache chain. Fall back to
                # lowest measured TTFT only when throughput is unavailable.
                throughput = [entry for entry in live if isinstance(entry.get("throughput"), (int, float))]
                latency = [entry for entry in live if isinstance(entry.get("first_token_latency_ms"), (int, float))]
                if throughput:
                    chosen = max(throughput, key=lambda entry: float(entry["throughput"]))
                    routing_source = "huggingface_live_catalogue_fastest_throughput"
                elif latency:
                    chosen = min(latency, key=lambda entry: float(entry["first_token_latency_ms"]))
                    routing_source = "huggingface_live_catalogue_lowest_ttft"
                else:
                    chosen = live[0]
                    routing_source = "huggingface_live_catalogue_first"
                preferred = str(chosen.get("provider") or "").strip().lower()
                # Keep this as a catalogue hint only.  HF Router remains in
                # automatic fastest/failover mode unless the user explicitly
                # selects a ``model:provider`` suffix.
                candidates[model_id] = {"eligibility":"usable","evidence":POLICY.catalogue_evidence,
                    "fastestProviderHint":preferred,"routingPolicy":"hf_auto_fastest_failover",
                    "routingEvidence":routing_source}
        return ModelListResult(models=tuple(models), status="valid", http_status=response.status_code,
                               capabilities=capabilities, candidates=candidates)

    def generate(self, request: GenerationRequest):
        model = request.model
        effective_model, affinity = _effective_conversation_model(request)
        payload = build_payload(request, effective_model, POLICY)
        effort = _accepted_reasoning_effort(request)
        if effort:
            payload["reasoning_effort"] = effort
            # Preserve the compatibility policy, including effort="none".
            # Acceptance of reasoning_effort does not verify compatibility of
            # the combined sampling controls or reveal the upstream defaults.
            payload.pop("temperature", None)
        from backend.ai.provider_resolution import (
            capture_capability_cache_revision, retain_observed_off_control,
        )
        evidence_base = request.base_url or DEFAULT_BASE_URL
        dispatch_revision = capture_capability_cache_revision(PROVIDER_ID, evidence_base, request.api_key)
        result = execute_huggingface_chat(
            url=(request.base_url or DEFAULT_BASE_URL).rstrip("/") + "/chat/completions",
            headers=bearer_headers(request.api_key),
            payload=payload,
            model=effective_model,
            timeout=DEFAULT_GENERATION.timeout_sec,
            timeout_policy="cloud_default",
            expected_ids=list(request.expected_ids),
            cancel_check=request.cancel_check,
            trace_event="huggingface.generate",
            trace_file="ai/providers/cloud_huggingface.py",
            trace_fields={
                "requestedModel": model,
                "effectiveModel": effective_model,
                "hfInferenceProviderAffinity": affinity or None,
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
        # A client-held probe can be the only evidence after an API restart.
        # Retain only the native Off used in this real response, never speculative
        # levels from that client. Unknown/missing usage is not zero reasoning.
        returned_model = str(result.used_model or "").strip().casefold()
        base_model = _base_model_id(model)
        same_model = returned_model in {base_model.casefold(), base_model.rsplit("/", 1)[-1].casefold()}
        if same_model and effort == "none" and type(result.thinking_tokens) is int and result.thinking_tokens == 0:
            retained = retain_observed_off_control(PROVIDER_ID, evidence_base, request.api_key,
                model, dispatch_revision=dispatch_revision)
            if retained:
                from backend.ai import trace_preview
                trace_preview.note("AI native Off evidence retained", {
                    "provider": PROVIDER_ID, "model": model, "reasoningEffortSent": "none",
                    "actualReasoning": 0, "evidenceSource": "accepted_generation_zero_reasoning",
                })
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
