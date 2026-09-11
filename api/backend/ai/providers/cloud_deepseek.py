"""DeepSeek identity, catalogue and request policy."""

from functools import partial

from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.providers.openai_provider_runtime import (
    OpenAIProviderAdapter, OpenAIProviderPolicy, bearer_headers, build_payload,
)
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.openai_chat import execute_chat_completion
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
)
class DeepSeekAdapter(OpenAIProviderAdapter):
    """DeepSeek owns a documented thinking toggle; default it to Off."""

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        return openai_chat_probe(
            request,
            payload_extra={"max_tokens": 128, "thinking": {"type": "disabled"}},
        )

    def generate(self, request: GenerationRequest):
        model = resolve_model(request.model)
        payload = build_payload(request, model, POLICY)
        if request.thinking in {"off", "on"}:
            payload["thinking"] = {"type": "enabled" if request.thinking == "on" else "disabled"}
        result = execute_chat_completion(
            url=request.base_url.rstrip("/") + "/chat/completions",
            headers=bearer_headers(request.api_key),
            payload=payload, model=model, provider_id=PROVIDER_ID,
            timeout=DEFAULT_GENERATION.timeout_sec, timeout_policy="cloud_default",
            expected_ids=list(request.expected_ids), cancel_check=request.cancel_check,
            trace_file="ai/providers/cloud_deepseek.py",
            trace_fields={
                "temperatureSent": "temperature" in payload,
                "outputBudgetField": POLICY.output_budget_field,
                "requestedOutputTokens": payload.get("max_tokens"),
                "reasoningPolicy": "deepseek_thinking_toggle",
                "reasoningControlSent": "thinking" in payload,
                "thinkingMode": request.thinking,
            },
        )
        return result._replace(thinking_applied=(
            f"requested_{request.thinking}" if request.thinking in {"off", "on"}
            else "provider_default"
        ))

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        listed = super().list_models(api_key=api_key, base_url=base_url)
        if listed.status != "valid":
            return listed
        reasoning = {
            "supported": True, "mandatory": False, "default_enabled": True,
            "control": "toggle", "dynamic": True,
        }
        capabilities = {
            model: {"reasoning": dict(reasoning)}
            for model in listed.models
            if model.startswith("deepseek-v4-")
        }
        return ModelListResult(
            models=listed.models, status=listed.status, http_status=listed.http_status,
            error=listed.error, capabilities=capabilities,
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
