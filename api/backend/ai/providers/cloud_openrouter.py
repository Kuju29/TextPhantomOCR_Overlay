"""OpenRouter provider: gateway headers, live capabilities and reasoning policy."""

from __future__ import annotations
from typing import Any

import re, httpx

from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.openai_chat import execute_chat_completion

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
    if result.get("supported") is True:
        result["control"] = "toggle"
    if clean: result["supported_efforts"] = list(dict.fromkeys(clean))
    if reasoning.get("supports_max_tokens") is True or "reasoning.max_tokens" in supported:
        result["supports_max_tokens"] = True
    output: dict[str, Any] = {"reasoning": result}
    if "response_format" in supported or "structured_outputs" in supported:
        output["structured_output"] = {"supported": True}
    from backend.ai.workload import normalize_limits
    top = item.get("top_provider") if isinstance(item.get("top_provider"), dict) else {}
    per_request = item.get("per_request_limits") if isinstance(item.get("per_request_limits"), dict) else {}
    architecture = item.get("architecture") if isinstance(item.get("architecture"), dict) else {}
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
    mode = "on" if request.thinking == "on" else "off"
    rcaps = request.model_capabilities.get("reasoning", {})
    rcaps = rcaps if isinstance(rcaps, dict) else {}
    # Never infer controllability from a model name. In particular, sending
    # ``enabled:false`` to an unknown DeepSeek variant can reject a model whose
    # reasoning is mandatory. The account-scoped model catalogue is the only
    # authority for these controls.
    capable = rcaps.get("supported") is True
    if not capable:
        return None, False
    mandatory = rcaps.get("mandatory") is True
    efforts = [str(value).lower() for value in rcaps.get("supported_efforts", [])]
    if mode == "on":
        if mandatory and rcaps.get("supports_max_tokens") is not True and "low" not in efforts:
            return None, True
        if rcaps.get("supports_max_tokens") is not True and "low" not in efforts:
            raise ValueError(
                "OpenRouter reasoning cannot be enabled safely: account capability has no bounded reasoning control"
            )
        if rcaps.get("supports_max_tokens") is not True and "low" in efforts:
            return {"effort": "low"}, True
        return {"enabled": True}, True
    if mode == "off":
        if mandatory and "low" in efforts:
            return {"effort": "low"}, True
        return (None if mandatory else {"enabled": False}), True
    # Unknown is not affirmative evidence that optional reasoning defaults on.
    # This was the .16 failure mode: hidden reasoning consumed all 6144 output
    # tokens without producing one visible marker.
    if not mandatory and rcaps.get("default_enabled") is not True:
        return None, False
    return None, True

def _budget(request: GenerationRequest, reasoning: bool) -> int:
    units = max(1, int(request.unit_count or len([part for part in request.user_parts if part.strip()])))
    answer = int(sum(len(part) for part in request.user_parts) * 2.2) + units * 112 + 384
    hidden = min(4096, 768 + units * 128 + int(len(request.system_text) * .04)) if reasoning else 0
    from backend.ai.workload import guard_request_budget
    return guard_request_budget(request, max(1024, min(MAX_OUTPUT_TOKENS, answer + hidden)))

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
    reasoning_payload, reasoning_capable = _policy(request)
    reasoning_caps = request.model_capabilities.get("reasoning", {})
    reasoning_mandatory = (
        isinstance(reasoning_caps, dict)
        and reasoning_caps.get("mandatory") is True
    )
    payload: dict[str, Any] = {"model": request.model, "messages": messages}
    reasoning_active = reasoning_capable and (
        reasoning_mandatory
        or request.thinking == "on"
    )
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
        # The user-facing default is Thinking Off.  If the account catalogue
        # confirms optional reasoning, suppress it during the tiny health probe
        # as well; otherwise a usable reasoning-default model can spend the
        # whole probe budget thinking and be falsely labelled unavailable.
        rcaps = request.model_capabilities.get("reasoning", {})
        rcaps = rcaps if isinstance(rcaps, dict) else {}
        extra: dict[str, Any] = {"max_tokens": 256}
        if rcaps.get("supported") is True:
            if rcaps.get("mandatory") is True:
                efforts = {str(value).strip().lower() for value in rcaps.get("supported_efforts", [])}
                if "low" in efforts:
                    extra = {
                        "max_completion_tokens": 512,
                        "reasoning": {"effort": "low"},
                    }
                elif rcaps.get("supports_max_tokens") is True:
                    extra = {
                        "max_completion_tokens": 512,
                        "reasoning": {"max_tokens": 128},
                    }
                else:
                    # Mandatory reasoning with no bounded control remains the
                    # provider's responsibility. Give the probe enough shared
                    # completion space to return one visible token.
                    extra = {"max_completion_tokens": 512}
            else:
                extra["reasoning"] = {"enabled": False}
        return openai_chat_probe(request, headers={
            "HTTP-Referer": "https://textphantom.app", "X-Title": "TextPhantom",
        }, payload_extra=extra)

    def generate(self, request: GenerationRequest):
        base = (request.base_url or DEFAULT_BASE_URL).rstrip("/")
        headers = {"Content-Type": "application/json", "HTTP-Referer": "https://textphantom.app", "X-Title": "TextPhantom"}
        if request.api_key: headers["Authorization"] = f"Bearer {request.api_key}"
        payload = prepare_payload(request)
        reasoning_value = payload.get("reasoning") if isinstance(payload.get("reasoning"), dict) else {}
        from backend import trace
        trace.note("openrouter.reasoning_policy", {
            "thinkingMode": request.thinking,
            "reasoningControlSent": bool(reasoning_value),
            "reasoningEnabledSent": reasoning_value.get("enabled"),
            "reasoningEffortSent": reasoning_value.get("effort"),
            "reasoningBudgetTokens": reasoning_value.get("max_tokens"),
            "requestedOutputTokens": payload.get("max_completion_tokens", payload.get("max_tokens")),
            "capabilityKnown": bool(request.model_capabilities),
        }, file="ai/providers/cloud_openrouter.py")
        return execute_chat_completion(
            url=base + "/chat/completions", headers=headers, payload=payload,
            model=request.model, provider_id=PROVIDER_ID, timeout=120.0,
            timeout_policy="provider_total_bounded", expected_ids=list(request.expected_ids),
            cancel_check=request.cancel_check, trace_event="openrouter.generate",
            trace_file="ai/providers/cloud_openrouter.py",
            trace_fields={"requestedOutputTokens": payload.get("max_completion_tokens", payload.get("max_tokens")),
                          "reasoningPolicyApplied": "openrouter" if "reasoning" in payload else "standard",
                          "reasoningMode": request.thinking,
                          "reasoningBudgetTokens": reasoning_value.get("max_tokens"),
                          "reasoningControlSent": bool(reasoning_value),
                          "capabilityKnown": bool(request.model_capabilities)},
        )

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
            return ModelListResult(tuple(models), "valid", capabilities=caps)
        except Exception as exc:
            return ModelListResult(status="unreachable", error=str(exc))

ADAPTER = OpenRouterAdapter()
SPEC = ProviderSpec(PROVIDER_ID, "openai_chat_completions", DEFAULT_MODEL,
                    DEFAULT_BASE_URL, ALIASES, key_prefixes=("sk-or-",), rate_rpm=60.0, rate_burst=8,
                    rate_rpm_min=10.0, rate_rpm_max=300.0, adapter=ADAPTER)

__all__ = ["ADAPTER", "SPEC", "filter_model_items", "normalize_capabilities", "prepare_payload"]
