"""Groq identity, translation catalogue and rate policy."""

import httpx

from backend.ai.generation_defaults import DEFAULT_GENERATION
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.cloud_reasoning import observed_off_status
from backend.ai.providers.openai_provider_runtime import (
    OpenAIProviderAdapter, OpenAIProviderPolicy, bearer_headers, build_payload,
)
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.openai_chat import execute_chat_completion
from backend.ai.workload import normalize_limits

PROVIDER_ID = "groq"
DEFAULT_MODEL = "openai/gpt-oss-20b"
DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
EXCLUDED_MODEL_FRAGMENTS = (
    "prompt-guard", "safeguard", "guard", "whisper", "orpheus", "-tts", "embed", "audio", "compound",
)

def filter_model_items(items) -> list[str]:
    return [
        str(item.get("id")).strip()
        for item in items or []
        if isinstance(item, dict)
        and str(item.get("id") or "").strip()
        and item.get("active") is not False
        and not any(fragment in str(item.get("id")).lower() for fragment in EXCLUDED_MODEL_FRAGMENTS)
    ]

POLICY = OpenAIProviderPolicy(
    provider_id=PROVIDER_ID,
    trace_file="ai/providers/cloud_groq.py",
    temperature=0.7,
    output_budget_field="max_completion_tokens",
    reasoning_policy="requires_verified_capability",
    model_filter=filter_model_items,
    catalogue_evidence="groq_active_translation_filter",
)

# Native Groq Chat Completions control, restricted to exact documented IDs.
# GPT-OSS cannot disable thinking; "low" is its minimum (not Off).
_NATIVE_REASONING = {
    # Groq's generic API/model pages conflict with its current Reasoning
    # compatibility table about older Qwen controls. Leave those unverified.
    "qwen/qwen3.8-27b": {"supported": True, "mandatory": False,
                          "default_enabled": False, "control": "levels",
                          "supported_efforts": ["none", "low", "medium", "high"]},
    "openai/gpt-oss-20b": {"supported": True, "mandatory": True,
                             "default_enabled": True, "control": "levels",
                             "default_effort": "medium", "supported_efforts": ["low", "medium", "high"]},
    "openai/gpt-oss-120b": {"supported": True, "mandatory": True,
                              "default_enabled": True, "control": "levels",
                              "default_effort": "medium", "supported_efforts": ["low", "medium", "high"]},
}
_DOCUMENTED_VISION_MODELS = frozenset({"qwen/qwen3.6-27b", "qwen/qwen3.8-27b"})


def _reasoning_capability(model: str) -> dict:
    return dict(_NATIVE_REASONING.get(model, {}))


def _native_effort(request: GenerationRequest) -> str | None:
    native = _reasoning_capability(request.model)
    observed = request.model_capabilities.get("reasoning", {})
    if not native or not isinstance(observed, dict) or observed.get("supported") is not True:
        return None
    if request.thinking == "off":
        return "none" if not native.get("mandatory") else None
    return request.thinking if request.thinking in native["supported_efforts"] else None


class GroqAdapter(OpenAIProviderAdapter):
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
        items = items if isinstance(items, list) else []
        models = filter_model_items(items)
        rows_by_id: dict[str, list[dict]] = {}
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                rows_by_id.setdefault(item["id"].strip(), []).append(item)
        caps = {}
        for model in models:
            capability = {
                **({"reasoning": _reasoning_capability(model)} if _reasoning_capability(model) else {}),
                **({"vision": {"supported": True, "source": "groq_exact_model_documentation"}}
                   if model in _DOCUMENTED_VISION_MODELS else {}),
            }
            rows = rows_by_id.get(model, [])
            if len(rows) == 1:
                limits = normalize_limits({"contextTokens": rows[0].get("context_window"),
                    "maxOutputTokens": rows[0].get("max_completion_tokens"),
                    "source": "groq_account_models_api", "scope": "model"})
                if "contextTokens" in limits or "maxOutputTokens" in limits:
                    capability["limits"] = limits
            if capability:
                caps[model] = capability
        return ModelListResult(models=tuple(dict.fromkeys(models)), status="valid", http_status=response.status_code,
            capabilities=caps, candidates={model: {"eligibility": "usable", "evidence": POLICY.catalogue_evidence}
                for model in models})

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        # Reuse the one existing connectivity request, without an extra paid call.
        # Do not retry without a control if the provider rejects it.
        native = _reasoning_capability(request.model)
        effort = ("none" if native and not native["mandatory"]
                  else "low" if native and native["mandatory"] else None)
        return openai_chat_probe(request, payload_extra={"reasoning_effort": effort} if effort else None)

    def generate(self, request: GenerationRequest):
        payload = build_payload(request, request.model, POLICY)
        effort = _native_effort(request)
        if effort:
            payload["reasoning_effort"] = effort
            if effort == "none":
                payload.setdefault("temperature", POLICY.temperature)
        result = execute_chat_completion(
            url=request.base_url.rstrip("/") + "/chat/completions",
            headers=bearer_headers(request.api_key), payload=payload,
            model=request.model, provider_id=PROVIDER_ID,
            timeout=DEFAULT_GENERATION.timeout_sec, timeout_policy="cloud_default",
            expected_ids=list(request.expected_ids), cancel_check=request.cancel_check,
            trace_file="ai/providers/cloud_groq.py",
            trace_fields={"reasoningControlSent": bool(effort),
                          "reasoningEffortSent": effort, "thinkingMode": request.thinking,
                          "temperatureSent": "temperature" in payload,
                          "requestedOutputTokens": payload.get("max_completion_tokens")},
        )
        applied = "provider_default" if request.thinking == "default" else "unverified"
        if effort == "none":
            applied = observed_off_status(result)
        elif effort:
            applied = f"requested_{request.thinking}_effort_{effort}"
        return result._replace(thinking_applied=applied)


ADAPTER = GroqAdapter(POLICY)
SPEC = ProviderSpec(
    PROVIDER_ID,
    "openai_chat_completions",
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    key_prefixes=("gsk_",),
    rate_rpm=30.0,
    rate_burst=6,
    rate_rpm_min=6.0,
    rate_rpm_max=300.0,
    conversation_transport="message_replay", adapter=ADAPTER,
)

__all__ = ["ADAPTER", "SPEC", "EXCLUDED_MODEL_FRAGMENTS", "filter_model_items"]
