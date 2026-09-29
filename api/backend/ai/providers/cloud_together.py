"""Together AI identity, top-level catalogue shape and rate policy."""

import httpx

from backend.ai.generation_defaults import DEFAULT_GENERATION
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.cloud_reasoning import observed_off_status
from backend.ai.providers.openai_provider_runtime import (
    OpenAIProviderAdapter, OpenAIProviderPolicy, array_or_data_items, bearer_headers, build_payload,
)
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.openai_chat import execute_chat_completion
from backend.ai.workload import normalize_limits

PROVIDER_ID = "together"
# Preserve the existing default until the user approves a replacement.
# A missing catalogue entry must surface as unavailable, without model fallback.
DEFAULT_MODEL = "openai/gpt-oss-20b"
DEFAULT_BASE_URL = "https://api.together.xyz/v1"

def filter_model_items(items) -> list[str]:
    return [
        str(item.get("id")).strip()
        for item in items or []
        if isinstance(item, dict)
        and str(item.get("id") or "").strip()
        and str(item.get("type") or "").lower() == "chat"
    ]

POLICY = OpenAIProviderPolicy(
    provider_id=PROVIDER_ID,
    trace_file="ai/providers/cloud_together.py",
    temperature=0.7,
    output_budget_field="max_tokens",
    reasoning_policy="requires_verified_capability",
    model_filter=filter_model_items,
    catalogue_evidence="together_account_chat_type",
    catalogue_items=array_or_data_items,
)

# Exact serverless models with documented native Chat Completions controls.
# Do not infer the same contract for lookalike names on dedicated endpoints.
_NATIVE_REASONING = {
    "Qwen/Qwen3.5-9B": {"supported": True, "mandatory": False,
                         "default_enabled": True, "control": "boolean",
                         "supported_efforts": ["none", "on"]},
    "zai-org/GLM-5.2": {"supported": True, "mandatory": False,
                         "default_enabled": True, "control": "boolean",
                         "supported_efforts": ["none", "on"]},
    "openai/gpt-oss-120b": {"supported": True, "mandatory": True,
                              "default_enabled": True, "control": "levels",
                              "default_effort": "medium", "supported_efforts": ["low", "medium", "high"]},
}
_DOCUMENTED_SERVERLESS_VISION = frozenset({
    "Qwen/Qwen3.5-9B", "MiniMaxAI/MiniMax-M3", "moonshotai/Kimi-K3",
})


def _reasoning_capability(model: str) -> dict:
    return dict(_NATIVE_REASONING.get(model, {}))


def _native_control(request: GenerationRequest) -> dict:
    native = _reasoning_capability(request.model)
    observed = request.model_capabilities.get("reasoning", {})
    if not native or not isinstance(observed, dict) or observed.get("supported") is not True:
        return {}
    if native["control"] == "boolean":
        if request.thinking == "off":
            return {"reasoning": {"enabled": False}}
        if request.thinking == "on":
            return {"reasoning": {"enabled": True}}
        return {}
    if request.thinking in native["supported_efforts"]:
        return {"reasoning_effort": request.thinking}
    return {}


class TogetherAdapter(OpenAIProviderAdapter):
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
        items = POLICY.catalogue_items(body)
        models = filter_model_items(items)
        rows_by_id: dict[str, list[dict]] = {}
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                rows_by_id.setdefault(item["id"].strip(), []).append(item)
        caps = {}
        for model in models:
            capability = {
                **({"reasoning": _reasoning_capability(model)} if _reasoning_capability(model) else {}),
                **({"vision": {"supported": True, "source": "together_exact_serverless_model_documentation"}}
                   if model in _DOCUMENTED_SERVERLESS_VISION else {}),
            }
            rows = rows_by_id.get(model, [])
            if len(rows) == 1:
                limits = normalize_limits({"contextTokens": rows[0].get("context_length"),
                    "maxOutputTokens": rows[0].get("max_output_tokens"),
                    "source": "together_account_models_api", "scope": "model"})
                if "contextTokens" in limits or "maxOutputTokens" in limits:
                    capability["limits"] = limits
            if capability:
                caps[model] = capability
        return ModelListResult(models=tuple(dict.fromkeys(models)), status="valid", http_status=response.status_code,
            capabilities=caps, candidates={model: {"eligibility": "usable", "evidence": POLICY.catalogue_evidence}
                for model in models})

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        native = _reasoning_capability(request.model)
        control = ({"reasoning": {"enabled": False}} if native.get("control") == "boolean"
                   else {"reasoning_effort": "low"} if native.get("control") == "levels" else {})
        # The existing connectivity call is sufficient; never silently retry
        # an unsupported native option with Thinking reset to provider default.
        return openai_chat_probe(request, payload_extra=control)

    def generate(self, request: GenerationRequest):
        payload = build_payload(request, request.model, POLICY)
        control = _native_control(request)
        payload.update(control)
        if control.get("reasoning") == {"enabled": False}:
            payload.setdefault("temperature", POLICY.temperature)
        result = execute_chat_completion(
            url=request.base_url.rstrip("/") + "/chat/completions",
            headers=bearer_headers(request.api_key), payload=payload,
            model=request.model, provider_id=PROVIDER_ID,
            timeout=DEFAULT_GENERATION.timeout_sec, timeout_policy="cloud_default",
            expected_ids=list(request.expected_ids), cancel_check=request.cancel_check,
            trace_file="ai/providers/cloud_together.py",
            trace_fields={"reasoningControlSent": bool(control),
                          "reasoningEnabledSent": (control.get("reasoning") or {}).get("enabled"),
                          "reasoningEffortSent": control.get("reasoning_effort"),
                          "thinkingMode": request.thinking,
                          "temperatureSent": "temperature" in payload,
                          "requestedOutputTokens": payload.get("max_tokens")},
        )
        applied = "provider_default" if request.thinking == "default" else "unverified"
        if control.get("reasoning") == {"enabled": False}:
            applied = observed_off_status(result)
        elif control:
            applied = f"requested_{request.thinking}"
        return result._replace(thinking_applied=applied)


ADAPTER = TogetherAdapter(POLICY)
SPEC = ProviderSpec(
    PROVIDER_ID,
    "openai_chat_completions",
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    rate_rpm=60.0,
    rate_burst=8,
    rate_rpm_min=10.0,
    rate_rpm_max=300.0,
    conversation_transport="message_replay", adapter=ADAPTER,
)

__all__ = ["ADAPTER", "SPEC", "filter_model_items"]
