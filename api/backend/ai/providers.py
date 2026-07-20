"""Provider/model resolution helpers.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

These functions answer questions like "which provider does this API key
belong to?" and "what is the real model name for ``auto``?".  They are pure
(no network) except for :func:`hf_router_models`, which enumerates a Hugging
Face router endpoint and is cached for an hour.
"""

from __future__ import annotations

import hashlib
import os
import time

import httpx

from backend.ai import config as ai_config  # noqa: F401 - kept for callers
from backend.ai.config import PROVIDER_ALIASES, PROVIDER_DEFAULTS, MODEL_ALIASES, LOCAL_PROVIDERS

# Listing models is a quick GET and must never wait the full *generation*
# timeout (TIMEOUT_SEC = 120 s). That hurt badly when a user picked a local
# provider (LM Studio / Ollama on THEIR machine): the server-side /ai/resolve
# hung for 120 s per call trying to reach an unreachable localhost/LAN URL,
# and the client retried every 2 minutes forever.
LIST_TIMEOUT_SEC: float = 10.0
LOCAL_LIST_TIMEOUT_SEC: float = 3.0

# Cache for hf_router_models: sha1(key|base_url) -> {"ts": float, "models": [...]}.
_HF_MODELS_CACHE: dict[str, dict] = {}
_HF_MODELS_TTL_SEC = 3600

# Environment variables checked, in order, when no explicit key is supplied.
_AI_KEY_ENV_NAMES = (
    "AI_API_KEY",
    "OPENAI_API_KEY",
    "HF_TOKEN",
    "HUGGINGFACEHUB_API_TOKEN",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "FEATHERLESS_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "DEEPSEEK_API_KEY",
    "ANTHROPIC_API_KEY",
)


def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def read_key_from_env() -> str:
    """Return the first non-empty AI key found in the known env vars."""
    for name in _AI_KEY_ENV_NAMES:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def detect_provider_from_key(api_key: str) -> str:
    """Guess the provider from an API key's prefix.

    Defaults to ``"openai"`` because most third-party gateways use the
    OpenAI-compatible ``sk-...`` style key.
    """
    k = (api_key or "").strip()
    if k.startswith("AIza"):
        return "gemini"
    if k.startswith("hf_"):
        return "huggingface"
    if k.startswith("sk-or-"):
        return "openrouter"
    if k.startswith("sk-ant-"):
        return "anthropic"
    if k.startswith("gsk_"):
        return "groq"
    return "openai"


def canonical_provider(provider: str) -> str:
    """Map provider aliases (``hf`` -> ``huggingface`` etc.) to canonical form."""
    p = (provider or "").strip().lower()
    return PROVIDER_ALIASES.get(p, p)


def is_local_provider(provider: str) -> bool:
    """True for self-hosted OpenAI-compatible servers (Ollama, LM Studio, …).

    Local providers run on the user's machine and require NO API key.
    """
    return canonical_provider(provider) in LOCAL_PROVIDERS


def resolve_provider(provider: str, api_key: str) -> str:
    """Resolve ``"auto"`` / empty providers using the key prefix."""
    p = canonical_provider(provider or "auto")
    if p in ("", "auto"):
        p = detect_provider_from_key(api_key)
    return p


def resolve_model(provider: str, model: str) -> str:
    """Turn ``"auto"`` / aliases into a concrete model name for ``provider``."""
    m = (model or "").strip()
    if not m or m.lower() == "auto":
        default = (PROVIDER_DEFAULTS.get(provider) or {}).get("model", "")
        return default.strip() or PROVIDER_DEFAULTS["openai"]["model"]
    aliases = MODEL_ALIASES.get(provider) or {}
    return aliases.get(m.lower()) or m


def resolve_base_url(provider: str, base_url: str) -> str:
    """Resolve ``"auto"`` / empty base URLs.

    Gemini and Anthropic use SDK-style endpoints so they get an empty string;
    every other (OpenAI-compatible) provider gets a concrete ``/v1`` URL,
    falling back to OpenAI's if the provider is unknown.
    """
    b = (base_url or "auto").strip()
    if b in ("", "auto"):
        b = (PROVIDER_DEFAULTS.get(provider) or {}).get("base_url", "").strip()
    if provider not in ("gemini", "anthropic") and not b:
        b = PROVIDER_DEFAULTS["openai"]["base_url"]
    return b


def hf_router_models(api_key: str, base_url: str) -> list[str]:
    """List models available on a Hugging Face router endpoint (cached 1h)."""
    if not api_key or not base_url:
        return []

    cache_key = _sha1(f"{_sha1(api_key)}|{base_url}")
    now = time.time()
    cached = _HF_MODELS_CACHE.get(cache_key) or {}
    if (
        cached.get("ts")
        and now - float(cached["ts"]) < _HF_MODELS_TTL_SEC
        and isinstance(cached.get("models"), list)
    ):
        return cached["models"]

    url = base_url.rstrip("/") + "/models"
    try:
        with httpx.Client(timeout=LIST_TIMEOUT_SEC) as client:
            r = client.get(url, headers={"Authorization": f"Bearer {api_key}"})
            r.raise_for_status()
            data = r.json()
    except Exception:
        return []

    models: list[str] = []
    for m in data.get("data") or []:
        mid = m.get("id") if isinstance(m, dict) else None
        if isinstance(mid, str) and mid.strip():
            models.append(mid.strip())

    _HF_MODELS_CACHE[cache_key] = {"ts": now, "models": models}
    return models


def pick_hf_fallback_model(models: list[str]) -> str:
    """Choose a reasonable instruct model from a HF router model list."""
    if not models:
        return ""
    priority = ("gemma-3", "gemma-2", "llama-3.1", "llama-3", "mistral", "qwen", "glm")
    lowered = [(m, m.lower()) for m in models]
    for sub in priority:
        for original, low in lowered:
            if sub in low and ("instruct" in low or low.endswith("-it") or ":" in low):
                return original
    for original, low in lowered:
        if "instruct" in low or low.endswith("-it") or ":" in low:
            return original
    return models[0]


def openai_compat_models(
    api_key: str, base_url: str, timeout_sec: float = LIST_TIMEOUT_SEC
) -> list[str]:
    """Enumerate models from any OpenAI-compatible ``/models`` endpoint.

    Returns an empty list on any error — callers fall back to static defaults.
    """
    if not api_key or not base_url:
        return []
    url = base_url.rstrip("/") + "/models"
    try:
        with httpx.Client(timeout=timeout_sec) as client:
            r = client.get(url, headers={"Authorization": f"Bearer {api_key}"})
            r.raise_for_status()
            data = r.json()
    except Exception:
        return []
    models: list[str] = []
    for m in data.get("data") or []:
        mid = m.get("id") if isinstance(m, dict) else None
        if isinstance(mid, str) and mid.strip():
            models.append(mid.strip())
    return models


# Model-name fragments that can never do text translation (or are retired but
# still returned by Google's ListModels). Filtered out of the picker so the
# dropdown only offers models that actually work for this job.
_GEMINI_EXCLUDE_FRAGMENTS: tuple[str, ...] = (
    "-tts",            # speech output
    "-image",          # image generation
    "computer-use",    # browser-agent models
    "deep-research",   # long-running research agents (not chat translation)
    "antigravity",     # IDE/agent preview line
    "embedding",       # vectors, no text generation
    "aqa",             # attributed QA
    "-live-",          # realtime audio/video
    "learnlm",         # education previews
    # Retired families still present in ListModels after shutdown. Covers all
    # variants (-001, -lite, -8b, ...) that the alias table can't list one by
    # one. Calling any of them answers 404 "no longer available".
    "gemini-1.0",
    "gemini-1.5",
    "gemini-2.0",
)


def _gemini_model_usable(model_id: str) -> bool:
    """Translation-usable Gemini model: chat-capable, not retired, not a tool."""
    m = (model_id or "").strip().lower()
    if not m:
        return False
    if any(frag in m for frag in _GEMINI_EXCLUDE_FRAGMENTS):
        return False
    # Names our alias table marks as retired still show up in ListModels for a
    # while after shutdown — hide them; picking one would silently remap anyway.
    if m in (MODEL_ALIASES.get("gemini") or {}):
        return False
    return True


def gemini_models(api_key: str) -> list[str]:
    """Enumerate Gemini models that support ``generateContent``.

    Filters out retired names (per ``MODEL_ALIASES``) and non-translation
    model families (TTS / image / computer-use / research / embeddings), so
    the client's model picker only lists models that will actually answer a
    translation prompt.
    """
    if not api_key:
        return []
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    try:
        with httpx.Client(timeout=LIST_TIMEOUT_SEC) as client:
            r = client.get(url)
            r.raise_for_status()
            data = r.json()
    except Exception:
        return []
    models: list[str] = []
    for m in data.get("models") or []:
        if not isinstance(m, dict):
            continue
        methods = m.get("supportedGenerationMethods") or []
        name = str(m.get("name") or "")
        if "generateContent" not in methods or not name.startswith("models/"):
            continue
        model_id = name.split("/", 1)[1]
        if _gemini_model_usable(model_id):
            models.append(model_id)
    return models


# Non-chat fragments common across OpenAI-compatible providers: their /models
# endpoints list EVERYTHING the account can reach (speech, embeddings, image
# generation, moderation...), none of which can answer a translation prompt.
_GENERIC_EXCLUDE_FRAGMENTS: tuple[str, ...] = (
    "whisper",
    "-tts",
    "tts-",
    "dall-e",
    "moderation",
    "embed",       # embedding / text-embedding / *-embed-*
    "-audio",
    "realtime",
    "transcribe",
    "speech",
    "-image",      # image-generation variants (e.g. */gemini-2.5-flash-image)
    "clip-",
    "rerank",
)


def filter_chat_models(provider: str, models: list[str]) -> list[str]:
    """Drop non-chat and retired entries from a provider's live model list.

    Local servers (Ollama / LM Studio / ...) are never filtered — users name
    their local models freely. If filtering would empty the list entirely,
    the original list is returned (never hide everything on a bad heuristic).
    """
    prov = canonical_provider(provider or "")
    if is_local_provider(prov):
        return models
    aliases = MODEL_ALIASES.get(prov) or {}
    out: list[str] = []
    for mid in models:
        m = (mid or "").strip().lower()
        if not m or m in aliases:
            continue
        if any(frag in m for frag in _GENERIC_EXCLUDE_FRAGMENTS):
            continue
        out.append(mid)
    return out or models


def is_hf_provider(provider: str, base_url: str) -> bool:
    """True when the request targets the Hugging Face router."""
    return (provider or "").strip().lower() == "huggingface" or (
        "router.huggingface.co" in (base_url or "").strip().lower()
    )
