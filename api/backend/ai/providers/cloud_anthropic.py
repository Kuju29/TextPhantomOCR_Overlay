"""Anthropic (api.anthropic.com) chat client.
"""

from __future__ import annotations

import time, httpx
from functools import partial
from backend.ai import wire_trace, accounting, content_stream
from backend.ai.workload import guard_output_budget
from backend.ai.prompt_cache import enabled as cache_enabled

from backend.ai.generation_defaults import DEFAULT_GENERATION, output_token_budget
from backend.ai.clients.base import (
    ChatResult, ProviderGenerationCancelled, provider_output_error, token_usage,
)
from backend.ai.clients.provider_error import ProviderTransportError, safe_http_error
from backend.ai.transports.cancellable_http import post_json
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec, SystemPromptSection
from backend.ai.reasoning_preference import resolve_reasoning_preference
from backend.ai.providers.probe_support import response_error, response_error_details
from backend.ai.providers.provider_helpers import (
    contract_model_status, invoke_leaf_generate, model_status,
)

_ENDPOINT = "https://api.anthropic.com/v1/messages"
_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models?limit=1000"
_API_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_BASE_URL = "https://api.anthropic.com"
ALIASES: tuple[str, ...] = ()
KEY_PREFIXES = ("sk-ant-",)
MODEL_ALIASES = {"claude-sonnet-4-20250514": "claude-sonnet-4-6"}
RATE_POLICY = {"rpm": 50.0, "burst": 8, "rpm_min": 10.0, "rpm_max": 400.0}


def _safe_error_text(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    error = data.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error.get("type") or "")[:240]
    return str(error or "")[:240]

def _reasoning_capability(model_id: str) -> dict:
    """Documented Anthropic reasoning controls for current adaptive families.

    Unknown and legacy manual-thinking models deliberately return no capability:
    they remain usable with Provider default rather than receiving guessed fields.
    """
    model = (model_id or "").strip().lower()

    def levels(efforts, *, default_enabled: bool, mandatory: bool = False, default_effort: str = "high"):
        supported = list(efforts)
        if not mandatory and "none" not in supported:
            supported.insert(0, "none")
        return {
            "supported": True,
            "mandatory": mandatory,
            "default_enabled": default_enabled,
            "control": "levels",
            "dynamic": True,
            "supported_efforts": supported,
            "default_effort": default_effort,
        }

    # Claude 5: adaptive thinking is provider-default ON. Opus/Sonnet can be
    # disabled explicitly; Fable/Mythos are adaptive-thinking-only.
    if _is_model_or_snapshot(model, "claude-opus-5") or _is_model_or_snapshot(model, "claude-sonnet-5"):
        return levels(("low", "medium", "high", "xhigh", "max"), default_enabled=True)
    if any(_is_model_or_snapshot(model, prefix) for prefix in (
        "claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5"
    )):
        return levels(("low", "medium", "high", "xhigh", "max"),
                      default_enabled=True, mandatory=True)
    if _is_model_or_snapshot(model, "claude-mythos-preview"):
        return levels(("low", "medium", "high", "max"),
                      default_enabled=True, mandatory=True)

    # Claude 4.6-4.8 adaptive thinking is opt-in: omitting `thinking` keeps it
    # off. The exact effort ladders differ by family/version.
    if _is_model_or_snapshot(model, "claude-opus-4-7") or _is_model_or_snapshot(model, "claude-opus-4-8"):
        return levels(("low", "medium", "high", "xhigh", "max"), default_enabled=False)
    if _is_model_or_snapshot(model, "claude-opus-4-6") or _is_model_or_snapshot(model, "claude-sonnet-4-6"):
        return levels(("low", "medium", "high", "max"), default_enabled=False)

    # 4.5 and earlier use manual budget_tokens rather than the adaptive/effort
    # shape used above. TextPhantom does not invent a generic budget here.
    return {}


def _apply_reasoning(payload: dict, model: str, requested: str, model_capabilities=None) -> str:
    """Map TextPhantom's provider-neutral preference to Anthropic-native fields.

    Provider default means *omit* the reasoning fields. This is important because
    Claude 4.6-4.8 default to thinking off while Claude 5 defaults to adaptive
    thinking on. TextPhantom's `minimum` preference (and stale Off on a
    mandatory-reasoning family) resolves through the shared capability layer to
    the lowest exact native mode instead of inheriting a potentially heavier
    provider default.
    """
    external = (model_capabilities or {}).get("reasoning", {}) if isinstance(model_capabilities, dict) else {}
    external = external if isinstance(external, dict) else {}
    native = _reasoning_capability(model)
    cap = native or external
    selected = resolve_reasoning_preference(requested, cap) if cap else "default"
    if selected == "default":
        return "provider_default"

    # Only emit native Anthropic fields for model families whose exact wire
    # contract is known here. Generic/externally-described models stay on the
    # provider default instead of receiving guessed Anthropic syntax.
    if not native:
        return "provider_default_unverified_wire"

    if selected == "off":
        payload["thinking"] = {"type": "disabled"}
        return "requested_off"

    efforts = {str(value).strip().lower() for value in native.get("supported_efforts", [])
               if isinstance(value, str)}
    if selected in efforts and selected != "none":
        payload["thinking"] = {"type": "adaptive"}
        payload["output_config"] = {**(payload.get("output_config") or {}), "effort": selected}
        return f"requested_effort_{selected}"

    # `on` has no single stable Anthropic meaning across current families.
    # If it reaches this provider through a stale profile, preserve provider
    # default rather than silently choosing an effort.
    return "provider_default_incompatible_preference"


def models_status(api_key: str, *, timeout_sec: float = 10.0) -> dict:
    """List Claude models visible to this key using Anthropic's native API."""
    if not api_key:
        return model_status(status="missing")
    headers = {"x-api-key": api_key, "anthropic-version": _API_VERSION}
    try:
        with httpx.Client(timeout=timeout_sec) as client:
            response = client.get(_MODELS_ENDPOINT, headers=headers)
    except httpx.RequestError as exc:
        return model_status(status="unreachable", error=type(exc).__name__)
    status = int(response.status_code)
    if status == 401:
        return model_status(status="invalid_key", http_status=status, error=_safe_error_text(response))
    if status == 403:
        return model_status(status="forbidden", http_status=status, error=_safe_error_text(response))
    if not response.is_success:
        return model_status(status="error", http_status=status, error=_safe_error_text(response))
    try:
        data = response.json()
    except ValueError:
        return model_status(status="error", http_status=status, error="invalid_json")
    models = [str(item.get("id") or "").strip() for item in (data.get("data") or [])
              if isinstance(item, dict) and str(item.get("id") or "").strip()]
    result = model_status(models=models, status="valid", http_status=status)
    result["candidates"] = {model: {
        "eligibility": "usable", "evidence": "anthropic_account_models_api"
    } for model in models}
    capabilities = {}
    for model in models:
        reasoning = _reasoning_capability(model)
        if reasoning:
            capabilities[model] = {"reasoning": reasoning}
    if capabilities:
        result["capabilities"] = capabilities
    return result

class AnthropicAdapter:
    """Provider-owned bridge from the stable request contract to Messages API."""

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        headers = {"x-api-key": request.api_key, "anthropic-version": _API_VERSION,
                   "content-type": "application/json"}
        payload = {"model": request.model, "max_tokens": 8,
                   "messages": [{"role": "user", "content": "Reply only OK."}]}
        with httpx.Client(timeout=request.timeout_sec) as client:
            response = client.post(_ENDPOINT, headers=headers, json=payload)
        if not response.is_success:
            return ProbeResponse(False, response.status_code,
                error=response_error(response, api_key=request.api_key),
                error_details=response_error_details(response, api_key=request.api_key))
        try:
            data = response.json()
            blocks = data.get("content") if isinstance(data, dict) else None
            text = "".join(str(block.get("text") or "") for block in (blocks or [])
                           if isinstance(block, dict) and block.get("type") == "text")
            if not text.strip(): raise ValueError("empty completion")
        except (ValueError, TypeError, AttributeError) as exc:
            return ProbeResponse(False, response.status_code, "invalid_model_output", str(exc))
        return ProbeResponse(True, response.status_code)

    def generate(self, request: GenerationRequest) -> ChatResult:
        return invoke_leaf_generate(request, partial(
            generate,
            conversation_mode=request.cache_context.get("translationMode") == "conversation",
        ))

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        _ = base_url
        result = models_status(api_key)
        return contract_model_status(result)

ADAPTER = AnthropicAdapter()
SPEC = ProviderSpec(
    provider_id="anthropic", protocol="anthropic_messages",
    default_model=DEFAULT_MODEL, default_base_url=DEFAULT_BASE_URL, aliases=ALIASES,
    model_aliases=MODEL_ALIASES, key_prefixes=KEY_PREFIXES,
    rate_rpm=50.0, rate_burst=8, rate_rpm_min=10.0, rate_rpm_max=400.0,
    adapter=ADAPTER,
)

def _is_model_or_snapshot(model: str, prefix: str) -> bool:
    m = (model or "").strip().lower()
    return m == prefix or m.startswith(prefix + "-")


# def _supports_native_schema(model: str) -> bool:
#     """Return true only for Claude families with documented output_config.

#     Sonnet/Opus/Haiku 4.5 and subsequent explicitly known releases support
#     native structured outputs. Older and unknown models keep the same JSON
#     contract in the prompt but receive no transport-level output_config.
#     """
#     m = (model or "").strip().lower()
#     supported_starts = (
#         "claude-sonnet-4-5",
#         "claude-sonnet-4-6",
#         "claude-sonnet-5",
#         "claude-opus-4-5",
#         "claude-opus-4-6",
#         "claude-opus-4-7",
#         "claude-opus-4-8",
#         "claude-opus-5",
#         "claude-haiku-4-5",
#         "claude-fable-5",
#         "claude-mythos-5",
#         "claude-mythos-preview",
#     )
#     return any(_is_model_or_snapshot(m, prefix) for prefix in supported_starts)

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
    system_text: str, system_static: str, system_dynamic: str,
    system_sections: tuple[SystemPromptSection, ...] = (),
) -> str | list[dict]:
    """Annotate the unchanged stable prefix; the provider decides cache eligibility.

    A cache_control hint is not proof of a hit or any guaranteed discount.
    No static prefix is invented and the prompt itself is never abbreviated.
    """
    if system_sections:
        return [dict(
            type="text", text=section.text,
            **({"cache_control": {"type": "ephemeral"}} if section.cacheable and cache_enabled() else {}),
        ) for section in system_sections if section.text]
    static = (system_static or "").strip()
    dynamic = (system_dynamic or "").strip()
    if not static or not cache_enabled():
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
    system_sections: tuple[SystemPromptSection, ...] = (),
    image_b64: str = "",
    image_mime: str = "image/jpeg",
    system_static: str = "",
    system_dynamic: str = "",
    response_schema: dict | None = None,
    thinking: str = "",
    cancel_check=None,
    workload=None,
    model_capabilities=None,
    history_messages=(),
    conversation_mode: bool = False,
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
    if cancel_check is not None and cancel_check():
        raise ProviderGenerationCancelled("Anthropic generation was cancelled")
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
            {"type": "text", "text": p} for p in user_parts if p != ""
        )
        messages = [{"role": "user", "content": content}]
    else:
        source_text = "\n\n".join(p for p in user_parts if p != "")
        messages = [{"role": "user", "content": source_text}] if source_text else []
    from backend.ai.translation_paths.messages import native_history
    messages = native_history(history_messages, "anthropic") + messages
    payload = {
        "model": model,
        "max_tokens": guard_output_budget(output_token_budget(user_parts, system_text),
                workload=workload, limits=(model_capabilities or {}).get("limits"),
                system=system_text, parts=user_parts, schema=response_schema, image=bool(image_b64), history=history_messages),
        "system": _build_system_field(system_text, system_static, system_dynamic, system_sections),
        "messages": messages,
    }
    if conversation_mode and cache_enabled() and messages:
        # Anthropic's moving breakpoint reuses the previous request prefix and
        # writes only its new suffix. Keep native messages/history byte-for-byte;
        # this is a request hint, not proof of a hit. The default 5m TTL is kept.
        # Documented: platform.claude.com/docs/en/build-with-claude/prompt-caching
        system_blocks = payload["system"]
        if isinstance(system_blocks, list):
            marked = [i for i, block in enumerate(system_blocks) if "cache_control" in block]
            # One of the provider's four slots belongs to automatic caching.
            for i in marked[:-3]:
                system_blocks[i].pop("cache_control", None)
        payload["cache_control"] = {"type": "ephemeral"}
    reasoning_state = _apply_reasoning(payload, model, thinking, model_capabilities)
    if _accepts_temperature(model) and not payload.get("thinking"):
        payload["temperature"] = DEFAULT_GENERATION.temperature
    # Translation generation is always plain lines/1. JSON remains decoder-only.
    use_schema = False
    if use_schema:
        payload["output_config"] = {**(payload.get("output_config") or {}),
            "format": {"type": "json_schema", "schema": response_schema}
        }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": _API_VERSION,
        "content-type": "application/json",
    }
    if content_stream.active():
        payload["stream"] = True
        from backend.ai.transports.native_stream import post_native_stream
        post = post_native_stream
    else:
        post = post_json
    wire_trace.provider_request(url=_ENDPOINT, headers=headers, payload=payload)

    provider_started = time.perf_counter()
    try:
        r = post(
            _ENDPOINT, json=payload, headers=headers,
            timeout=DEFAULT_GENERATION.timeout_sec, cancel_check=cancel_check,
            provider="anthropic", model=model,
            trace_file="ai/providers/cloud_anthropic.py",
        )
    except httpx.RequestError as e:
        raise ProviderTransportError(
            f"Anthropic transport error (model={model}, attempts=1, "
            f"errorType={type(e).__name__})",
            provider="anthropic", model=model,
        ) from e
    wire_trace.http_response(r)
    try:
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise safe_http_error("Anthropic", r, model) from e
    if cancel_check is not None and cancel_check():
        raise ProviderGenerationCancelled("Anthropic generation was cancelled")
    provider_ms = round((time.perf_counter() - provider_started) * 1000, 1)
    parse_started = time.perf_counter()
    data = r.json()

    stop_reason = str(data.get("stop_reason") or "").strip()
    usage_details = accounting.observe(data.get("usage"), "anthropic", complete=True,
        response_id=str(data.get("id") or data.get("responseId") or ""))
    inp, out, total = (usage_details[key] for key in ("inputTokens", "outputTokens", "totalTokens"))
    def output_error(message: str):
        parse_ms = round((time.perf_counter() - parse_started) * 1000, 1)
        raise provider_output_error(
            message, provider="anthropic", model=model,
            input_tokens=inp, output_tokens=out, total_tokens=total,
            finish_reason=stop_reason or None, provider_ms=provider_ms, parse_ms=parse_ms,
            timeout_policy="provider_total_bounded", usage_details=usage_details,
        )
    if stop_reason and stop_reason not in ("end_turn", "stop_sequence"):
        output_error(f"Anthropic response was incomplete (stop_reason={stop_reason})")

    content = data.get("content") or []
    text = "".join(
        c.get("text") or ""
        for c in content
        if isinstance(c, dict) and c.get("type") == "text"
    ).strip()
    if not text:
        output_error("Anthropic returned empty text")
    wire_trace.assembled_response(text)
    parse_ms = round((time.perf_counter() - parse_started) * 1000, 1)
    return ChatResult(text, model, inp, out, total, stop_reason or None, provider_ms, parse_ms,
                      "provider" if any(v is not None for v in (inp, out, total)) else None,
                      None, True, "native_sse_terminal" if content_stream.active() else "non_stream_body_read", usage_details=usage_details,
                      cached_input_tokens=usage_details.get("cachedInputTokens"), requested_output_tokens=payload["max_tokens"],
                      first_content_ms=getattr(r, "extensions", {}).get("first_content_ms"))
