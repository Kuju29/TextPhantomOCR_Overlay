"""Groq identity, translation catalogue and rate policy."""

from backend.ai.provider_contract import ProviderSpec
from backend.ai.providers.openai_provider_runtime import OpenAIProviderAdapter, OpenAIProviderPolicy

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
)
ADAPTER = OpenAIProviderAdapter(POLICY)
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
    adapter=ADAPTER,
)

__all__ = ["ADAPTER", "SPEC", "EXCLUDED_MODEL_FRAGMENTS", "filter_model_items"]
