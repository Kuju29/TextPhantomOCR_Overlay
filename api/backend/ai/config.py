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


# Transport actually implemented by TextPhantom for each provider. The settings
# endpoint reports this to the popup so "provider exists in the UI" and
# "backend can really call it" cannot drift apart silently.
PROVIDER_PROTOCOLS: Final[dict[str, str]] = {
    "gemini": "gemini_generate_content",
    "anthropic": "anthropic_messages",
    "huggingface": "openai_chat_completions",
    "openai": "openai_chat_completions",
    "openrouter": "openai_chat_completions",
    "featherless": "openai_chat_completions",
    "groq": "openai_chat_completions",
    "together": "openai_chat_completions",
    "deepseek": "openai_chat_completions",
    "ollama": "openai_chat_completions",
    "lmstudio": "openai_chat_completions",
    "localai": "openai_chat_completions",
    "jan": "openai_chat_completions",
    "textgen": "openai_chat_completions",
    "koboldcpp": "openai_chat_completions",
    "vllm": "openai_chat_completions",
    "llamafile": "openai_chat_completions",
    "gpt4all": "openai_chat_completions",
}


class RatePolicy(TypedDict):
    rpm: float       # requests-per-minute this provider STARTS at, before adaptation
    burst: int       # how many requests may fire back-to-back before pacing kicks in
    rpm_min: float   # floor the adaptive gate will never go below
    rpm_max: float   # ceiling the adaptive gate will never climb past


# Per-provider rate-gate policy. Conservative defaults sized for the FREE tier
# of each provider (leave headroom below the real published limit). The gate
# reads these but every value is overridable per provider via the environment:
#   TP_RATE_RPM_GEMINI=20   TP_RATE_BURST_GEMINI=6
# Providers missing here fall back to Settings.rate_default_rpm / _burst.
# Local providers and Hugging Face are NOT gated here (local = no limit;
# Hugging Face keeps its dedicated throttle in ai/throttle.py).
# `rpm` is where an unknown key STARTS, chosen to sit under the published free
# tier. `rpm_min`/`rpm_max` bound where the adaptive gate may take it: it climbs
# while the provider accepts the traffic and halves the moment the provider
# answers 429, so a paid key finds its real ceiling and a free key settles back
# down without either being configured by hand.
RATE_POLICY_DEFAULTS: Final[dict[str, RatePolicy]] = {
    "gemini":      {"rpm": 12.0, "burst": 4, "rpm_min": 4.0,  "rpm_max": 300.0},
    "openai":      {"rpm": 60.0, "burst": 8, "rpm_min": 10.0, "rpm_max": 600.0},
    "anthropic":   {"rpm": 50.0, "burst": 8, "rpm_min": 10.0, "rpm_max": 400.0},
    "openrouter":  {"rpm": 60.0, "burst": 8, "rpm_min": 10.0, "rpm_max": 300.0},
    "groq":        {"rpm": 30.0, "burst": 6, "rpm_min": 6.0,  "rpm_max": 300.0},
    "together":    {"rpm": 60.0, "burst": 8, "rpm_min": 10.0, "rpm_max": 300.0},
    "deepseek":    {"rpm": 60.0, "burst": 8, "rpm_min": 10.0, "rpm_max": 300.0},
    "featherless": {"rpm": 30.0, "burst": 6, "rpm_min": 6.0,  "rpm_max": 150.0},
}

# Adaptive gate shape. Additive increase after a clean streak, multiplicative
# decrease on a provider 429 — the same discipline the extension's lane uses, so
# the two sides converge instead of fighting.
#
# The streak is the CEILING on how much evidence a step needs, not a fixed
# count. A fixed count is the wrong unit: 8 clean calls is 8 seconds of
# evidence at 60 rpm and 40 seconds at 12 rpm, so the slowest bucket — the one
# whose user is actually waiting — was made to prove itself five times harder
# than a fast one. `RATE_ADAPT_OK_WINDOW_SEC` turns it into a duration, and the
# streak follows from the rate: ceil(rpm * window / 60), clamped to
# [RATE_ADAPT_OK_STREAK_MIN, RATE_ADAPT_OK_STREAK].
#
# Measured on trace-20260819-191505 (86 pages, gemini free-tier policy): the
# old fixed streak spent 330 s of the batch's 478 s of AI time asleep on this
# gate, and only reached 54 rpm on the fourth chapter.
RATE_ADAPT_OK_STREAK: Final[int] = 8
RATE_ADAPT_OK_STREAK_MIN: Final[int] = 2
RATE_ADAPT_OK_WINDOW_SEC: Final[float] = 10.0
RATE_ADAPT_STEP_RPM: Final[float] = 6.0
RATE_ADAPT_BACKOFF: Final[float] = 0.5
# A bucket that has not been touched for this long has stale evidence, so it
# gives some of the learned rate back — it does NOT return to the starting rpm.
#
# Resetting all the way to the start was too expensive to be right. The cost of
# keeping a rate that is now too high is ONE provider 429, which
# `report_rate_limited` already halves on the same round trip; the cost of
# resetting was the entire ramp again — 40+ seconds of pacing for every lunch
# break. Decaying halves the evidence per idle window instead, with the
# provider's safe starting rpm as the floor.
RATE_ADAPT_IDLE_RESET_SEC: Final[float] = 900.0
RATE_ADAPT_IDLE_DECAY: Final[float] = 0.5


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
        "3-flash":      "gemini-3.6-flash",
        "3-pro":        "gemini-3.1-pro-preview",
        "3-pro-image":  "gemini-3-pro-image",
        "flash-image":  "gemini-2.5-flash-image",
        # Retired models → remap to the current equivalent so an old stored
        # selection keeps working instead of returning HTTP 404.
        "gemini-3-pro-preview":       "gemini-3.1-pro-preview",
        "gemini-3-pro-image-preview": "gemini-3-pro-image",
        "gemini-3-flash-preview":     "gemini-3.6-flash",
        "gemini-2.0-flash-lite":     "gemini-3.1-flash-lite",
        "gemini-2.0-flash":          "gemini-3.6-flash",
        "gemini-1.5-flash":      "gemini-2.5-flash",
        "gemini-1.5-flash-8b":   "gemini-2.5-flash-lite",
        "gemini-1.5-pro":        "gemini-2.5-pro",
    },
}


# Hard-coded model fallbacks used by /ai/resolve when the live endpoint
# enumeration returns nothing useful.
# Conservative Gemini fallback list aligned with the current official model/deprecation tables.
# Retired preview ids are remapped above instead of being offered here.
# ``gemini-flash-latest`` stays last as an auto-updating safety net.
GEMINI_FALLBACK_MODELS: Final[list[str]] = [
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-flash-latest",
]


HF_FALLBACK_MODELS: Final[list[str]] = [
    "google/gemma-3-27b-it:featherless-a",
    "google/gemma-3-27b-it",
    "google/gemma-2-2b-it",
    "google/gemma-2-9b-it",
]


# Models whose name matches this pattern get the COMPACT prompt tier:
# a short core-rule list + a full few-shot example instead of the long
# detailed rule set. Small/fast models imitate examples far better than
# they follow long instruction lists — and the compact prompt costs ~70%
# fewer input tokens. Pattern-based so new model names work automatically;
# edit the regex, never hardcode model lists elsewhere.
SMALL_MODEL_PATTERN: Final[str] = (
    r"flash|lite|mini|nano|tiny|small|haiku|gemma|phi-|qwen.{0,4}\b[0-9]b|(?:^|[^0-9])[1-9]b\b"
)


# AI sampling defaults.
# 0.2 made every model pick the safest = most LITERAL wording, which read as
# stiff machine translation no matter how good the style prompt was. Manga
# dialogue is creative writing — 0.7 gives natural, punchy lines while the
# <<TP_Pn>> marker protocol stays safe (contract + retry still enforce it).
TEMPERATURE: Final[float] = 0.7
# Manga pages can hit 20+ paragraphs and a Thai/CJK token is roughly a
# character, so a generous output cap is needed — 1200 used to truncate
# mid-paragraph and force the marker-repair fallback to fill the gaps with
# Lens text. Providers that don't support this much silently clamp to their
# own limit (Gemini 2.5 Flash allows up to 65k, Claude allows 8k+, etc.).
MAX_TOKENS: Final[int] = 8192
TIMEOUT_SEC: Final[float] = 120.0
