"""Anthropic (api.anthropic.com) chat client.

"""

from __future__ import annotations

import httpx

from backend.ai import config as ai_config
from backend.ai.clients.base import ChatResult

_ENDPOINT = "https://api.anthropic.com/v1/messages"
_API_VERSION = "2023-06-01"


def _is_model_or_snapshot(model: str, prefix: str) -> bool:
    m = (model or "").strip().lower()
    return m == prefix or m.startswith(prefix + "-")


def _supports_native_schema(model: str) -> bool:
    """Return true only for Claude families with documented output_config.

    Sonnet/Opus/Haiku 4.5 and subsequent explicitly known releases support
    native structured outputs. Older and unknown models keep the same JSON
    contract in the prompt but receive no transport-level output_config.
    """
    m = (model or "").strip().lower()
    supported_starts = (
        "claude-sonnet-4-5",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "claude-opus-4-5",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-haiku-4-5",
        "claude-fable-5",
        "claude-mythos-5",
        "claude-mythos-preview",
    )
    return any(_is_model_or_snapshot(m, prefix) for prefix in supported_starts)


def _accepts_temperature(model: str) -> bool:
    """Whether a non-default sampling temperature is accepted by Claude.

    Anthropic documents that Opus 4.7+, Sonnet 5, Fable 5, Mythos 5, and
    Mythos Preview reject non-default temperature values. The decision is made
    before the sole HTTP call; there is no send-fail-strip-resend negotiation.
    """
    rejects_sampling = (
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-mythos-5",
        "claude-mythos-preview",
    )
    return not any(_is_model_or_snapshot(model, prefix) for prefix in rejects_sampling)


def _build_system_field(
    system_text: str, system_static: str, system_dynamic: str
) -> str | list[dict]:
    """Return the Messages API ``system`` field, with prompt caching when possible.

    When the caller supplies the ``static`` / ``dynamic`` split, the large static
    prefix (SYSTEM_BASE + editable style + worked examples — identical for every
    page of a series) is sent as its own block with ``cache_control: ephemeral``.
    Anthropic then serves it from cache on later pages at ~10% of the input-token
    cost, while the small per-page ``dynamic`` block (character sheet, glossary,
    marker contract) stays uncached and cheap. Falls back to the plain string when
    no split is given (e.g. the CLI) or the static part is too small to cache.
    """
    static = (system_static or "").strip()
    dynamic = (system_dynamic or "").strip()
    if not static:
        return system_text
    blocks: list[dict] = [
        {"type": "text", "text": static, "cache_control": {"type": "ephemeral"}}
    ]
    if dynamic:
        blocks.append({"type": "text", "text": dynamic})
    return blocks


def generate(
    api_key: str,
    model: str,
    system_text: str,
    user_parts: list[str],
    *,
    image_b64: str = "",
    image_mime: str = "image/jpeg",
    system_static: str = "",
    system_dynamic: str = "",
    response_schema: dict | None = None,
) -> ChatResult:
    """Call Anthropic's Messages API exactly once and return its reply.

    ``image_b64`` (optional) attaches the manga page as an image content block
    so a vision-capable model can see the speakers.

    ``system_static`` / ``system_dynamic`` (optional) are the cacheable prefix
    and per-page suffix from :func:`backend.ai.prompts.build_system_split`. When
    supplied, the static prefix is marked with ``cache_control`` so repeated
    pages of the same series reuse it cheaply. When omitted, ``system_text`` is
    sent verbatim.
    """
    if (image_b64 or "").strip():
        content: list[dict] = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image_mime or "image/jpeg",
                    "data": image_b64,
                },
            }
        ]
        content.extend(
            {"type": "text", "text": p} for p in user_parts if (p or "").strip()
        )
        messages = [{"role": "user", "content": content}]
    else:
        messages = [{"role": "user", "content": p} for p in user_parts if (p or "").strip()]
    payload = {
        "model": model,
        "max_tokens": ai_config.MAX_TOKENS,
        "system": _build_system_field(system_text, system_static, system_dynamic),
        "messages": messages,
    }
    if _accepts_temperature(model):
        payload["temperature"] = ai_config.TEMPERATURE
    use_schema = bool(response_schema) and _supports_native_schema(model)
    if use_schema:
        payload["output_config"] = {
            "format": {"type": "json_schema", "schema": response_schema}
        }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": _API_VERSION,
        "content-type": "application/json",
    }

    try:
        with httpx.Client(timeout=ai_config.TIMEOUT_SEC) as client:
            r = client.post(_ENDPOINT, json=payload, headers=headers)
    except httpx.RequestError as e:
        raise RuntimeError(
            f"Anthropic transport error (model={model}, attempts=1, "
            f"errorType={type(e).__name__})"
        ) from e
    try:
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise RuntimeError(
            f"Anthropic HTTP {r.status_code} (model={model}, attempts=1)"
        ) from e
    data = r.json()

    stop_reason = str(data.get("stop_reason") or "").strip()
    if stop_reason and stop_reason not in ("end_turn", "stop_sequence"):
        raise RuntimeError(f"Anthropic response was incomplete (stop_reason={stop_reason})")

    content = data.get("content") or []
    text = "".join(
        c.get("text") or ""
        for c in content
        if isinstance(c, dict) and c.get("type") == "text"
    ).strip()
    if not text:
        raise RuntimeError("Anthropic returned empty text")
    return ChatResult(text=text, used_model=model)
