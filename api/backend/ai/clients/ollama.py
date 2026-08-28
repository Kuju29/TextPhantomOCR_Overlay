"""Native Ollama client.

Ollama resembles OpenAI in broad shape but its authoritative endpoints are
``/api/chat`` and ``/api/tags``. Keeping this separate prevents Ollama-specific
reasoning and content shapes from changing the contract of other local
runtimes.
"""

from __future__ import annotations

from typing import Any

import httpx

from backend.ai import config as ai_config
from backend.ai.clients.base import ChatResult
from backend.ai.clients.provider_error import safe_http_error


def normalize_base_url(base_url: str) -> str:
    """Return an Ollama server root, migrating a legacy trailing ``/v1``."""
    root = (base_url or "").strip().rstrip("/")
    if root.lower().endswith("/v1"):
        root = root[:-3].rstrip("/")
    return root


def _content_text(value: Any) -> str:
    """Losslessly join common Ollama text content shapes."""
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for part in value:
        if isinstance(part, str):
            text = part
        elif isinstance(part, dict):
            text = part.get("text") or part.get("content") or ""
        else:
            text = ""
        if isinstance(text, str) and text:
            parts.append(text)
    return "".join(parts).strip()


def _extract_text(data: dict) -> str:
    message = data.get("message") or {}
    text = _content_text(message.get("content")) if isinstance(message, dict) else ""
    done_reason = str(data.get("done_reason") or "").strip()
    if data.get("done") is True and done_reason and done_reason not in ("stop",):
        raise RuntimeError(f"Ollama response was incomplete (done_reason={done_reason})")
    if text:
        return text
    has_thinking = bool(
        isinstance(message, dict)
        and (message.get("thinking") or message.get("reasoning") or message.get("reasoning_content"))
    )
    if has_thinking:
        # Never include the reasoning itself: it can contain source dialogue,
        # private prompt context, or model chain-of-thought.
        suffix = f" (done_reason={done_reason})" if done_reason else ""
        raise RuntimeError(
            "Ollama returned thinking/reasoning but no final answer"
            f"{suffix}; turn AI thinking off or choose a compatible model"
        )
    suffix = f" (done_reason={done_reason})" if done_reason else ""
    raise RuntimeError(f"Ollama returned no final text{suffix}")


def _messages(
    system_text: str,
    user_parts: list[str],
    image_b64: str = "",
) -> list[dict]:
    messages: list[dict] = [{"role": "system", "content": system_text}]
    clean_parts = [part for part in user_parts if (part or "").strip()]
    if image_b64.strip():
        messages.append({
            "role": "user",
            "content": "\n".join(clean_parts),
            "images": [image_b64.strip()],
        })
    else:
        messages.extend({"role": "user", "content": part} for part in clean_parts)
    return messages


def list_models(base_url: str, *, timeout_sec: float = 3.0) -> list[str]:
    """Return installed Ollama model names from the native tags endpoint."""
    url = normalize_base_url(base_url) + "/api/tags"
    try:
        with httpx.Client(timeout=timeout_sec) as client:
            response = client.get(url)
    except httpx.RequestError as exc:
        raise RuntimeError(
            f"Ollama transport error (operation=list_models, errorType={type(exc).__name__})"
        ) from exc
    try:
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPStatusError as exc:
        raise safe_http_error("Ollama", response, "model-list") from exc
    except ValueError as exc:
        raise RuntimeError("Ollama model list returned invalid JSON") from exc
    if not isinstance(data, dict):
        raise RuntimeError("Ollama model list returned an invalid response shape")
    models: list[str] = []
    for item in data.get("models") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("model") or "").strip()
        if name:
            models.append(name)
    return models


def models_status(base_url: str, *, timeout_sec: float = 3.0) -> dict:
    """Enumerate tags while preserving settings-facing reachability status."""
    try:
        return {
            "models": list_models(base_url, timeout_sec=timeout_sec),
            "status": "valid",
            "http_status": 200,
            "error": "",
        }
    except RuntimeError as exc:
        text = str(exc)
        status = "unreachable" if "transport error" in text else "error"
        return {
            "models": [],
            "status": status,
            "http_status": 0,
            "error": text[:240],
        }


def generate(
    base_url: str,
    model: str,
    system_text: str,
    user_parts: list[str],
    *,
    image_b64: str = "",
    image_mime: str = "image/jpeg",
    response_schema: dict | None = None,
    thinking: str = "default",
) -> ChatResult:
    """POST exactly one non-streaming native Ollama chat request."""
    _ = image_mime  # Ollama accepts raw base64 and infers the image format.
    payload: dict[str, Any] = {
        "model": model,
        "messages": _messages(system_text, user_parts, image_b64),
        "stream": False,
        "options": {
            "temperature": ai_config.TEMPERATURE,
            "num_predict": ai_config.MAX_TOKENS,
        },
    }
    if response_schema:
        payload["format"] = response_schema
    thinking_mode = (thinking or "").strip().lower()
    if thinking_mode in {"off", "on"}:
        payload["think"] = thinking_mode == "on"

    url = normalize_base_url(base_url) + "/api/chat"
    try:
        with httpx.Client(timeout=ai_config.TIMEOUT_SEC) as client:
            response = client.post(url, json=payload, headers={"Content-Type": "application/json"})
    except httpx.RequestError as exc:
        raise RuntimeError(
            f"Ollama transport error (model={model}, attempts=1, "
            f"errorType={type(exc).__name__})"
        ) from exc
    try:
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPStatusError as exc:
        raise safe_http_error("Ollama", response, model) from exc
    except ValueError as exc:
        raise RuntimeError(f"Ollama returned invalid JSON (model={model})") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"Ollama returned an invalid response shape (model={model})")
    return ChatResult(text=_extract_text(data), used_model=model)
