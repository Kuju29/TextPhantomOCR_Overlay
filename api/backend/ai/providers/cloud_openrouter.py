"""OpenRouter provider: gateway headers, live capabilities and reasoning policy."""

from __future__ import annotations
from typing import Any

import re, httpx
from collections import Counter
from urllib.parse import urlsplit

from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.cloud_reasoning import observed_off_status
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
    parameters_known = isinstance(supported_raw, list) and all(isinstance(value, str) for value in supported_raw)
    supported = {value.lower() for value in supported_raw} if parameters_known else set()
    efforts = reasoning.get("supported_efforts", item.get("supported_reasoning_efforts", []))
    # Official model metadata distinguishes explicit null (all gateway effort
    # values) from an omitted field (no effort selector). Other providers' extra
    # vocabulary is not part of OpenRouter's documented gateway contract.
    if "supported_efforts" in reasoning and efforts is None:
        efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
        if reasoning.get("mandatory") is True:
            efforts.remove("none")
    clean = [value.strip().lower() for value in efforts if isinstance(value, str) and re.fullmatch(r"[a-z0-9_-]{1,32}", value.strip().lower())] if isinstance(efforts, list) else []
    result: dict[str, Any] = {}
    if isinstance(efforts, list) and len(clean) != len(efforts):
        # Do not send malformed names on the wire, but retain the fact that
        # the visible valid levels may not include the true lowest level.
        result["minimum_unresolved"] = True
    explicit = reasoning.get("supported")
    if isinstance(explicit, bool): result["supported"] = explicit
    elif "reasoning" in supported or clean or reasoning.get("mandatory") is True: result["supported"] = True
    elif (parameters_known and not reasoning and
          not any(value == "include_reasoning" or value.startswith("reasoning") for value in supported)):
        # Any reasoning-family parameter (e.g. the legacy include_reasoning)
        # still means the model may reason, so it stays unknown. Without any,
        # the model has no reasoning to lower, so Thinking Lowest/Off can pass.
        result["supported"] = False
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
    if parameters_known:
        output["supported_parameters"] = sorted(supported)
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
    per_request = item.get("per_request_limits") if isinstance(item.get("per_request_limits"), dict) else {}
    limits = normalize_limits({"contextTokens": item.get("context_length"),
        "maxOutputTokens": per_request.get("completion_tokens"),
        "maxInputTokens": per_request.get("prompt_tokens"),
        "tokenizer": architecture.get("tokenizer"),
        "source": "openrouter-account-model-catalogue", "scope": "account_model"})
    # top_provider.max_completion_tokens describes one upstream candidate; an
    # unpinned request can take another route, so it cannot limit this request.
    if any(key in limits for key in ("contextTokens", "maxOutputTokens", "maxInputTokens")):
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
    # The planner predicts the marker output; a 7-8K ceiling for a ~1K-token
    # translation lets accidental reasoning consume it and some endpoints route
    # large reservations conservatively. Keep a 50% margin over the estimate.
    workload = dict(request.workload or {})
    predicted = workload.get("predictedOutput")
    if isinstance(predicted, int) and not isinstance(predicted, bool) and predicted > 0:
        # The browser may have measured hidden thinking from this exact model
        # despite an accepted Thinking Off control. Preserve that observation:
        # all generated tokens share the output ceiling, irrespective of the UI
        # toggle, and a continuation/repair needs room for the visible answer.
        reserve = workload.get("reasoningReserve")
        reserve = reserve if isinstance(reserve, int) and not isinstance(reserve, bool) and reserve > 0 else 0
        dynamic = predicted + reserve + max(256, (predicted + 1) // 2)
        standard = max(1024, min(MAX_OUTPUT_TOKENS, max(standard, dynamic) if reserve else min(standard, dynamic)))
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
        # Restore the router's same-model upstream failover policy. This does
        # not change TextPhantom's selected provider/model or issue app retries.
        # Explicit caller restrictions remain authoritative.
        "allow_fallbacks": current.get("allow_fallbacks", True),
        "require_parameters": current.get("require_parameters", True),
        # Deprioritize endpoints whose recent p90 startup latency is already
        # outside TextPhantom's interactive budget. OpenRouter treats this as
        # a preference, not a hard filter for the initial upstream selection.
        "preferred_max_latency": current.get("preferred_max_latency", {"p90": 8}),
    }
    return result

def _reasoning_budget(total: int) -> int:
    """Cap hidden reasoning while reserving most completion space for markers."""
    # Completion budgets are never below 1024, so the 256 minimum and 768
    # answer reserve both fit. The formula (generation_defaults) also feeds the
    # stream's thinking-time limit.
    from backend.ai.generation_defaults import reasoning_token_cap
    return reasoning_token_cap(total)

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
    from backend.ai.translation_paths.messages import insert_history
    messages = insert_history(messages, request.history_messages, "openai_image_first")
    payload: dict[str, Any] = {"model": request.model, "messages": messages}
    if reasoning_active:
        payload["max_completion_tokens"] = _budget(request, True)
    else:
        payload.update(temperature=TEMPERATURE, max_tokens=_budget(request, False))
    from backend.ai.providers.provider_helpers import accepts_optional_parameter
    if not accepts_optional_parameter(request.model_capabilities, "temperature"):
        payload.pop("temperature", None)
    if reasoning_payload is not None:
        payload["reasoning"] = reasoning_payload
    provider_managed_minimum = (request.thinking == "default" and
                                (request.cache_context.get("thinkingRequested") == "minimum" or
                                 request.cache_context.get("thinkingProviderDefault") is True))
    # OpenRouter takes reasoning.effort OR reasoning.max_tokens, "not both"
    # (docs: use-cases/reasoning-tokens). A chosen effort level wins; the token
    # bound is only added when no effort was sent.
    if (reasoning_active and not provider_managed_minimum and
            not (isinstance(reasoning_payload, dict) and "effort" in reasoning_payload) and
            isinstance(reasoning_caps, dict) and reasoning_caps.get("supports_max_tokens") is True):
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
        # Hosts ordered by the routing decision (stats by default; `auto` is the
        # cache-capable-first rule; `manual` the admin's list), using the
        # per-model endpoint list cached by openrouter_cache_order.
        from backend.ai.routing import openrouter as routing
        from backend.ai.routing import trace_summary
        try:
            payload, decision, endpoints, endpoint_reason = routing.plan(request, payload, base)
        except Exception as exc:  # noqa: BLE001 - routing never breaks a translation; reason is traced
            decision, endpoints, endpoint_reason = None, [], "routing_error_" + type(exc).__name__
        route_trace = trace_summary(decision, endpoints=endpoint_reason) if decision else {"endpoints": endpoint_reason}
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
            "routing": route_trace,
        }, file="ai/providers/cloud_openrouter.py")
        import time as _time
        started = _time.monotonic()
        try:
            result = self._execute(base, headers, payload, request, reasoning_value, route_trace)
        except BaseException as exc:
            if decision is not None:
                try:
                    routing.record_failure(request, exc, decision, endpoints, started)
                except Exception:  # noqa: BLE001 - statistics never replace the provider error
                    pass
            raise
        if decision is not None:
            try:
                routing.record_success(request, result, decision, endpoints)
            except Exception:  # noqa: BLE001 - statistics never fail a delivered answer
                pass
        return self._finish(request, result, reasoning_value, reasoning_mandatory)

    def _execute(self, base, headers, payload, request, reasoning_value, route_trace):
        return execute_openrouter_chat(
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
                          "preferredMaxLatency": (payload.get("provider") or {}).get("preferred_max_latency"),
                          "routing": route_trace},
        )

    def _finish(self, request, result, reasoning_value, reasoning_mandatory):
        from backend import trace
        applied = "provider_default" if request.thinking == "default" else "unverified"
        off_control_sent = (reasoning_value.get("enabled") is False
                            or reasoning_value.get("effort") == "none")
        if off_control_sent:
            # OpenRouter may route to an upstream that accepts effort:none but
            # still reports hidden reasoning. The request field alone is not
            # proof that Thinking Off took effect.
            observed = result.thinking_tokens
            applied = observed_off_status(result)
            trace.note("openrouter.reasoning_observed", {
                "thinkingMode": request.thinking,
                "reasoningControlSent": True,
                "reportedReasoningTokens": observed if type(observed) is int else None,
                "reasoningContentObserved": result.reasoning_observed,
                "thinkingApplied": applied,
            }, file="ai/providers/cloud_openrouter.py")
        elif isinstance(reasoning_value.get("enabled"), bool):
            applied = "requested_on"
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
            counts = Counter(str(item["id"]).strip() for item in accepted)
            repeated = {model for model, count in counts.items() if count > 1}
            for model in repeated:
                # A duplicated model ID has no unique capability record.
                # The last row cannot prove its reasoning, vision or limits.
                caps[model] = {}
            candidates = {str(item["id"]).strip(): {
                "eligibility": "usable", "evidence": "openrouter_account_models_user"
            } for item in accepted}
            return ModelListResult(tuple(models), "valid", capabilities=caps,
                                   candidates=candidates)
        except httpx.RequestError as exc:
            # HTTP exception strings can include the full URL. Catalogue
            # diagnostics only need a bounded error class, never credentials.
            return ModelListResult(status="unreachable", error=type(exc).__name__)
        except (ValueError, TypeError, AttributeError, KeyError):
            return ModelListResult(status="error", error="invalid_model_catalogue")

ADAPTER = OpenRouterAdapter()
SPEC = ProviderSpec(PROVIDER_ID, "openai_chat_completions", DEFAULT_MODEL,
                    DEFAULT_BASE_URL, ALIASES, key_prefixes=("sk-or-",), rate_rpm=60.0, rate_burst=8,
                    rate_rpm_min=10.0, rate_rpm_max=300.0, conversation_transport="message_replay", adapter=ADAPTER)

__all__ = ["ADAPTER", "SPEC", "filter_model_items", "normalize_capabilities", "prepare_payload"]
