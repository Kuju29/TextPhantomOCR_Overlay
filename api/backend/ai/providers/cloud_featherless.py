"""Featherless identity, plan-aware catalogue and rate policy."""

from types import MappingProxyType

from backend.ai.provider_contract import ProviderSpec
from backend.ai.providers.openai_provider_runtime import OpenAIProviderAdapter, OpenAIProviderPolicy

PROVIDER_ID = "featherless"
DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct"
DEFAULT_BASE_URL = "https://api.featherless.ai/v1"
LIST_PARAMS = MappingProxyType({
    "available_on_current_plan": "true",
    "conversational": "true",
    "status": "active",
    "per_page": 1000,
})

def filter_model_items(items) -> list[str]:
    models = []
    for item in items or []:
        if not isinstance(item, dict) or not str(item.get("id") or "").strip():
            continue
        if item.get("available_on_current_plan") is False:
            continue
        if str(item.get("status") or "active").strip().lower() not in ("", "active"):
            continue
        if item.get("conversational") is False:
            continue
        inputs = item.get("input_modalities")
        outputs = item.get("output_modalities")
        if isinstance(inputs, list) and inputs and "text" not in {str(v).lower() for v in inputs}:
            continue
        if isinstance(outputs, list) and outputs and "text" not in {str(v).lower() for v in outputs}:
            continue
        models.append(str(item["id"]).strip())
    return models

POLICY = OpenAIProviderPolicy(
    provider_id=PROVIDER_ID,
    trace_file="ai/providers/cloud_featherless.py",
    # The catalogue does not expose per-model sampling capabilities. Preserve
    # the selected model's provider default rather than guessing support.
    temperature=None,
    output_budget_field="max_tokens",
    reasoning_policy="requires_verified_capability",
    model_filter=filter_model_items,
    list_params=LIST_PARAMS,
)
ADAPTER = OpenAIProviderAdapter(POLICY)
SPEC = ProviderSpec(
    PROVIDER_ID,
    "openai_chat_completions",
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    rate_rpm=30.0,
    rate_burst=6,
    rate_rpm_min=6.0,
    rate_rpm_max=150.0,
    adapter=ADAPTER,
)

__all__ = ["ADAPTER", "SPEC", "LIST_PARAMS", "filter_model_items"]
