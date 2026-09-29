"""DeepSeek identity, catalogue and request policy."""

from functools import partial

import httpx

from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.cloud_reasoning import observed_off_status
from backend.ai.providers.openai_provider_runtime import (
    OpenAIProviderAdapter, OpenAIProviderPolicy, bearer_headers, build_payload,
)
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.deepseek_chat import execute_deepseek_chat
from backend.ai.generation_defaults import DEFAULT_GENERATION, output_token_budget
from backend.ai.providers.provider_helpers import resolve_alias
from backend.ai.workload import guard_request_budget, normalize_limits

PROVIDER_ID = "deepseek"
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
MODEL_ALIASES = {
    "deepseek-chat": DEFAULT_MODEL,
    "deepseek-reasoner": DEFAULT_MODEL,
    # Preserve the existing saved/default selection until a model change is
    # approved. A missing catalogue entry must not remap it silently.
    "deepseek-v4-flash": DEFAULT_MODEL,
}

resolve_model = partial(resolve_alias, aliases=MODEL_ALIASES, default=DEFAULT_MODEL)

def filter_model_items(items) -> list[str]:
    # A live /models listing still has authority over old IDs; only the
    # historical chat/reasoner mode aliases must never be picker choices.
    retired = {"deepseek-chat", "deepseek-reasoner"}
    return [
        str(item.get("id")).strip()
        for item in items or []
        if isinstance(item, dict)
        and str(item.get("id") or "").strip()
        and str(item.get("id")).strip().lower() not in retired
    ]


POLICY = OpenAIProviderPolicy(
    provider_id=PROVIDER_ID,
    trace_file="ai/providers/cloud_deepseek.py",
    # DeepSeek currently ignores temperature in both native Thinking modes.
    temperature=None,
    output_budget_field="max_tokens",
    reasoning_policy="requires_verified_capability",
    model_filter=filter_model_items,
    model_resolver=resolve_model,
    catalogue_evidence="deepseek_account_model_catalogue",
)
def _verified_reasoning(capabilities) -> bool:
    reasoning = capabilities.get("reasoning", {}) if isinstance(capabilities, dict) else {}
    return isinstance(reasoning, dict) and reasoning.get("supported") is True \
        and reasoning.get("control") in {"toggle", "boolean", "levels"}


_EFFORT_LEVELS = frozenset({"minimal", "low", "medium", "high", "xhigh", "max", "ultra"})


def _catalogue_capabilities(item: dict) -> dict:
    """Use only controls and modalities declared for this exact account model."""
    capabilities: dict = {}
    effort = item.get("effort")
    if isinstance(effort, dict) and isinstance(effort.get("supported_levels"), list):
        levels = [level for raw in effort["supported_levels"]
                  if isinstance(raw, str) and (level := raw.strip().lower()) in _EFFORT_LEVELS]
        if levels:
            # DeepSeek's Chat Completions toggle explicitly supports disabled;
            # the catalogue supplies the positive effort ladder for each model.
            reasoning = {
                "supported": True, "mandatory": False, "default_enabled": True,
                "control": "levels", "dynamic": True,
                "supported_efforts": ["none", *dict.fromkeys(levels)],
            }
            default = effort.get("default_level")
            if isinstance(default, str) and default.strip().lower() in levels:
                reasoning["default_effort"] = default.strip().lower()
            capabilities["reasoning"] = reasoning
    modalities = item.get("input_modalities")
    if isinstance(modalities, list):
        capabilities["vision"] = {"supported": "image" in modalities,
                                  "source": "deepseek_account_model_catalogue"}
    limits = normalize_limits({
        "contextTokens": item.get("context_window"),
        "maxOutputTokens": item.get("max_output_tokens"),
        "source": "deepseek_models_api", "scope": "model",
    })
    if limits.get("contextTokens") or limits.get("maxOutputTokens"):
        capabilities["limits"] = limits
    return capabilities


class DeepSeekAdapter(OpenAIProviderAdapter):
    """Use DeepSeek thinking controls only when this exact model proves them."""

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        # The account catalogue identifies the exact model's effort levels.
        # An unknown model stays probeable without guessing a thinking toggle.
        if _verified_reasoning(dict(request.model_capabilities)):
            return openai_chat_probe(
                request,
                payload_extra={"max_tokens": 128, "thinking": {"type": "disabled"}},
            )
        return openai_chat_probe(request, payload_extra={"max_tokens": 128})

    def generate(self, request: GenerationRequest):
        model = resolve_model(request.model)
        payload = build_payload(request, model, POLICY)
        control_verified = _verified_reasoning(dict(request.model_capabilities))
        reasoning = request.model_capabilities.get("reasoning", {})
        reasoning = reasoning if isinstance(reasoning, dict) else {}
        efforts = {str(value).strip().lower() for value in reasoning.get("supported_efforts", [])
                   if isinstance(value, str)}
        if control_verified:
            if request.thinking == "off":
                payload["thinking"] = {"type": "disabled"}
                payload["max_tokens"] = guard_request_budget(request, output_token_budget(
                    request.user_parts, request.system_text, reasoning=False,
                    unit_count=request.unit_count))
            elif request.thinking == "on":
                payload["thinking"] = {"type": "enabled"}
            elif request.thinking in efforts:
                if request.thinking == "none":
                    payload["thinking"] = {"type": "disabled"}
                else:
                    payload["thinking"] = {"type": "enabled"}
                    payload["reasoning_effort"] = request.thinking
        result = execute_deepseek_chat(
            url=request.base_url.rstrip("/") + "/chat/completions",
            headers=bearer_headers(request.api_key),
            payload=payload, model=model,
            timeout=DEFAULT_GENERATION.timeout_sec, timeout_policy="cloud_default",
            expected_ids=list(request.expected_ids), cancel_check=request.cancel_check,
            trace_file="ai/providers/cloud_deepseek.py",
            trace_fields={
                "temperatureSent": "temperature" in payload,
                "outputBudgetField": POLICY.output_budget_field,
                "requestedOutputTokens": payload.get("max_tokens"),
                "reasoningPolicy": "deepseek_native_reasoning",
                "reasoningControlSent": "thinking" in payload,
                "thinkingMode": request.thinking,
                "reasoningEffortSent": payload.get("reasoning_effort"),
            },
        )
        reasoning = request.model_capabilities.get("reasoning", {})
        mandatory = isinstance(reasoning, dict) and reasoning.get("mandatory") is True
        if payload.get("thinking") == {"type": "disabled"}:
            applied = observed_off_status(result)
        elif "thinking" in payload:
            applied = f"requested_{request.thinking}"
        else:
            applied = "provider_default_mandatory" if mandatory else "unverified"
        return result._replace(thinking_applied=applied)

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
            data = response.json()
        except ValueError:
            return ModelListResult(status="error", http_status=response.status_code, error="invalid_json")
        items = data.get("data", []) if isinstance(data, dict) else []
        items = items if isinstance(items, list) else []
        models = filter_model_items(items)
        rows_by_id: dict[str, list[dict]] = {}
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip():
                rows_by_id.setdefault(item["id"].strip(), []).append(item)
        capabilities = {model: cap for model in models
                        if len(rows_by_id[model]) == 1
                        if (cap := _catalogue_capabilities(rows_by_id[model][0]))}
        candidates = {model: {"eligibility": "usable", "evidence": POLICY.catalogue_evidence}
                      for model in models}
        return ModelListResult(
            models=tuple(models), status="valid", http_status=response.status_code,
            capabilities=capabilities, candidates=candidates,
        )

ADAPTER = DeepSeekAdapter(POLICY)
SPEC = ProviderSpec(
    PROVIDER_ID,
    "openai_chat_completions",
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    model_aliases=MODEL_ALIASES,
    rate_rpm=60.0,
    rate_burst=8,
    rate_rpm_min=10.0,
    rate_rpm_max=300.0,
    conversation_transport="message_replay", adapter=ADAPTER,
)

__all__ = ["ADAPTER", "SPEC", "MODEL_ALIASES", "filter_model_items", "resolve_model"]
