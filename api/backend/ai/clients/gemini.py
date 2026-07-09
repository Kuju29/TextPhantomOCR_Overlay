"""Google Gemini (generativelanguage.googleapis.com) chat client."""

from __future__ import annotations

import random
import time

import httpx

from backend.ai import config as ai_config
from backend.ai.clients.base import ChatResult

_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"


def _is_model_gone(resp: "httpx.Response") -> bool:
    """True when a 404 means the requested model is retired / unknown."""
    if resp.status_code != 404:
        return False
    body = (resp.text or "").lower()
    return (
        "no longer available" in body
        or "not found" in body
        or "is not supported" in body
        or "models/" in body
    )


def _post_once(api_key: str, model: str, payload: dict) -> "httpx.Response":
    url = _ENDPOINT.format(model=model, key=api_key)
    with httpx.Client(timeout=ai_config.TIMEOUT_SEC) as client:
        return client.post(url, json=payload)


# Transient overload statuses worth a short retry.  Gemini frequently answers
# 503 "high demand" for a few seconds at a time; one or two spaced retries
# recover most of these without hammering the API.
_RETRYABLE_STATUS: tuple[int, ...] = (429, 500, 502, 503, 504)
_RETRY_DELAYS_SEC: tuple[float, ...] = (2.5, 6.0)


def _post_with_retry(api_key: str, model: str, payload: dict) -> "httpx.Response":
    r = _post_once(api_key, model, payload)
    for delay in _RETRY_DELAYS_SEC:
        if r.status_code not in _RETRYABLE_STATUS:
            return r
        time.sleep(delay + random.uniform(0.0, 1.0))
        r = _post_once(api_key, model, payload)
    return r


def generate(
    api_key: str,
    model: str,
    system_text: str,
    user_parts: list[str],
    *,
    image_b64: str = "",
    image_mime: str = "image/jpeg",
) -> ChatResult:
    """Call Gemini's ``generateContent`` and return the plain-text reply.

    Self-healing: if the requested model was retired by Google (404
    "no longer available"), retry once with the current default model.  This
    means a stale model name saved in the client (e.g. an old
    ``gemini-2.0-flash-lite``) recovers automatically instead of hard-failing.

    ``image_b64`` (optional) attaches the manga page as inline image data so
    a vision-capable model can see the speakers.
    """
    parts: list[dict] = []
    if (image_b64 or "").strip():
        parts.append({"inline_data": {"mime_type": image_mime or "image/jpeg", "data": image_b64}})
    parts.extend({"text": p} for p in user_parts if (p or "").strip())
    payload = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": ai_config.TEMPERATURE,
            "maxOutputTokens": ai_config.MAX_TOKENS,
            "responseMimeType": "text/plain",
        },
    }

    used = model
    r = _post_with_retry(api_key, model, payload)
    if _is_model_gone(r):
        fallback = (ai_config.PROVIDER_DEFAULTS.get("gemini") or {}).get("model", "") or "gemini-2.5-flash"
        if fallback and fallback != model:
            r2 = _post_with_retry(api_key, fallback, payload)
            # Only adopt the fallback response if it actually succeeded.
            if r2.status_code < 400:
                r = r2
                used = fallback
    try:
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Gemini HTTP {r.status_code}: {r.text}") from e
    data = r.json()
    model = used

    candidates = data.get("candidates") or []
    if not candidates:
        # No candidates usually means the provider refused the request.
        # Surface the real reason (e.g. SAFETY / PROHIBITED_CONTENT) so the
        # user can tell "content blocked by Google" from a broken model.
        feedback = data.get("promptFeedback") or {}
        block_reason = str(feedback.get("blockReason") or "").strip()
        if block_reason:
            raise RuntimeError(
                f"Gemini blocked this content (blockReason={block_reason}) — "
                "the provider refuses to translate it; this is not a bug"
            )
        raise RuntimeError("Gemini returned no candidates")
    out_parts = (candidates[0].get("content") or {}).get("parts") or []
    if not out_parts:
        finish = str(candidates[0].get("finishReason") or "").strip()
        if finish and finish != "STOP":
            raise RuntimeError(f"Gemini returned no content (finishReason={finish})")
        raise RuntimeError("Gemini returned empty content parts")
    text = "".join(str(p.get("text") or "") for p in out_parts).strip()
    if not text:
        raise RuntimeError("Gemini returned empty text")
    return ChatResult(text=text, used_model=model)
