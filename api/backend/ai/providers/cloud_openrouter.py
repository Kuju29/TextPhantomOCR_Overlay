"""OpenRouter provider: gateway headers, live capabilities and reasoning policy."""

from __future__ import annotations
from typing import Any

import re, httpx
from urllib.parse import urlsplit

from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.openrouter_chat import execute_openrouter_chat

PROVIDER_ID = "openrouter"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "openai/o4-mini"
ALIASES: tuple[str, ...] = ()
TEMPERATURE = 0.7
MAX_OUTPUT_TOKENS = 8192

def normalize_capabilities(item: dict[str, Any]) -> dict[str, Any]:
    reasoning = item.get("reasoning") if isinstance(item.get("reasoning"), dict) else {}
    supported_raw = item.get("supported_parameters")
    supported = {str(value).lower() for value in supported_raw} if isinstance(supported_raw, list) else set()
    efforts = reasoning.get("supported_efforts", item.get("supported_reasoning_efforts", []))
    clean = [value.strip().lower() for value in efforts if isinstance(value, str) and re.fullmatch(r"[a-z0-9_-]{1,32}", value.strip().lower())] if isinstance(efforts, list) else []
    result: dict[str, Any] = {}
    explicit = reasoning.get("supported")
    if isinstance(explicit, bool): result["supported"] = explicit
    elif "reasoning" in supported or clean or reasoning.get("mandatory") is True: result["supported"] = True
    if isinstance(reasoning.get("mandatory"), bool): result["mandatory"] = reasoning["mandatory"]
    if isinstance(reasoning.get("default_enabled"), bool): result["default_enabled"] = reasoning["default_enabled"]
    # OpenRouter exposes disable as a separate control from supported_efforts.
    # The catalogue's effort list is only the levels available while reasoning
    # is enabled; mandatory=false means the UI may offer reasoning off.
    if result.get("supported") is True and reasoning.get("mandatory") is False:
        result["can_disable"] = True
    if clean:
        result["control"] = "levels"
        result["supported_efforts"] = list(dict.fromkeys(clean))
    elif result.get("supported") is True:
        # The catalogue explicitly says omitted supported_efforts means the
        # model does not expose effort selection. Do not invent a boolean
        # enable/disable contract from the mere presence of `reasoning`.
        result["control"] = "provider"
    default_effort = reasoning.get("default_effort")
    if isinstance(default_effort, str) and re.fullmatch(r"[a-z0-9_-]{1,32}", default_effort.strip().lower()):
        result["default_effort"] = default_effort.strip().lower()
    if reasoning.get("supports_max_tokens") is True or "reasoning.max_tokens" in supported:
        result["supports_max_tokens"] = True
    output: dict[str, Any] = {"reasoning": result}
    architecture = item.get("architecture") if isinstance(item.get("architecture"), dict) else {}
    inputs = architecture.get("input_modalities")
    if isinstance(inputs, list) and inputs:
        normalized_inputs = {str(value).strip().lower() for value in inputs}
        output["vision"] = {
            "supported": "image" in normalized_inputs,
            "source": "openrouter-account-model-catalogue",
        }
    if "response_format" in supported or "structured_outputs" in supported:
        output["structured_output"] = {"supported": True}
    from backend.ai.workload import normalize_limits
    top = item.get("top_provider") if isinstance(item.get("top_provider"), dict) else {}
    per_request = item.get("per_request_limits") if isinstance(item.get("per_request_limits"), dict) else {}
    limits = normalize_limits({"contextTokens": item.get("context_length"),
        "outputHintTokens": top.get("max_completion_tokens"),
        "maxOutputTokens": per_request.get("completion_tokens"),
        "maxInputTokens": per_request.get("prompt_tokens"),
        "tokenizer": architecture.get("tokenizer"),
        "source": "openrouter-account-model-catalogue", "scope": "catalogue-top-provider-hint"})
    if any(key in limits for key in ("contextTokens", "outputHintTokens", "maxOutputTokens", "maxInputTokens")):
        output["limits"] = limits
    return output

def _policy(request: GenerationRequest) -> tuple[dict[str, Any] | None, bool]:
    """Map only capability-proven reasoning controls to OpenRouter's wire.

    A catalogue entry that merely accepts the generic `reasoning` parameter is
    not proof that `enabled:false` is valid for that model. Hermes follows the
    same principle: clamp to catalog-advertised efforts and otherwise defer to
    the provider instead of guessing a wire shape that may 400.
    """
    mode = str(request.thinking or "off").strip().lower()
    rcaps = request.model_capabilities.get("reasoning", {})
    rcaps = rcaps if isinstance(rcaps, dict) else {}
    if rcaps.get("supported") is not True:
        return None, False
    mandatory = rcaps.get("mandatory") is True
    control = str(rcaps.get("control") or "provider")
    efforts = {str(value).strip().lower() for value in rcaps.get("supported_efforts", [])
               if isinstance(value, str)}
    # Unknown provider default on a known reasoning model is treated as active
    # for output-budget/temperature safety, while still sending no reasoning
    # control field.
    provider_default_active = mandatory or rcaps.get("default_enabled") is not False
    if mode in {"default", "minimum"}:
        return None, provider_default_active
    if mode == "off":
        if mandatory:
            return None, True
        # OpenRouter's reasoning effort vocabulary includes `none`.  An explicit
        # mandatory=false means the model is optional-reasoning even when a stale
        # catalogue snapshot omitted can_disable/none from its effort ladder.
        # With require_parameters=true routing will avoid endpoints that cannot
        # honor this control instead of silently escalating Off to Low.
        if rcaps.get("mandatory") is False or rcaps.get("can_disable") is True or (control == "levels" and "none" in efforts):
            return {"effort": "none"}, False
        if control in {"toggle", "boolean"}:
            return {"enabled": False}, False
        # Unknown capability must not invent a lower effort. Preserve the saved
        # Off intent in accounting; the wire stays provider-default until exact
        # control evidence is available.
        return None, False
    if mode == "on":
        if control in {"toggle", "boolean"}:
            return {"enabled": True}, True
        return None, provider_default_active
    if control == "levels" and mode in efforts:
        return {"effort": mode}, mode != "none"
    return None, provider_default_active

def _budget(request: GenerationRequest, reasoning: bool) -> int:
    units = max(1, int(request.unit_count or len([part for part in request.user_parts if part.strip()])))
    answer = int(sum(len(part) for part in request.user_parts) * 2.2) + units * 112 + 384
    hidden = min(4096, 768 + units * 128 + int(len(request.system_text) * .04)) if reasoning else 0
    standard = max(1024, min(MAX_OUTPUT_TOKENS, answer + hidden))
    # The planner already predicts the marker output.  Do not advertise a 7-8K
    # completion ceiling for a ~1K-token translation: some OpenRouter endpoints
    # schedule/rout large reservations more conservatively, and an accidental
    # reasoning mode can then consume that entire allowance.  Keep a generous
    # 50% margin while preserving the old estimator as the fallback.
    workload = dict(request.workload or {})
    predicted = workload.get("predictedOutput")
    if isinstance(predicted, int) and not isinstance(predicted, bool) and predicted > 0:
        reserve = workload.get("reasoningReserve") if reasoning else 0
        reserve = reserve if isinstance(reserve, int) and not isinstance(reserve, bool) and reserve > 0 else 0
        dynamic = predicted + reserve + max(256, (predicted + 1) // 2)
        standard = max(1024, min(standard, dynamic))
    # A stale historical reasoning sample must not re-inflate an explicitly-Off
    # request.  Off is already proven on the wire by reasoning.effort=none.
    if not reasoning and workload:
        workload["reasoningReserve"] = 0
    from backend.ai.workload import guard_output_budget
    return guard_output_budget(standard, workload=workload,
        limits=request.model_capabilities.get("limits"), system=request.system_text,
        parts=request.user_parts, schema=dict(request.response_schema) if request.response_schema else None,
        image=bool(request.image_b64), history=request.history_messages)

def _apply_official_routing(payload: dict[str, Any], base_url: str) -> dict[str, Any]:
    """Prefer fast OpenRouter endpoints without pinning a vendor.

    Hermes exposes the same OpenRouter routing controls and recommends
    throughput sorting for fast generation.  Keep fallbacks enabled and require
    request-parameter support so a fast endpoint cannot silently ignore the
    selected reasoning control.  Custom OpenAI-compatible gateways are left
    untouched.
    """
    try:
        host = (urlsplit(base_url).hostname or "").lower()
    except ValueError:
        host = ""
    if host != "openrouter.ai":
        return payload
    result = dict(payload)
    current = result.get("provider") if isinstance(result.get("provider"), dict) else {}
    result["provider"] = {
        **current,
        "sort": current.get("sort", "throughput"),
        "allow_fallbacks": current.get("allow_fallbacks", True),
        "require_parameters": current.get("require_parameters", True),
        # Deprioritize endpoints whose recent p90 startup latency is already
        # outside TextPhantom's interactive budget, without excluding them as
        # fallbacks. OpenRouter treats this as a preference, not a hard filter.
        "preferred_max_latency": current.get("preferred_max_latency", {"p90": 8}),
    }
    return result

def _reasoning_budget(total: int) -> int:
    """Cap hidden reasoning while reserving most completion space for markers."""
    # Completion budgets are never below 1024, so the 256 minimum and 768
    # answer reserve can both be satisfied, including the smallest boundary.
    return max(256, min(2048, int(total) // 3, int(total) - 768))

def prepare_payload(request: GenerationRequest) -> dict[str, Any]:
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
    reasoning_payload, reasoning_active = _policy(request)
    reasoning_caps = request.model_capabilities.get("reasoning", {})
    reasoning_mandatory = (
        isinstance(reasoning_caps, dict)
        and reasoning_caps.get("mandatory") is True
    )
    from backend.ai.translation_paths.messages import insert_history
    messages = insert_history(messages, request.history_messages, "openai_image_first")
    payload: dict[str, Any] = {"model": request.model, "messages": messages}
    if reasoning_active:
        payload["max_completion_tokens"] = _budget(request, True)
    else:
        payload.update(temperature=TEMPERATURE, max_tokens=_budget(request, False))
    if reasoning_payload is not None:
        payload["reasoning"] = reasoning_payload
    if reasoning_active and isinstance(reasoning_caps, dict) and reasoning_caps.get("supports_max_tokens") is True:
        # OpenRouter counts reasoning and final text against the same completion
        # ceiling. Bound reasoning for on/default/mandatory modes so it cannot
        # consume the entire response before any <<TP_Pn:...>> markers appear.
        if reasoning_payload is None:
            reasoning_payload = {}
            payload["reasoning"] = reasoning_payload
        reasoning_payload["max_tokens"] = _reasoning_budget(payload["max_completion_tokens"])
    if request.response_schema:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "textphantom_translations", "strict": True,
                            "schema": dict(request.response_schema)},
        }
    return payload

def filter_model_items(items) -> list[dict[str, Any]]:
    """Account-catalogue entries compatible with TextPhantom chat translation."""
    accepted: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict) or not str(item.get("id") or "").strip():
            continue
        if item.get("available_on_current_plan") is False:
            continue
        endpoint_type = str(item.get("type") or "").strip().lower()
        if endpoint_type and endpoint_type != "chat":
            continue
        architecture = item.get("architecture") if isinstance(item.get("architecture"), dict) else {}
        inputs = architecture.get("input_modalities") if isinstance(architecture, dict) else None
        outputs = architecture.get("output_modalities") if isinstance(architecture, dict) else None
        if isinstance(inputs, list) and inputs and "text" not in {
            str(value).strip().lower() for value in inputs
        }:
            continue
        if isinstance(outputs, list) and outputs and "text" not in {
            str(value).strip().lower() for value in outputs
        }:
            continue
        accepted.append(item)
    return accepted

class OpenRouterAdapter:
    def probe(self, request: ProbeRequest) -> ProbeResponse:
        # Health probing must not guess reasoning controls. OpenRouter's model
        # catalogue says omitted supported_efforts means effort selection is
        # not exposed. In that case defer to provider defaults and only enlarge
        # the shared completion budget so hidden reasoning cannot consume the
        # entire tiny probe response.
        rcaps = request.model_capabilities.get("reasoning", {})
        rcaps = rcaps if isinstance(rcaps, dict) else {}
        reasoning_supported = rcaps.get("supported") is True
        extra: dict[str, Any] = {
            "max_completion_tokens": 2048 if reasoning_supported else 256,
        }
        efforts = [str(value).strip().lower() for value in rcaps.get("supported_efforts", [])
                   if isinstance(value, str)]
        if reasoning_supported:
            mandatory = rcaps.get("mandatory") is True
            can_disable = rcaps.get("can_disable") is True
            if can_disable and not mandatory:
                extra["reasoning"] = {"effort": "none"}
            elif efforts:
                order = ("minimal", "low", "medium", "high", "xhigh", "max", "ultra")
                selected = next((effort for effort in order if effort in efforts), "")
                if selected:
                    extra["reasoning"] = {"effort": selected}
        return openai_chat_probe(request, headers={
            "HTTP-Referer": "https://textphantom.app", "X-Title": "TextPhantom",
        }, payload_extra=extra)

    def generate(self, request: GenerationRequest):
        base = (request.base_url or DEFAULT_BASE_URL).rstrip("/")
        headers = {"Content-Type": "application/json", "HTTP-Referer": "https://textphantom.app", "X-Title": "TextPhantom"}
        if request.api_key: headers["Authorization"] = f"Bearer {request.api_key}"
        payload = _apply_official_routing(prepare_payload(request), base)
        # The private lease already separates caller/document/key/language. Do
        # not derive this from a global System prefix or a per-request UUID.
        from backend.ai.prompt_cache import enabled as prompt_cache_enabled
        import hashlib
        scope = str(request.cache_context.get("conversationScope") or "")
        if (prompt_cache_enabled() and scope and
                request.cache_context.get("translationMode") == "conversation" and
                (urlsplit(base).hostname or "").lower() == "openrouter.ai"):
            payload["session_id"] = "tp-c-" + hashlib.sha256(
                (request.provider + "\0" + request.model + "\0" + scope).encode()
            ).hexdigest()[:48]
        reasoning_value = payload.get("reasoning") if isinstance(payload.get("reasoning"), dict) else {}
        request_reasoning = request.model_capabilities.get("reasoning", {})
        reasoning_mandatory = isinstance(request_reasoning, dict) and request_reasoning.get("mandatory") is True
        from backend import trace
        trace.note("openrouter.reasoning_policy", {
            "thinkingMode": request.thinking,
            "reasoningControlSent": bool(reasoning_value),
            "reasoningEnabledSent": reasoning_value.get("enabled"),
            "reasoningEffortSent": reasoning_value.get("effort"),
            "reasoningBudgetTokens": reasoning_value.get("max_tokens"),
            "requestedOutputTokens": payload.get("max_completion_tokens", payload.get("max_tokens")),
            "capabilityKnown": bool(request.model_capabilities),
            "providerSort": (payload.get("provider") or {}).get("sort"),
            "requireParameters": (payload.get("provider") or {}).get("require_parameters"),
            "preferredMaxLatency": (payload.get("provider") or {}).get("preferred_max_latency"),
        }, file="ai/providers/cloud_openrouter.py")
        result = execute_openrouter_chat(
            url=base + "/chat/completions", headers=headers, payload=payload,
            model=request.model, timeout=120.0,
            timeout_policy="provider_total_bounded", expected_ids=list(request.expected_ids),
            cancel_check=request.cancel_check, trace_event="openrouter.generate",
            trace_file="ai/providers/cloud_openrouter.py",
            trace_fields={"requestedOutputTokens": payload.get("max_completion_tokens", payload.get("max_tokens")),
                          "reasoningPolicyApplied": "openrouter" if "reasoning" in payload else "standard",
                          "reasoningMode": request.thinking,
                          "reasoningBudgetTokens": reasoning_value.get("max_tokens"),
                          "reasoningControlSent": bool(reasoning_value),
                          "capabilityKnown": bool(request.model_capabilities),
                          "providerSort": (payload.get("provider") or {}).get("sort"),
                          "requireParameters": (payload.get("provider") or {}).get("require_parameters"),
                          "preferredMaxLatency": (payload.get("provider") or {}).get("preferred_max_latency")},
        )
        applied = "provider_default" if request.thinking == "default" else "unverified"
        if isinstance(reasoning_value.get("enabled"), bool):
            applied = "requested_on" if reasoning_value["enabled"] else "requested_off"
        elif reasoning_value.get("effort"):
            applied = f"requested_{request.thinking}_effort_{reasoning_value['effort']}"
        elif reasoning_mandatory:
            applied = "provider_mandatory"
        return result._replace(thinking_applied=applied)

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        try:
            with httpx.Client(timeout=10.0) as client:
                # Account-scoped and authoritative: the public /models list can
                # include models blocked by this key's plan/privacy settings.
                response = client.get((base_url or DEFAULT_BASE_URL).rstrip("/") + "/models/user", headers=headers)
            if response.status_code == 401:
                return ModelListResult(status="invalid_key", http_status=401)
            if response.status_code == 403:
                return ModelListResult(status="forbidden", http_status=403)
            if not response.is_success:
                return ModelListResult(status="error", http_status=response.status_code)
            items = response.json().get("data") or []
            accepted = filter_model_items(items)
            models = sorted({str(item["id"]).strip() for item in accepted})
            caps = {str(item["id"]).strip(): normalize_capabilities(item) for item in accepted}
            candidates = {str(item["id"]).strip(): {
                "eligibility": "usable", "evidence": "openrouter_account_models_user"
            } for item in accepted}
            return ModelListResult(tuple(models), "valid", capabilities=caps,
                                   candidates=candidates)
        except Exception as exc:
            return ModelListResult(status="unreachable", error=str(exc))

ADAPTER = OpenRouterAdapter()
SPEC = ProviderSpec(PROVIDER_ID, "openai_chat_completions", DEFAULT_MODEL,
                    DEFAULT_BASE_URL, ALIASES, key_prefixes=("sk-or-",), rate_rpm=60.0, rate_burst=8,
                    rate_rpm_min=10.0, rate_rpm_max=300.0, adapter=ADAPTER)

__all__ = ["ADAPTER", "SPEC", "filter_model_items", "normalize_capabilities", "prepare_payload"]
