"""Google Gemini (generativelanguage.googleapis.com) chat client.

"""

from __future__ import annotations

import hashlib
import os

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
# Pro models are never touched (thinking can't be disabled there). Unknown
# models are also left untouched: request options are selected before the one
# provider call and are never changed after an error.
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


def _post_once(api_key: str, model: str, payload: dict) -> "httpx.Response":
    url = _ENDPOINT.format(model=model, key=api_key)
    with httpx.Client(timeout=ai_config.TIMEOUT_SEC) as client:
        return client.post(url, json=payload)


def _supports_native_schema(model: str) -> bool:
    """Return a conservative, offline Gemini structured-output decision.

    Only model families explicitly documented by Google's generateContent
    structured-output guide are enabled. Unknown aliases and future model ids
    use the JSON contract in the prompt without a transport schema; capability
    discovery must never be performed by sending a request that may need a
    second request.
    """
    m = (model or "").strip().lower()
    known = (
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-3-flash-preview",
        "gemini-3.1-pro-preview",
        "gemini-3.1-flash-lite",
        "gemini-3.1-flash-lite-preview",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
    )
    return m in known


def _uses_response_format(model: str) -> bool:
    """True for supported Gemini 3 models using the current wire envelope."""
    return _supports_native_schema(model) and (model or "").strip().lower().startswith(
        "gemini-3"
    )


_LEGACY_SCHEMA_KEYS = frozenset(
    {
        "type",
        "properties",
        "required",
        "items",
        "enum",
        "minItems",
        "maxItems",
        "description",
    }
)


def _legacy_response_schema(schema: dict) -> dict:
    """Project JSON Schema onto Gemini's legacy OpenAPI ``Schema`` subset.

    Gemini 2.5's ``generationConfig.responseSchema`` is not an arbitrary JSON
    Schema value. In particular it rejects ``additionalProperties`` at request
    validation time. Build a fresh provider-specific tree so the canonical
    contract remains unchanged for local validation and newer providers.
    """

    def project(value: dict) -> dict:
        out: dict = {}
        for key, item in value.items():
            if key not in _LEGACY_SCHEMA_KEYS:
                continue
            if key == "properties" and isinstance(item, dict):
                # Property names are application data, not schema keywords.
                out[key] = {
                    name: project(child)
                    for name, child in item.items()
                    if isinstance(child, dict)
                }
            elif key == "items" and isinstance(item, dict):
                out[key] = project(item)
            elif isinstance(item, list):
                out[key] = list(item)
            else:
                out[key] = item
        properties = out.get("properties")
        if isinstance(properties, dict) and properties:
            # Gemini uses this non-standard field to retain deterministic JSON
            # object ordering. Python dict insertion order matches the prompt.
            out["propertyOrdering"] = list(properties)
        return out

    return project(schema)


def generate(
    api_key: str,
    model: str,
    system_text: str,
    user_parts: list[str],
    *,
    image_b64: str = "",
    image_mime: str = "image/jpeg",
    thinking: str = "",
    response_schema: dict | None = None,
) -> ChatResult:
    """Call Gemini's ``generateContent`` exactly once and return its reply.

    The requested model and request options are immutable. Provider errors are
    surfaced to the caller; this client never retries, substitutes a model, or
    removes schema/thinking options after a failed request.

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
    use_schema = bool(response_schema) and _supports_native_schema(model)
    if use_schema:
        if _uses_response_format(model):
            # Current generateContent wire contract documented for Gemini 3.
            payload["generationConfig"].pop("responseMimeType", None)
            payload["generationConfig"]["responseFormat"] = {
                "text": {"mimeType": "application/json", "schema": response_schema}
            }
        else:
            payload["generationConfig"]["responseMimeType"] = "application/json"
            payload["generationConfig"]["responseSchema"] = _legacy_response_schema(
                response_schema
            )
    thinking_cfg = _thinking_config_for(model, thinking)
    if thinking_cfg is not None:
        payload["generationConfig"]["thinkingConfig"] = thinking_cfg

    try:
        r = _post_once(api_key, model, payload)
    except httpx.RequestError as e:
        # Gemini puts the credential in its request URL. Never propagate the
        # provider exception string because it may contain that URL.
        raise RuntimeError(
            f"Gemini transport error (model={model}, attempts=1, "
            f"errorType={type(e).__name__})"
        ) from e
    try:
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        # Never expose the response body: some gateways echo request content.
        # Length + digest are enough to correlate identical provider failures.
        response_body = r.text or ""
        response_sha256 = hashlib.sha256(response_body.encode("utf-8")).hexdigest()
        raise RuntimeError(
            f"Gemini HTTP {r.status_code} (model={model}, attempts=1, "
            f"responseBodyChars={len(response_body)}, "
            f"responseBodySha256={response_sha256})"
        ) from e
    data = r.json()

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
    finish = str(candidates[0].get("finishReason") or "").strip()
    if finish and finish != "STOP":
        raise RuntimeError(f"Gemini response was incomplete (finishReason={finish})")
    out_parts = (candidates[0].get("content") or {}).get("parts") or []
    if not out_parts:
        if finish and finish != "STOP":
            raise RuntimeError(f"Gemini returned no content (finishReason={finish})")
        raise RuntimeError("Gemini returned empty content parts")
    text = "".join(str(p.get("text") or "") for p in out_parts).strip()
    if not text:
        raise RuntimeError("Gemini returned empty text")
    return ChatResult(text=text, used_model=model)
