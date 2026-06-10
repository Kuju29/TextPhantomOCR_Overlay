"""Static configuration for AI providers.

This module knows nothing about live API calls — it just holds the defaults,
aliases and prompt templates that other modules consume.
"""

from __future__ import annotations

from typing import Final, TypedDict


class ProviderDefaults(TypedDict):
    model: str
    base_url: str


PROVIDER_DEFAULTS: Final[dict[str, ProviderDefaults]] = {
    "gemini":      {"model": "gemini-2.5-flash",            "base_url": ""},
    "openai":      {"model": "gpt-4o-mini",                 "base_url": "https://api.openai.com/v1"},
    "openrouter":  {"model": "openai/o4-mini",              "base_url": "https://openrouter.ai/api/v1"},
    "huggingface": {"model": "google/gemma-2-2b-it",        "base_url": "https://router.huggingface.co/v1"},
    "featherless": {"model": "Qwen/Qwen2.5-7B-Instruct",    "base_url": "https://api.featherless.ai/v1"},
    "groq":        {"model": "openai/gpt-oss-20b",          "base_url": "https://api.groq.com/openai/v1"},
    "together":    {"model": "openai/gpt-oss-20b",          "base_url": "https://api.together.xyz/v1"},
    "deepseek":    {"model": "deepseek-chat",               "base_url": "https://api.deepseek.com/v1"},
    "anthropic":   {"model": "claude-sonnet-4-20250514",    "base_url": "https://api.anthropic.com"},
    # Local, self-hosted LLM servers that speak the OpenAI /v1 dialect.
    # No API key required — base_url points at the user's own machine.
    "ollama":       {"model": "llama3.1",        "base_url": "http://localhost:11434/v1"},
    "lmstudio":     {"model": "local-model",     "base_url": "http://localhost:1234/v1"},
    "localai":      {"model": "local-model",     "base_url": "http://localhost:8080/v1"},
    "jan":          {"model": "local-model",     "base_url": "http://localhost:1337/v1"},
    "textgen":      {"model": "local-model",     "base_url": "http://localhost:5000/v1"},
    "koboldcpp":    {"model": "local-model",     "base_url": "http://localhost:5001/v1"},
    "vllm":         {"model": "local-model",     "base_url": "http://localhost:8000/v1"},
    "llamafile":    {"model": "local-model",     "base_url": "http://localhost:8080/v1"},
    "gpt4all":      {"model": "local-model",     "base_url": "http://localhost:4891/v1"},
}

# Providers that run on the user's own machine and need NO API key.
# All speak the OpenAI-compatible /v1 dialect, so one client handles them all.
LOCAL_PROVIDERS: Final[frozenset[str]] = frozenset({
    "ollama", "lmstudio", "localai", "jan", "textgen",
    "koboldcpp", "vllm", "llamafile", "gpt4all",
})


PROVIDER_ALIASES: Final[dict[str, str]] = {
    "hf": "huggingface",
    "huggingface_router": "huggingface",
    "hf_router": "huggingface",
    "openai_compat": "openai",
    "openai-compatible": "openai",
    "gemini3": "gemini",
    "gemini-3": "gemini",
    "google": "gemini",
    "local": "ollama",
    "llama": "ollama",
    "llamacpp": "ollama",
    "llama.cpp": "ollama",
    "llama-cpp": "ollama",
    "lm-studio": "lmstudio",
    "lm_studio": "lmstudio",
    "lms": "lmstudio",
    "local-ai": "localai",
    "local_ai": "localai",
    "jan.ai": "jan",
    "text-generation-webui": "textgen",
    "oobabooga": "textgen",
    "ooba": "textgen",
    "kobold": "koboldcpp",
    "koboldai": "koboldcpp",
    "gpt-4-all": "gpt4all",
    "gpt-4all": "gpt4all",
}


MODEL_ALIASES: Final[dict[str, dict[str, str]]] = {
    "gemini": {
        "flash-lite":   "gemini-2.5-flash-lite",
        "flash":        "gemini-2.5-flash",
        "pro":          "gemini-2.5-pro",
        "3-flash":      "gemini-3-flash-preview",
        "3-pro":        "gemini-3-pro-preview",
        "3-pro-image":  "gemini-3-pro-image-preview",
        "flash-image":  "gemini-2.5-flash-image",
        # Retired models → remap to the current equivalent so an old stored
        # selection keeps working instead of returning HTTP 404.
        "gemini-2.0-flash-lite": "gemini-2.5-flash-lite",
        "gemini-2.0-flash":      "gemini-2.5-flash",
        "gemini-1.5-flash":      "gemini-2.5-flash",
        "gemini-1.5-flash-8b":   "gemini-2.5-flash-lite",
        "gemini-1.5-pro":        "gemini-2.5-pro",
    },
}


# Hard-coded model fallbacks used by /ai/resolve when the live endpoint
# enumeration returns nothing useful.
# Live Gemini models as of the official docs (2026-06-01). 2.0-* were shut
# down 2026-06-01 and gemini-3-pro-preview was shut down, so they are NOT
# listed here. ``gemini-flash-latest`` is an auto-updating alias kept last as a
# self-healing safety net.
GEMINI_FALLBACK_MODELS: Final[list[str]] = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-flash-latest",
]


HF_FALLBACK_MODELS: Final[list[str]] = [
    "google/gemma-3-27b-it:featherless-a",
    "google/gemma-3-27b-it",
    "google/gemma-2-2b-it",
    "google/gemma-2-9b-it",
]


# AI sampling defaults.
TEMPERATURE: Final[float] = 0.2
# Manga pages can hit 20+ paragraphs and a Thai/CJK token is roughly a
# character, so a generous output cap is needed — 1200 used to truncate
# mid-paragraph and force the marker-repair fallback to fill the gaps with
# Lens text. Providers that don't support this much silently clamp to their
# own limit (Gemini 2.5 Flash allows up to 65k, Claude allows 8k+, etc.).
MAX_TOKENS: Final[int] = 8192
TIMEOUT_SEC: Final[float] = 120.0
