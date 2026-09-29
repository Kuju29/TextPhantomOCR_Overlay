"""Featherless identity, plan-aware catalogue and rate policy."""

from types import MappingProxyType

import httpx

from backend.ai.generation_defaults import DEFAULT_GENERATION
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProviderSpec
from backend.ai.cloud_reasoning import observed_off_status
from backend.ai.providers.openai_provider_runtime import (
    OpenAIProviderAdapter, OpenAIProviderPolicy, bearer_headers, build_payload,
)
from backend.ai.transports.openai_chat import execute_chat_completion
from backend.ai.workload import normalize_limits, positive

PROVIDER_ID = "featherless"
DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct"
DEFAULT_BASE_URL = "https://api.featherless.ai/v1"
LIST_PARAMS = MappingProxyType({
    "available_on_current_plan": "true",
    "conversational": "true",
    "status": "active",
    "per_page": 1000,
})

def filter_model_items(items) -> list[str]:
    models = []
    for item in items or []:
        if not isinstance(item, dict) or not str(item.get("id") or "").strip():
            continue
        if item.get("available_on_current_plan") is False:
            continue
        if str(item.get("status") or "active").strip().lower() not in ("", "active"):
            continue
        if item.get("conversational") is False:
            continue
        inputs = item.get("input_modalities")
        outputs = item.get("output_modalities")
        if isinstance(inputs, list) and inputs and "text" not in {str(v).lower() for v in inputs}:
            continue
        if isinstance(outputs, list) and outputs and "text" not in {str(v).lower() for v in outputs}:
            continue
        models.append(str(item["id"]).strip())
    return models

POLICY = OpenAIProviderPolicy(
    provider_id=PROVIDER_ID,
    trace_file="ai/providers/cloud_featherless.py",
    # The catalogue does not expose per-model sampling capabilities. Preserve
    # the selected model's provider default rather than guessing support.
    temperature=None,
    output_budget_field="max_tokens",
    reasoning_policy="requires_verified_capability",
    model_filter=filter_model_items,
    catalogue_evidence="featherless_current_plan_conversational",
    list_params=LIST_PARAMS,
)

# The official API example uses this exact ID, but also warns that template
# kwargs may be ignored by models. A successful HTTP request alone therefore
# does not establish verified Off capability in model discovery.
_DOCUMENTED_TEMPLATE_TOGGLE = frozenset({"Qwen/Qwen3-32B"})


def _reasoning_capability(model: str) -> dict:
    # No account/model-specific semantic evidence is published by /v1/models.
    # Keep explicit Off/Lowest blocked until a separate verified source exists.
    return {}


def _native_control(request: GenerationRequest) -> dict:
    cap = request.model_capabilities.get("reasoning", {})
    if (request.model not in _DOCUMENTED_TEMPLATE_TOGGLE or
            not isinstance(cap, dict) or cap.get("supported") is not True or
            cap.get("control") not in {"boolean", "toggle"} or
            (cap.get("mandatory") is not False and cap.get("can_disable") is not True)):
        return {}
    if request.thinking == "off":
        return {"chat_template_kwargs": {"enable_thinking": False}}
    if request.thinking == "on":
        return {"chat_template_kwargs": {"enable_thinking": True}}
    return {}


class FeatherlessAdapter(OpenAIProviderAdapter):
    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        # Catalogue maximum context is not necessarily the account plan's
        # effective context. Only use numeric context after reading /plan.
        if not api_key or not base_url:
            return ModelListResult(status="missing")
        plan_context = None
        plan_known = False
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.get(base_url.rstrip("/") + "/models",
                    headers=bearer_headers(api_key), params=dict(LIST_PARAMS))
                if response.is_success:
                    try:
                        plan_response = client.get(base_url.rstrip("/") + "/plan",
                            headers=bearer_headers(api_key))
                        if plan_response.is_success:
                            plan = plan_response.json()
                            if isinstance(plan, dict) and "max_context_length" in plan:
                                plan_context = positive(plan["max_context_length"])
                                plan_known = plan["max_context_length"] is None or plan_context is not None
                    except (httpx.RequestError, ValueError):
                        # Missing account-plan evidence leaves physical context
                        # unknown. The model's output limit can still be used.
                        pass
        except httpx.RequestError as exc:
            return ModelListResult(status="unreachable", error=type(exc).__name__)
        if not response.is_success:
            status = "invalid_key" if response.status_code == 401 else "forbidden" if response.status_code == 403 else "error"
            return ModelListResult(status=status, http_status=response.status_code)
        try:
            body = response.json()
        except ValueError:
            return ModelListResult(status="error", http_status=response.status_code, error="invalid_json")
        items = body.get("data", []) if isinstance(body, dict) else []
        models = filter_model_items(items)
        caps = {}
        rows_by_id: dict[str, list[dict]] = {}
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict) or item.get("id") not in models:
                continue
            rows_by_id.setdefault(str(item["id"]), []).append(item)
            vision = item.get("vision_supported")
            if isinstance(vision, bool):
                caps[str(item["id"])] = {"vision": {"supported": vision,
                                                      "source": "featherless_account_model_catalogue"}}
        for model in models:
            rows = rows_by_id.get(model, [])
            if len(rows) != 1:
                continue
            model_context = positive(rows[0].get("context_length"))
            effective_context = (min(model_context, plan_context) if model_context and plan_context
                else model_context if plan_known and plan_context is None
                else plan_context if plan_context else None)
            limits = normalize_limits({"contextTokens": effective_context,
                "maxOutputTokens": rows[0].get("max_completion_tokens"),
                "source": ("featherless_models_and_account_plan" if plan_known
                           else "featherless_account_models_api"), "scope": "account_model"})
            if "contextTokens" in limits or "maxOutputTokens" in limits:
                caps.setdefault(model, {})["limits"] = limits
        return ModelListResult(models=models, status="valid", http_status=response.status_code,
            capabilities=caps,
            candidates={model: {"eligibility": "usable", "evidence": POLICY.catalogue_evidence}
                        for model in models})

    def generate(self, request: GenerationRequest):
        payload = build_payload(request, request.model, POLICY)
        control = _native_control(request)
        payload.update(control)
        result = execute_chat_completion(
            url=request.base_url.rstrip("/") + "/chat/completions",
            headers=bearer_headers(request.api_key), payload=payload,
            model=request.model, provider_id=PROVIDER_ID,
            timeout=DEFAULT_GENERATION.timeout_sec, timeout_policy="cloud_default",
            expected_ids=list(request.expected_ids), cancel_check=request.cancel_check,
            trace_file="ai/providers/cloud_featherless.py",
            trace_fields={"reasoningControlSent": bool(control),
                          "thinkingMode": request.thinking,
                          "temperatureSent": "temperature" in payload,
                          "requestedOutputTokens": payload.get("max_tokens")},
        )
        applied = "provider_default" if request.thinking == "default" else "unverified"
        if control.get("chat_template_kwargs") == {"enable_thinking": False}:
            applied = observed_off_status(result)
        elif control:
            applied = f"requested_{request.thinking}"
        return result._replace(thinking_applied=applied)


ADAPTER = FeatherlessAdapter(POLICY)
SPEC = ProviderSpec(
    PROVIDER_ID,
    "openai_chat_completions",
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    rate_rpm=30.0,
    rate_burst=6,
    rate_rpm_min=6.0,
    rate_rpm_max=150.0,
    conversation_transport="message_replay", adapter=ADAPTER,
)

__all__ = ["ADAPTER", "SPEC", "LIST_PARAMS", "filter_model_items"]
