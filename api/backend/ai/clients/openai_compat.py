"""OpenAI-compatible chat client.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Works against OpenAI itself plus every gateway that speaks the same
``/chat/completions`` dialect: OpenRouter, Groq, Together, DeepSeek,
Featherless and the Hugging Face router.

The Hugging Face router occasionally rejects a model with HTTP 400
``model_not_supported``.  When that happens *and* the caller allowed it
(``allow_hf_fallback=True``, i.e. the model was auto-selected, not chosen by
the user) we enumerate the router and retry once with a sensible fallback.
"""

from __future__ import annotations

import httpx

from backend.ai import config as ai_config
from backend.ai.clients.base import ChatResult
from backend.ai.providers import hf_router_models, pick_hf_fallback_model


def _build_payload(
    model: str,
    system_text: str,
    user_parts: list[str],
    image_b64: str = "",
    image_mime: str = "image/jpeg",
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
    return {
        "model": model,
        "messages": messages,
        "temperature": ai_config.TEMPERATURE,
        "max_tokens": ai_config.MAX_TOKENS,
    }


def _extract_text(data: dict) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("AI returned no choices")
    text = ((choices[0].get("message") or {}).get("content") or "").strip()
    if not text:
        raise RuntimeError("AI returned empty text")
    return text


def _is_hf_model_unsupported(response: httpx.Response, base_url: str) -> bool:
    if response.status_code != 400 or "router.huggingface.co" not in (base_url or ""):
        return False
    try:
        err = response.json().get("error") or {}
    except Exception:
        return False
    return (err.get("code") or "") == "model_not_supported"


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
) -> ChatResult:
    """POST a chat completion request and return ``(text, used_model)``."""
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = _build_payload(model, system_text, user_parts, image_b64, image_mime)

    with httpx.Client(timeout=ai_config.TIMEOUT_SEC) as client:
        r = client.post(url, json=payload, headers=headers)
        try:
            r.raise_for_status()
            return ChatResult(text=_extract_text(r.json()), used_model=model)
        except httpx.HTTPStatusError as e:
            if not (allow_hf_fallback and _is_hf_model_unsupported(r, base_url)):
                raise RuntimeError(f"AI HTTP {r.status_code}: {r.text}") from e

            # HF router: model unsupported — retry once with a fallback model.
            available = hf_router_models(api_key, base_url)
            fallback = pick_hf_fallback_model(available)
            if not fallback or fallback == model:
                preview = ", ".join(available[:8])
                hint = f"\nAvailable models (first 8): {preview}" if preview else ""
                raise RuntimeError(f"AI HTTP {r.status_code}: {r.text}{hint}") from e

            payload["model"] = fallback
            r2 = client.post(url, json=payload, headers=headers)
            try:
                r2.raise_for_status()
            except httpx.HTTPStatusError as e2:
                raise RuntimeError(f"AI HTTP {r2.status_code}: {r2.text}") from e2
            return ChatResult(text=_extract_text(r2.json()), used_model=fallback)
