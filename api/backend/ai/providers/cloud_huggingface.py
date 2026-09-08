"""Hugging Face Router identity, catalogue and fallback policy."""

from backend.ai.provider_contract import ProviderSpec
from backend.ai.providers.openai_provider_runtime import OpenAIProviderAdapter, OpenAIProviderPolicy

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
)
ADAPTER = OpenAIProviderAdapter(POLICY)
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

__all__ = ["ADAPTER", "SPEC", "FALLBACK_PRIORITY", "filter_model_items", "pick_fallback_model"]
