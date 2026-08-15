"""OpenAI-compatible chat client.


Works against OpenAI itself plus every gateway that speaks the same
``/chat/completions`` dialect: OpenRouter, Groq, Together, DeepSeek,
Featherless and the Hugging Face router.

Every invocation performs exactly one HTTP generation request. The requested
model is never substituted and unsupported transport options are never removed
and resent after an error.
"""

from __future__ import annotations

import re

import httpx

from backend.ai import config as ai_config
from backend.ai.clients.base import ChatResult


def _is_official_openai(base_url: str) -> bool:
    base = (base_url or "").strip().lower().rstrip("/")
    return base in ("https://api.openai.com", "https://api.openai.com/v1")


def _uses_reasoning_safe_parameters(base_url: str, model: str) -> bool:
    """Preselect parameters accepted by OpenAI reasoning model families."""
    if not _is_official_openai(base_url):
        return False
    m = (model or "").strip().lower()
    return m == "gpt-5" or m.startswith("gpt-5-") or m.startswith("gpt-5.") or bool(
        re.match(r"^o(?:1|3|4)(?:-|$)", m)
    )


def _supports_native_schema(base_url: str, model: str) -> bool:
    """Conservatively enable JSON Schema only on OpenAI's own endpoint.

    OpenAI-compatible gateways and local servers vary even when they expose a
    model with the same name, so they remain prompt-only. This is an offline
    preflight decision and never probes the provider by making a request.
    """
    if not _is_official_openai(base_url):
        return False
    m = (model or "").strip().lower()
    dated_4o_mini = re.fullmatch(r"gpt-4o-mini-(\d{4})-(\d{2})-(\d{2})", m)
    supported_4o_mini_snapshot = bool(
        dated_4o_mini
        and tuple(int(part) for part in dated_4o_mini.groups()) >= (2024, 7, 18)
    )
    dated_4o = re.fullmatch(r"gpt-4o-(\d{4})-(\d{2})-(\d{2})", m)
    supported_4o_snapshot = bool(
        dated_4o
        and tuple(int(part) for part in dated_4o.groups()) >= (2024, 8, 6)
    )
    return (
        m == "gpt-4o-mini"
        or supported_4o_mini_snapshot
        or m == "gpt-4o"
        or supported_4o_snapshot
        or m == "gpt-4.1"
        or m.startswith("gpt-4.1-")
        or m == "gpt-5"
        or m.startswith("gpt-5-")
        or m.startswith("gpt-5.")
    )


def _build_payload(
    model: str,
    system_text: str,
    user_parts: list[str],
    image_b64: str = "",
    image_mime: str = "image/jpeg",
    response_schema: dict | None = None,
    reasoning_safe_parameters: bool = False,
) -> dict:
    # The system message opens with the static prefix (SYSTEM_BASE + style +
    # worked examples) that is identical across pages of a series, so providers
    # with automatic prefix caching (OpenAI, DeepSeek, Groq, …) reuse it for
    # free. Providers without it simply pay full price, unchanged.
    messages: list[dict] = [{"role": "system", "content": system_text}]
    if (image_b64 or "").strip():
        # Vision request: one user message with an image part + text parts
        # (OpenAI-style content array; supported by OpenAI, OpenRouter, Groq,
        # and most local servers with vision models).
        content: list[dict] = [
            {
                "type": "image_url",
                "image_url": {"url": f"data:{image_mime or 'image/jpeg'};base64,{image_b64}"},
            }
        ]
        content.extend({"type": "text", "text": p} for p in user_parts if (p or "").strip())
        messages.append({"role": "user", "content": content})
    else:
        messages.extend(
            {"role": "user", "content": p} for p in user_parts if (p or "").strip()
        )
    payload = {"model": model, "messages": messages}
    if reasoning_safe_parameters:
        # OpenAI reasoning families use the completion-token limit and can
        # reject non-default sampling controls. Decide before the sole call.
        payload["max_completion_tokens"] = ai_config.MAX_TOKENS
    else:
        payload["temperature"] = ai_config.TEMPERATURE
        payload["max_tokens"] = ai_config.MAX_TOKENS
    if response_schema:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "textphantom_translation",
                "strict": True,
                "schema": response_schema,
            },
        }
    return payload


def _extract_text(data: dict) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("AI returned no choices")
    finish = str(choices[0].get("finish_reason") or "").strip()
    if finish and finish != "stop":
        raise RuntimeError(f"AI response was incomplete (finish_reason={finish})")
    text = ((choices[0].get("message") or {}).get("content") or "").strip()
    if not text:
        raise RuntimeError("AI returned empty text")
    return text


def generate(
    api_key: str,
    base_url: str,
    model: str,
    system_text: str,
    user_parts: list[str],
    *,
    allow_hf_fallback: bool = False,
    image_b64: str = "",
    image_mime: str = "image/jpeg",
    response_schema: dict | None = None,
) -> ChatResult:
    """POST exactly one chat completion request using the requested model."""
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    # Kept for public-call compatibility. A caller may still pass this legacy
    # flag, but one-attempt mode intentionally never performs HF substitution.
    _ = allow_hf_fallback
    use_schema = bool(response_schema) and _supports_native_schema(base_url, model)
    reasoning_safe = _uses_reasoning_safe_parameters(base_url, model)
    payload = _build_payload(
        model, system_text, user_parts, image_b64, image_mime,
        response_schema if use_schema else None,
        reasoning_safe_parameters=reasoning_safe,
    )

    try:
        with httpx.Client(timeout=ai_config.TIMEOUT_SEC) as client:
            r = client.post(url, json=payload, headers=headers)
    except httpx.RequestError as e:
        raise RuntimeError(
            f"AI transport error (model={model}, attempts=1, "
            f"errorType={type(e).__name__})"
        ) from e
    try:
        r.raise_for_status()
        return ChatResult(text=_extract_text(r.json()), used_model=model)
    except httpx.HTTPStatusError as e:
        raise RuntimeError(
            f"AI HTTP {r.status_code} (model={model}, attempts=1)"
        ) from e
