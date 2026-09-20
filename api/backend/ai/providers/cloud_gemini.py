"""Google Gemini generateContent provider."""

from __future__ import annotations
from typing import TypedDict

import os, re, time, httpx
from backend.ai import wire_trace, accounting, content_stream
from backend.ai.workload import guard_output_budget

from backend.ai.generation_defaults import DEFAULT_GENERATION, output_token_budget
from backend.ai.clients.base import (
    ChatResult, ProviderGenerationCancelled, provider_output_error, token_usage,
)
from backend.ai.clients.provider_error import ProviderTransportError, safe_http_error
from backend.ai.transports.cancellable_http import post_json
from backend.ai.provider_contract import GenerationRequest, ModelListResult as ContractModelListResult, ProbeRequest, ProbeResponse, ProviderSpec, SystemPromptSection
from backend.ai.providers.probe_support import response_error, response_error_details
from backend.ai.providers.provider_helpers import (
    contract_model_status, model_status,
)

_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
_MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=1000"
DEFAULT_MODEL = "gemini-3.6-flash"
DEFAULT_BASE_URL = ""
ALIASES = ("gemini3", "gemini-3", "google")
KEY_PREFIXES = ("AIza",)
MODEL_ALIASES = {
    "flash-lite": "gemini-2.5-flash-lite", "flash": "gemini-2.5-flash",
    "pro": "gemini-2.5-pro", "3-flash": "gemini-3.6-flash",
    "3-pro": "gemini-3.1-pro-preview", "3-pro-image": "gemini-3-pro-image",
    "flash-image": "gemini-2.5-flash-image",
    "gemini-3-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3-pro-image-preview": "gemini-3-pro-image",
    "gemini-3-flash-preview": "gemini-3.6-flash",
    "gemini-2.0-flash-lite": "gemini-3.1-flash-lite",
    "gemini-2.0-flash": "gemini-3.6-flash",
    "gemini-1.5-flash": "gemini-2.5-flash",
    "gemini-1.5-flash-8b": "gemini-2.5-flash-lite",
    "gemini-1.5-pro": "gemini-2.5-pro",
}
RATE_POLICY = {"rpm": 12.0, "burst": 4, "rpm_min": 4.0, "rpm_max": 300.0}
_MODEL_EXCLUDE_FRAGMENTS = (
    "-tts", "-image", "computer-use", "deep-research", "antigravity",
    "embedding", "imagen", "veo", "aqa", "-live-", "learnlm", "gemini-1.0", "gemini-1.5",
    "gemini-2.0",
)

class ModelListResult(TypedDict):
    models: list[str]
    status: str
    http_status: int
    error: str

def _safe_error_text(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    error = data.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error.get("code") or "")[:240]
    return str(error or "")[:240]

def model_usable(model_id: str) -> bool:
    """Whether a live Gemini model can perform this translation job."""
    model = (model_id or "").strip().lower()
    return bool(model and not any(part in model for part in _MODEL_EXCLUDE_FRAGMENTS)
                and model not in MODEL_ALIASES)

def _reasoning_capability(model_id: str) -> dict:
    """Verified Gemini reasoning controls for exact documented model families."""
    model = (model_id or "").strip().lower()
    if re.match(r"^gemini-2\.5-pro(?:-|$)", model):
        return {"supported": True, "mandatory": True, "default_enabled": True,
                "control": "levels", "dynamic": True,
                "supported_efforts": ["low", "medium", "high"]}
    if re.match(r"^gemini-2\.5-flash-lite(?:-|$)", model):
        return {"supported": True, "mandatory": False, "default_enabled": False,
                "control": "levels", "dynamic": True,
                "supported_efforts": ["none", "low", "medium", "high"],
                "default_effort": "none"}
    if re.match(r"^gemini-2\.5-flash(?:-|$)", model):
        return {"supported": True, "mandatory": False, "default_enabled": True,
                "control": "levels", "dynamic": True,
                "supported_efforts": ["none", "low", "medium", "high"]}

    # Gemini 3+ uses model-specific thinking levels and cannot be represented
    # as a universal boolean Off/On switch. Keep the exact documented levels.
    level_sets = (
        (r"^gemini-3\.(?:8|7)-flash(?:-|$)", ["low", "medium", "high"], "medium"),
        (r"^gemini-3\.(?:6|5)-flash(?:-|$)", ["minimal", "low", "medium", "high"], "medium"),
        (r"^gemini-3\.1-pro(?:-|$)", ["low", "medium", "high"], "high"),
        (r"^gemini-3\.(?:5|1)-flash-lite(?:-|$)", ["minimal", "low", "medium", "high"], "minimal"),
        (r"^gemini-3-flash(?:-|$)", ["minimal", "low", "medium", "high"], "high"),
    )
    for pattern, efforts, default_effort in level_sets:
        if re.match(pattern, model):
            return {"supported": True, "mandatory": True, "default_enabled": True,
                    "control": "levels", "dynamic": True,
                    "supported_efforts": efforts, "default_effort": default_effort}
    if model.startswith("gemini-3"):
        return {"supported": True, "mandatory": True, "default_enabled": True,
                "control": "levels", "dynamic": True}
    return {}

def models_status(api_key: str, *, timeout_sec: float = 10.0) -> ModelListResult:
    """List account-visible generateContent models with provider-native filtering."""
    if not api_key:
        return model_status(status="missing")
    try:
        with httpx.Client(timeout=timeout_sec) as client:
            response = client.get(_MODELS_ENDPOINT.format(key=api_key))
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
    models = []
    capabilities = {}
    candidates = {}
    for item in data.get("models") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        if ("generateContent" in (item.get("supportedGenerationMethods") or [])
                and name.startswith("models/") and model_usable(name.split("/", 1)[1])):
            model_id = name.split("/", 1)[1]
            models.append(model_id)
            candidates[model_id] = {"eligibility": "usable",
                                    "evidence": "gemini_generateContent_method"}
            from backend.ai.workload import normalize_limits
            limits = normalize_limits({"maxInputTokens": item.get("inputTokenLimit"),
                "maxOutputTokens": item.get("outputTokenLimit"), "modelRevision": str(item.get("version") or ""),
                "source": "gemini-models-api", "scope": "model"})
            capability = {}
            if limits.get("maxInputTokens") or limits.get("maxOutputTokens"):
                capability["limits"] = limits
            provider_thinking = item.get("thinking")
            reasoning = _reasoning_capability(model_id)
            if provider_thinking is False:
                reasoning = {"supported": False, "control": "provider"}
            elif provider_thinking is True and not reasoning:
                reasoning = {"supported": True, "control": "provider", "dynamic": True}
            if reasoning:
                capability["reasoning"] = reasoning
            if capability:
                capabilities[model_id] = capability
    return {**model_status(models=models, status="valid", http_status=status),
            "capabilities": capabilities, "candidates": candidates}

class GeminiAdapter:
    """Provider-owned bridge from the stable request contract to Gemini wire data."""

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        url = _ENDPOINT.format(model=request.model, key=request.api_key)
        cap = _reasoning_capability(request.model)
        generation_config: dict = {"maxOutputTokens": 256 if cap.get("mandatory") or cap.get("control") == "levels" else 32}
        if cap.get("control") == "toggle" and cap.get("mandatory") is not True:
            generation_config["thinkingConfig"] = {"thinkingBudget": 0}
        elif (cap.get("control") == "levels" and cap.get("mandatory") is not True
              and "none" in (cap.get("supported_efforts") or [])):
            generation_config["thinkingConfig"] = {"thinkingBudget": 0}
        payload = {"contents": [{"role": "user", "parts": [{"text": "Reply only OK."}]}],
                   "generationConfig": generation_config}
        with httpx.Client(timeout=request.timeout_sec) as client:
            response = client.post(url, json=payload)
        if not response.is_success:
            return ProbeResponse(False, response.status_code,
                error=response_error(response, api_key=request.api_key),
                error_details=response_error_details(response, api_key=request.api_key))
        try:
            data = response.json()
            candidates = data.get("candidates") if isinstance(data, dict) else None
            content = candidates[0].get("content") if isinstance(candidates, list) and candidates else None
            parts = content.get("parts") if isinstance(content, dict) else None
            text = "".join(str(part.get("text") or "") for part in (parts or []) if isinstance(part, dict))
            if not text.strip(): raise ValueError("empty completion")
        except (ValueError, IndexError, TypeError, AttributeError) as exc:
            return ProbeResponse(False, response.status_code, "invalid_model_output", str(exc))
        return ProbeResponse(True, response.status_code)

    def generate(self, request: GenerationRequest) -> ChatResult:
        return generate(
            request.api_key, request.model, request.system_text, list(request.user_parts),
            system_sections=request.system_sections, image_b64=request.image_b64,
            image_mime=request.image_mime, response_schema=dict(request.response_schema or {}) or None,
            thinking=request.thinking, cancel_check=request.cancel_check,
            **({"history_messages": request.history_messages} if request.history_messages else {}),
            workload=dict(request.workload), model_capabilities=dict(request.model_capabilities),
            unit_count=request.unit_count,
        )

    def list_models(self, *, api_key: str, base_url: str) -> ContractModelListResult:
        _ = base_url
        result = models_status(api_key)
        return contract_model_status(result=result)

ADAPTER = GeminiAdapter()
SPEC = ProviderSpec(
    provider_id="gemini", protocol="gemini_generate_content",
    default_model=DEFAULT_MODEL, default_base_url=DEFAULT_BASE_URL, aliases=ALIASES,
    model_aliases=MODEL_ALIASES, key_prefixes=KEY_PREFIXES,
    rate_rpm=12.0, rate_burst=4, rate_rpm_min=4.0, rate_rpm_max=300.0,
    adapter=ADAPTER,
)

# Gemini 2.5 uses thinkingBudget; Gemini 3 uses thinkingLevel. Pro and unknown
# models retain provider defaults because disabling thinking is unsupported.
_THINKING_DEFAULT = (os.environ.get("TP_GEMINI_THINKING", "off") or "off").strip().lower()

_THINKING_OFF_MODES = ("off", "fast", "none", "0", "false", "no")

def _thinking_state(model: str, mode: str = "", model_capabilities=None) -> tuple[bool, dict | None, str]:
    mode = (mode or "").strip().lower() or "default"
    m = (model or "").strip().lower()
    native = _reasoning_capability(m)
    external = (model_capabilities or {}).get("reasoning", {}) if isinstance(model_capabilities, dict) else {}
    external = external if isinstance(external, dict) else {}
    cap = native or external
    if not cap:
        return False, None, "unverified"
    if not native:
        active = cap.get("mandatory") is True or cap.get("default_enabled") is True
        return bool(active), None, "provider_default_capability"
    if cap.get("control") == "levels":
        efforts = {str(value).strip().lower() for value in cap.get("supported_efforts", [])
                   if isinstance(value, str)}
        if re.match(r"^gemini-2\.5-(?:pro|flash|flash-lite)(?:-|$)", m):
            # Gemini 2.5 exposes effort-like choices through a numeric
            # thinkingBudget. Gemini 3 uses thinkingLevel instead. Keep this
            # mapping in the Gemini provider leaf so shared reasoning policy
            # remains provider-neutral.
            if mode == "off" and cap.get("mandatory") is not True and "none" in efforts:
                return False, {"thinkingBudget": 0}, "requested_off"
            effort_budgets = {"low": 1024, "medium": 8192, "high": 24576}
            if mode in efforts and mode in effort_budgets:
                return True, {"thinkingBudget": effort_budgets[mode]}, f"requested_effort_{mode}"
            active = cap.get("mandatory") is True or cap.get("default_enabled") is True
            return bool(active), None, "provider_default_levels"
        if mode in efforts:
            return True, {"thinkingLevel": mode}, f"requested_effort_{mode}"
        # Stale Off/On profiles and Provider default all preserve the model's
        # native behavior. The UI exposes exact levels for level-based models.
        active = cap.get("mandatory") is True or cap.get("default_enabled") is True
        return bool(active), None, "provider_default_levels"
    mandatory = cap.get("mandatory") is True
    if mode == "off" and not mandatory:
        return False, {"thinkingBudget": 0}, "requested_off"
    if mode == "on":
        return True, {"thinkingBudget": -1}, "requested_on"
    return cap.get("default_enabled") is not False, None, "provider_default"

def _thinking_config_for(model: str, mode: str = "", model_capabilities=None) -> dict | None:
    return _thinking_state(model, mode, model_capabilities)[1]

def _post_once(api_key: str, model: str, payload: dict, cancel_check=None) -> "httpx.Response":
    url = _ENDPOINT.format(model=model, key=api_key)
    if content_stream.active():
        from backend.ai.transports.native_stream import post_native_stream
        url = url.replace(":generateContent?", ":streamGenerateContent?alt=sse&")
        post = post_native_stream
    else:
        post = post_json
    return post(
        url, json=payload, headers=None, timeout=DEFAULT_GENERATION.timeout_sec,
        cancel_check=cancel_check, provider="gemini", model=model,
        trace_file="ai/providers/cloud_gemini.py",
    )

def _supports_native_schema(model: str) -> bool:
    """Return whether the exact model is known to support structured output."""
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

def _accepts_sampling_parameters(model: str) -> bool:
    """Return whether Gemini accepts temperature for this fixed model id."""
    m = (model or "").strip().lower()
    if "latest" in m:
        return False
    match = re.match(r"^gemini-(\d+)(?:\.(\d+))?", m)
    if not match:
        return True
    major = int(match.group(1))
    minor = int(match.group(2) or 0)
    return (major, minor) < (3, 5)

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
    """Project JSON Schema onto Gemini's legacy OpenAPI subset."""

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
    system_sections: tuple[SystemPromptSection, ...] = (),
    image_b64: str = "",
    image_mime: str = "image/jpeg",
    thinking: str = "",
    response_schema: dict | None = None,
    cancel_check=None,
    workload=None,
    model_capabilities=None,
    unit_count: int | None = None,
    history_messages=(),
) -> ChatResult:
    """Call generateContent once without model or option fallback."""
    source_text = "\n\n".join(p for p in user_parts if p != "")
    parts: list[dict] = []
    if (image_b64 or "").strip():
        parts.append({"inline_data": {"mime_type": image_mime or "image/jpeg", "data": image_b64}})
    if source_text:
        parts.append({"text": source_text})
    instruction_parts = [
        {"text": section.text} for section in system_sections if section.text
    ] or [{"text": system_text}]
    reasoning_active, thinking_cfg, thinking_applied = _thinking_state(model, thinking, model_capabilities)
    from backend.ai.translation_paths.messages import native_history
    payload = {
        "systemInstruction": {"parts": instruction_parts},
        "contents": native_history(history_messages, "gemini") + [{"role": "user", "parts": parts}],
        "generationConfig": {
            "maxOutputTokens": guard_output_budget(
                output_token_budget(user_parts, system_text, reasoning=reasoning_active, unit_count=unit_count),
                workload=workload, limits=(model_capabilities or {}).get("limits"),
                system=system_text, parts=user_parts, schema=response_schema, image=bool(image_b64), history=history_messages),
            "responseMimeType": "text/plain",
        },
    }
    if _accepts_sampling_parameters(model):
        payload["generationConfig"]["temperature"] = DEFAULT_GENERATION.temperature
    use_schema = bool(response_schema) and _supports_native_schema(model)
    if use_schema:
        if _uses_response_format(model):
            payload["generationConfig"].pop("responseMimeType", None)
            payload["generationConfig"]["responseFormat"] = {
                "text": {"mimeType": "application/json", "schema": response_schema}
            }
        else:
            payload["generationConfig"]["responseMimeType"] = "application/json"
            payload["generationConfig"]["responseSchema"] = _legacy_response_schema(
                response_schema
            )
    if thinking_cfg is not None:
        payload["generationConfig"]["thinkingConfig"] = thinking_cfg

    wire_trace.provider_request(
        url=(_ENDPOINT.format(model=model, key=api_key).replace(":generateContent?", ":streamGenerateContent?alt=sse&")
             if content_stream.active() else _ENDPOINT.format(model=model, key=api_key)), headers={}, payload=payload,
    )

    if cancel_check is not None and cancel_check():
        raise ProviderGenerationCancelled("Gemini generation was cancelled")
    provider_started = time.perf_counter()
    try:
        r = _post_once(api_key, model, payload, cancel_check)
    except httpx.RequestError as e:
        # Gemini puts the credential in its request URL. Never propagate the
        # provider exception string because it may contain that URL.
        raise ProviderTransportError(
            f"Gemini transport error (model={model}, attempts=1, "
            f"errorType={type(e).__name__})",
            provider="gemini", model=model,
        ) from e
    wire_trace.http_response(r)
    try:
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        # Do not dump the raw body: gateways can echo request content. Extract
        # only Google's structured error fields and redact credential-shaped
        # values, while retaining length/hash to correlate repeated failures.
        raise safe_http_error("Gemini", r, model) from e
    if cancel_check is not None and cancel_check():
        raise ProviderGenerationCancelled("Gemini generation was cancelled")
    provider_ms = round((time.perf_counter() - provider_started) * 1000, 1)
    parse_started = time.perf_counter()
    data = r.json()

    usage = data.get("usageMetadata")
    usage_details = accounting.observe(usage, "gemini", complete=True,
        response_id=str(data.get("id") or data.get("responseId") or ""))
    inp, out, total = (usage_details[key] for key in ("inputTokens", "outputTokens", "totalTokens"))

    def output_error(message: str, finish_reason: str | None = None):
        parse_ms = round((time.perf_counter() - parse_started) * 1000, 1)
        raise provider_output_error(
            message, provider="gemini", model=model,
            input_tokens=inp, output_tokens=out, total_tokens=total,
            finish_reason=finish_reason, provider_ms=provider_ms, parse_ms=parse_ms,
            timeout_policy="provider_total_bounded", usage_details=usage_details,
        )

    candidates = data.get("candidates") or []
    if not candidates:
        # Preserve provider block reasons for actionable diagnostics.
        feedback = data.get("promptFeedback") or {}
        block_reason = str(feedback.get("blockReason") or "").strip()
        if block_reason:
            output_error(
                f"Gemini blocked this content (blockReason={block_reason}) — "
                "the provider refuses to translate it; this is not a bug",
                block_reason,
            )
        output_error("Gemini returned no candidates")
    finish = str(candidates[0].get("finishReason") or "").strip()
    if finish and finish != "STOP":
        output_error(f"Gemini response was incomplete (finishReason={finish})", finish)
    out_parts = (candidates[0].get("content") or {}).get("parts") or []
    if not out_parts:
        if finish and finish != "STOP":
            output_error(f"Gemini returned no content (finishReason={finish})", finish)
        output_error("Gemini returned empty content parts", finish or None)
    text = "".join(str(p.get("text") or "") for p in out_parts if not p.get("thought")).strip()
    if not text:
        output_error("Gemini returned empty text", finish or None)
    wire_trace.assembled_response(text)
    parse_ms = round((time.perf_counter() - parse_started) * 1000, 1)
    return ChatResult(
        text=text, used_model=model, input_tokens=inp, output_tokens=out, total_tokens=total,
        finish_reason=finish or None, provider_ms=provider_ms, parse_ms=parse_ms,
        usage_source="provider" if any(v is not None for v in (inp, out, total)) else None,
        thinking_tokens=usage_details.get("thinkingTokens"), terminal_completed=True,
        terminal_evidence="native_sse_terminal" if content_stream.active() else "non_stream_body_read", thinking_applied=thinking_applied,
        requested_output_tokens=payload["generationConfig"]["maxOutputTokens"],
        cached_input_tokens=usage_details.get("cachedInputTokens"), usage_details=usage_details,
        first_content_ms=getattr(r, "extensions", {}).get("first_content_ms"),
    )
