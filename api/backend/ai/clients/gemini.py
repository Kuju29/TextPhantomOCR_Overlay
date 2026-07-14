"""Google Gemini (generativelanguage.googleapis.com) chat client."""

from __future__ import annotations

import os
import random
import time

import httpx

from backend.ai import config as ai_config
from backend.ai.clients.base import ChatResult

_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"

# Per-request "thinking" control, set from the extension UI (ai.thinking):
#   default -> model thinks normally, nothing is sent          [DEFAULT]
#   off     -> fastest: thinkingBudget 0 (2.5 flash family) or
#              thinkingLevel "low" (gemini-3 previews; can't fully disable)
# Measured impact of "off": ai_ms drops from 6-22 s to ~1.5-3 s per page, at
# essentially unchanged translation quality — but the choice is the user's.
# TP_GEMINI_THINKING sets the server-wide default when a request doesn't say;
# TP_GEMINI_THINKING_BUDGET / TP_GEMINI_THINKING_LEVEL tune the "off" values.
# Pro models are never touched (thinking can't be disabled there), and a 400
# answer mentioning "thinking" drops the config and retries once, so unknown/
# future models can never hard-fail because of this option.
_THINKING_DEFAULT = (os.environ.get("TP_GEMINI_THINKING", "default") or "default").strip().lower()
_THINKING_LEVEL = (os.environ.get("TP_GEMINI_THINKING_LEVEL", "low") or "low").strip().lower()
try:
    _THINKING_BUDGET = int(os.environ.get("TP_GEMINI_THINKING_BUDGET", "0"))
except ValueError:
    _THINKING_BUDGET = 0

_THINKING_OFF_MODES = ("off", "fast", "none", "0", "false", "no")


def _thinking_config_for(model: str, mode: str = "") -> dict | None:
    mode = (mode or "").strip().lower() or _THINKING_DEFAULT
    if mode not in _THINKING_OFF_MODES:
        return None  # "default"/unknown -> leave the model's thinking alone
    m = (model or "").lower()
    if "pro" in m:
        return None
    if "gemini-3" in m or m.startswith("3-"):
        return {"thinkingLevel": _THINKING_LEVEL}
    if "2.5" in m or "flash-latest" in m:
        return {"thinkingBudget": max(0, _THINKING_BUDGET)}
    return None


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
    thinking: str = "",
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
    # ``system_text`` opens with the static prefix (SYSTEM_BASE + style +
    # worked examples) and ends with the per-page bits, so Gemini 2.x implicit
    # caching automatically reuses that shared prefix across pages of a series —
    # no explicit cachedContent call needed.
    payload = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": ai_config.TEMPERATURE,
            "maxOutputTokens": ai_config.MAX_TOKENS,
            "responseMimeType": "text/plain",
        },
    }
    thinking_cfg = _thinking_config_for(model, thinking)
    if thinking_cfg is not None:
        payload["generationConfig"]["thinkingConfig"] = thinking_cfg

    used = model
    r = _post_with_retry(api_key, model, payload)
    # Safety net: a model that rejects thinkingConfig (naming variants, future
    # API changes) answers 400 — drop the config and retry once.
    if thinking_cfg is not None and r.status_code == 400 and "thinking" in (r.text or "").lower():
        payload["generationConfig"].pop("thinkingConfig", None)
        thinking_cfg = None
        r = _post_with_retry(api_key, model, payload)
    if _is_model_gone(r):
        fallback = (ai_config.PROVIDER_DEFAULTS.get("gemini") or {}).get("model", "") or "gemini-2.5-flash"
        if fallback and fallback != model:
            # Recompute the thinking config for the FALLBACK model — it may be
            # a different family than the retired one the user had stored.
            fb_thinking = _thinking_config_for(fallback, thinking)
            if fb_thinking is not None:
                payload["generationConfig"]["thinkingConfig"] = fb_thinking
            else:
                payload["generationConfig"].pop("thinkingConfig", None)
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
