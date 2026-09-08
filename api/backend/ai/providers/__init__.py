"""Composition root for every supported AI provider.

Leaf modules are declarations only.  Registration happens exclusively through
``compose_providers`` so a cleared or isolated registry can be rebuilt without
depending on Python's module-import cache.
"""
from backend.ai.provider_registry import ProviderRegistry, provider_registry
from . import (
    cloud_anthropic, cloud_deepseek, cloud_featherless, cloud_gemini,
    cloud_groq, cloud_huggingface, cloud_openai, cloud_openrouter,
    cloud_together, local_gpt4all, local_jan, local_koboldcpp,
    local_llamacpp, local_llamafile, local_lmstudio, local_localai,
    local_ollama, local_textgen, local_vllm,
)
_MODULES = (
    cloud_anthropic, cloud_deepseek, cloud_featherless, cloud_gemini,
    cloud_groq, cloud_huggingface, cloud_openai, cloud_openrouter,
    cloud_together, local_gpt4all, local_jan, local_koboldcpp,
    local_llamacpp, local_llamafile, local_lmstudio, local_localai,
    local_ollama, local_textgen, local_vllm,
)

def compose_providers(registry: ProviderRegistry = provider_registry) -> ProviderRegistry:
    """Register every canonical declaration exactly once in ``registry``.

    Repeating composition with the same declarations is intentionally safe.
    A conflicting declaration for an existing provider id is still rejected,
    and alias collisions remain enforced by ``ProviderRegistry.register``.
    """
    for module in _MODULES:
        spec = module.SPEC
        existing = registry.get(spec.provider_id)
        if existing is None:
            registry.register(spec)
        elif existing != spec:
            raise ValueError(f"conflicting provider declaration: {spec.provider_id}")
    return registry

__all__ = [
    *(module.__name__.rsplit(".", 1)[-1] for module in _MODULES),
    "compose_providers",
]
