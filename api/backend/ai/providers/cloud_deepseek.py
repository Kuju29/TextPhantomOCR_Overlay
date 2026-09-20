"""DeepSeek identity, catalogue and request policy."""

from functools import partial

from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.providers.openai_provider_runtime import (
    OpenAIProviderAdapter, OpenAIProviderPolicy, bearer_headers, build_payload,
)
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.deepseek_chat import execute_deepseek_chat
from backend.ai.generation_defaults import DEFAULT_GENERATION
from backend.ai.providers.provider_helpers import resolve_alias

PROVIDER_ID = "deepseek"
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
MODEL_ALIASES = {"deepseek-chat": DEFAULT_MODEL, "deepseek-reasoner": DEFAULT_MODEL}

resolve_model = partial(resolve_alias, aliases=MODEL_ALIASES, default=DEFAULT_MODEL)

def filter_model_items(items) -> list[str]:
    retired = set(MODEL_ALIASES)
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
    temperature=0.7,
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


class DeepSeekAdapter(OpenAIProviderAdapter):
    """Use DeepSeek thinking controls only when this exact model proves them."""

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        # The account catalogue marks the exact V4 families that own DeepSeek's
        # thinking toggle.  Other/future chat models must remain usable even if
        # they reject that optional field.
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
        return result._replace(thinking_applied=(
            f"requested_{request.thinking}" if "thinking" in payload
            else "provider_default_mandatory" if mandatory
            else "unverified"
        ))

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        listed = super().list_models(api_key=api_key, base_url=base_url)
        if listed.status != "valid":
            return listed
        reasoning = {
            "supported": True, "mandatory": False, "default_enabled": True,
            "control": "levels", "dynamic": True,
            "supported_efforts": ["none", "low", "high", "max"],
            "default_effort": "high",
        }
        capabilities = {
            model: {"reasoning": dict(reasoning)}
            for model in listed.models
            if model.startswith("deepseek-v4-")
        }
        return ModelListResult(
            models=listed.models, status=listed.status, http_status=listed.http_status,
            error=listed.error, capabilities=capabilities, candidates=listed.candidates,
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
    adapter=ADAPTER,
)

__all__ = ["ADAPTER", "SPEC", "MODEL_ALIASES", "filter_model_items", "resolve_model"]
