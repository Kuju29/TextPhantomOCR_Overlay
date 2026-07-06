"""Google Gemini (generativelanguage.googleapis.com) chat client."""

from __future__ import annotations

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
    r = _post_once(api_key, model, payload)
    if _is_model_gone(r):
        fallback = (ai_config.PROVIDER_DEFAULTS.get("gemini") or {}).get("model", "") or "gemini-2.5-flash"
        if fallback and fallback != model:
            r2 = _post_once(api_key, fallback, payload)
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
        raise RuntimeError("Gemini returned no candidates")
    out_parts = (candidates[0].get("content") or {}).get("parts") or []
    if not out_parts:
        raise RuntimeError("Gemini returned empty content parts")
    text = "".join(str(p.get("text") or "") for p in out_parts).strip()
    if not text:
        raise RuntimeError("Gemini returned empty text")
    return ChatResult(text=text, used_model=model)
