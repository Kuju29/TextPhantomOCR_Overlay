"""Together AI identity, top-level catalogue shape and rate policy."""

from backend.ai.provider_contract import ProviderSpec
from backend.ai.providers.openai_provider_runtime import OpenAIProviderAdapter, OpenAIProviderPolicy, array_or_data_items

PROVIDER_ID = "together"
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
    catalogue_items=array_or_data_items,
)
ADAPTER = OpenAIProviderAdapter(POLICY)
SPEC = ProviderSpec(
    PROVIDER_ID,
    "openai_chat_completions",
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    rate_rpm=60.0,
    rate_burst=8,
    rate_rpm_min=10.0,
    rate_rpm_max=300.0,
    adapter=ADAPTER,
)

__all__ = ["ADAPTER", "SPEC", "filter_model_items"]
