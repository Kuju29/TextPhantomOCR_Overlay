"""Official OpenAI provider: identity, models and request policy."""

from __future__ import annotations
from functools import partial
from typing import Any

import re, httpx

from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.providers.provider_helpers import resolve_alias
from backend.ai.transports.openai_chat import execute_chat_completion

PROVIDER_ID = "openai"
DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-5.6-luna"
ALIASES = ("openai_compat", "openai-compatible")
MODEL_ALIASES = {
    "gpt5": "gpt-5",
    "gpt5-mini": "gpt-5-mini",
    "gpt4o": "gpt-4o",
    "gpt4o-mini": "gpt-4o-mini",
}
TEMPERATURE = 0.7
MAX_OUTPUT_TOKENS = 8192

resolve_model = partial(resolve_alias, aliases=MODEL_ALIASES, default=DEFAULT_MODEL)

_NON_CHAT_MODEL_FRAGMENTS = (
    "embedding", "moderation", "image", "dall-e", "sora", "tts",
    "whisper", "transcribe", "realtime", "audio", "computer-use",
    "search-preview", "deep-research",
)

def filter_model_items(items) -> list[str]:
    """Conservative Chat Completions candidates from OpenAI's broad /models list.

    OpenAI's model-list object does not publish endpoint compatibility, so the
    picker must not expose obvious embedding/image/audio/realtime/etc models.
    The selected remaining model is still verified with a live chat probe.
    """
    models: list[str] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        lowered = model_id.lower()
        if any(fragment in lowered for fragment in _NON_CHAT_MODEL_FRAGMENTS):
            continue
        # TextPhantom's official OpenAI adapter owns GPT/O-series chat models
        # and fine-tunes whose base id is one of those families.
        candidate = lowered.split(":", 2)[1] if lowered.startswith("ft:") and ":" in lowered else lowered
        if candidate.startswith("gpt-") or re.match(r"^o(?:1|3|4)(?:-|$)", candidate):
            models.append(model_id)
    return models

def _reasoning_family(model: str) -> bool:
    value = model.lower()
    return value == "gpt-5" or value.startswith(("gpt-5-", "gpt-5.")) or bool(
        re.match(r"^o(?:1|3|4)(?:-|$)", value)
    )

def _native_schema(model: str) -> bool:
    value = model.lower()
    snapshot = re.fullmatch(r"gpt-4o(?:-mini)?-(\d{4})-(\d{2})-(\d{2})", value)
    supported_snapshot = bool(snapshot and tuple(map(int, snapshot.groups())) >=
                              ((2024, 7, 18) if "mini" in value else (2024, 8, 6)))
    return supported_snapshot or value in {"gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-5"} or value.startswith(("gpt-4.1-", "gpt-5-", "gpt-5."))

def _budget(request: GenerationRequest, reasoning: bool) -> int:
    chars = sum(len(part) for part in request.user_parts)
    units = max(1, int(request.unit_count or len([p for p in request.user_parts if p.strip()])))
    answer = int(chars * 2.2) + units * 112 + 384
    hidden = min(4096, 768 + units * 128 + int(len(request.system_text) * .04)) if reasoning else 0
    from backend.ai.workload import guard_request_budget
    return guard_request_budget(request, max(1024, min(MAX_OUTPUT_TOKENS, answer + hidden)))

def prepare_payload(request: GenerationRequest) -> dict[str, Any]:
    """Build the official OpenAI payload without transport side effects."""
    model = resolve_model(request.model)
    system_text = request.system_text
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_text}]
    source_text = "\n\n".join(part for part in request.user_parts if part != "")
    if request.image_b64.strip():
        content = [{"type": "image_url", "image_url": {"url": f"data:{request.image_mime or 'image/jpeg'};base64,{request.image_b64}"}}]
        if source_text:
            content.append({"type": "text", "text": source_text})
        messages.append({"role": "user", "content": content})
    else:
        if source_text:
            messages.append({"role": "user", "content": source_text})
    reasoning = _reasoning_family(model)
    payload: dict[str, Any] = {"model": model, "messages": messages}
    if reasoning:
        payload["max_completion_tokens"] = _budget(request, True)
    else:
        payload.update(temperature=TEMPERATURE, max_tokens=_budget(request, False))
    if request.response_schema:
        if not _native_schema(model):
            raise ValueError("OpenAI model was not selected for native JSON schema")
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "textphantom_translations", "strict": True,
                            "schema": dict(request.response_schema)},
        }
    return payload

class OpenAIAdapter:
    def probe(self, request: ProbeRequest) -> ProbeResponse:
        extra = {"max_completion_tokens": 256} if _reasoning_family(resolve_model(request.model)) else {}
        return openai_chat_probe(request, payload_extra=extra or None)

    def generate(self, request: GenerationRequest):
        model = resolve_model(request.model)
        base = (request.base_url or DEFAULT_BASE_URL).rstrip("/")
        headers = {"Content-Type": "application/json"}
        if request.api_key:
            headers["Authorization"] = f"Bearer {request.api_key}"
        payload = prepare_payload(request)
        return execute_chat_completion(
            url=base + "/chat/completions", headers=headers, payload=payload,
            model=model, provider_id=PROVIDER_ID, timeout=120.0,
            timeout_policy="provider_total_bounded",
            expected_ids=list(request.expected_ids), cancel_check=request.cancel_check,
            trace_event="openai.generate", trace_file="ai/providers/cloud_openai.py",
            trace_fields={"requestedOutputTokens": payload.get("max_completion_tokens", payload.get("max_tokens")),
                          "reasoningPolicyApplied": "reasoning_budget" if _reasoning_family(model) else "standard"},
        )

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        if not api_key:
            return ModelListResult(status="missing")
        headers = {"Authorization": f"Bearer {api_key}"}
        try:
            response = httpx.get((base_url or DEFAULT_BASE_URL).rstrip("/") + "/models", headers=headers, timeout=10.0)
        except httpx.RequestError as exc:
            return ModelListResult(status="unreachable", error=type(exc).__name__)
        if response.status_code == 401:
            return ModelListResult(status="invalid_key", http_status=401)
        if response.status_code == 403:
            return ModelListResult(status="forbidden", http_status=403)
        if not response.is_success:
            return ModelListResult(status="error", http_status=response.status_code)
        try:
            items = response.json().get("data") or []
        except ValueError:
            return ModelListResult(status="error", http_status=response.status_code, error="invalid_json")
        models = sorted(set(filter_model_items(items)), key=str.lower)
        return ModelListResult(tuple(models), "valid", http_status=response.status_code)

ADAPTER = OpenAIAdapter()
SPEC = ProviderSpec(PROVIDER_ID, "openai_chat_completions", DEFAULT_MODEL,
                    DEFAULT_BASE_URL, ALIASES, model_aliases=MODEL_ALIASES,
                    adapter=ADAPTER)

__all__ = ["ADAPTER", "SPEC", "MODEL_ALIASES", "prepare_payload", "resolve_model"]
