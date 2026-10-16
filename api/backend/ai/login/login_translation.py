"""One native account-pinned generation. No TP fallback, retries or API prices."""
import re
import hashlib
import secrets
import time
from dataclasses import replace
from backend.ai.provider_contract import ProviderSpec, ModelListResult, ProbeResponse
from backend.ai.clients.base import ChatResult
from backend.ai.providers.cloud_openrouter import prepare_payload
from . import login_entitlement, login_session_store as store, login_profiles, login_native as native
from .login_provider_registry import (LoginError, get_provider,
    translation_supported, require_translation_supported)
from . import login_observability as diagnostic

def scoped_model(model):
    match = re.fullmatch(r"(lgs_[a-f0-9]{48})/(.{1,200})", str(model or ""))
    if not match:
        raise LoginError("login_session_expired", "Select a connected Login model.", 401)
    return match.group(1), match.group(2)

def authorize_model(bearer, model):
    owner = login_entitlement.authorize(bearer)
    session_id, base_model = scoped_model(model)
    session = store.get(session_id, owner)
    from .login_routes import enabled
    if not enabled(get_provider(session["provider"])):
        raise LoginError("login_provider_unavailable", "This Login provider is currently unavailable.", 409)
    require_translation_supported(session['provider'])
    return owner, session, base_model

def selected_model(bearer, model):
    _, session, base_model = authorize_model(bearer, model)
    selected = next((x for x in login_profiles.model_list(session) if x["id"] == base_model), None)
    if not selected:
        raise LoginError("login_model_unavailable", "This Login model is unavailable.", 409)
    return selected

class LoginAdapter:
    @diagnostic.adapter_operation("models")
    def list_models(self, *, api_key, base_url):
        owner = login_entitlement.authorize(api_key)
        rows = []
        for session in store.owned(owner):
            from .login_routes import enabled
            if not enabled(get_provider(session["provider"])) or not translation_supported(session['provider']):
                continue
            try:
                store.credential_for_session(session)
            except LoginError as error:
                if error.code == "login_session_expired":
                    continue
                raise
            for item in login_profiles.model_list(session):
                rows.append((session["id"]+"/"+item["id"], item))
        return ModelListResult(models=tuple(x[0] for x in rows), status="valid", http_status=200,
            capabilities={key: item["model_capabilities"] for key, item in rows},
            candidates={key: {"eligibility": "usable", "evidence": "login_account_pinned_catalogue"} for key, _ in rows})

    def probe(self, request):
        listed = self.list_models(api_key=request.api_key, base_url=request.base_url)
        return ProbeResponse(ok=request.model in listed.models, status="eligible" if request.model in listed.models else "unavailable", http_status=200)

    @diagnostic.adapter_operation("inference")
    def generate(self, request):
        _, session, base_model = authorize_model(request.api_key, request.model)
        require_translation_supported(session['provider'])
        catalog = login_profiles.model_list(session)
        selected = next((x for x in catalog if x["id"] == base_model), None)
        if not selected:
            raise LoginError("login_model_unavailable", "This Login model is unavailable.", 409)
        if request.image_b64 and selected["model_capabilities"].get("vision", {}).get("supported") is not True:
            raise LoginError("login_image_unsupported", "This Login model has no verified image support.", 400)
        transport = store.credential_for_session(session)["tokens"].get("transport")
        if transport == 'browser_webchat':
            raise LoginError('login_reconnect_required', 'Reconnect with the endpoint Login extension.', 401)
        if transport == "web_endpoint":
            from .endpoint.login_endpoint_runs import generate
            site = native.module(session['provider'])
            # A model the website already refused for this account is never sent again.
            if native.model_access(selected):
                error = LoginError("login_model_access_denied",
                    "Your account on the website cannot use this model (it may need an upgraded plan). "
                    "Choose another model in AI settings. Nothing was sent.", 403)
                error.requestDispatched = False
                raise error
            try:
                data = generate(session, request, site)
            except LoginError as error:
                if error.code == "login_provider_access_denied" and getattr(error, "requestDispatched", False):
                    try:
                        if native.remember_model_denied(session, base_model, getattr(error, "endpoint_step", "")):
                            diagnostic.emit("model_access_denied", endpointStep=getattr(error, "endpoint_step", ""))
                    except LoginError as stored:
                        # The session changed meanwhile; the website's refusal is still reported.
                        diagnostic.emit("model_access_not_recorded", code=stored.code)
                raise
            # A site with a verified switch reports what it was asked to do.
            applied = data["thinking_applied"] if isinstance(data.get("thinking_applied"), str) \
                else ("on" if site.thinking_enabled(request.thinking) else "off") \
                if getattr(site, 'ENDPOINT_THINKING', False) else "website_managed"
            return ChatResult(data["text"], request.model,
                finish_reason="stop", terminal_completed=True, terminal_evidence=data['terminal'],
                thinking_applied=applied, upstream_provider=session["provider"],
                usage_source="unavailable", usage_status="unavailable",
                usage_details={"source":"unavailable", "usageStatus":"unavailable", "billingAuthority":"own_login_account",
                    "inputTokens":None,"outputTokens":None,"totalTokens":None,"cachedInputTokens":None,"thinkingTokens":None,
                    "transport":"web_endpoint","providerHttpStatuses":data['statuses'],
                    "accountWaitMs":data.get('account_wait_ms', 0),
                    "promptDelivery":data['prompt_delivery'],
                    "providerCostUsd":None, "customerChargeStatus":"not_applicable"})
        thinking = request.thinking
        if thinking == "minimum":
            from backend.ai.reasoning_preference import minimum_reasoning_preference
            thinking = minimum_reasoning_preference(selected["model_capabilities"].get("reasoning", {}))
            if thinking == "none":
                thinking = "off"
        request = replace(request, model_capabilities=selected["model_capabilities"], thinking=thinking)
        payload = prepare_payload(request)
        prepared_reasoning = payload.get("reasoning")
        guarded_budget = payload.get("max_completion_tokens", payload.get("max_tokens", 8192))
        payload["model"] = selected["id"]
        payload.pop("reasoning", None)
        payload.pop("response_format", None)
        payload.pop("provider", None)
        payload.pop("max_completion_tokens", None)
        limit = selected["model_capabilities"].get("limits", {}).get("maxOutputTokens")
        budgets = [8192]
        if type(guarded_budget) is int and guarded_budget > 0:
            budgets.append(guarded_budget)
        if type(limit) is int and limit > 0:
            budgets.append(limit)
        payload["max_tokens"] = min(budgets)
        payload["stream"] = False
        # Pin provider conversation/cache context to the customer session epoch.
        scope = str(request.cache_context.get("conversationScope") or "")
        if request.cache_context.get("translationMode") != "conversation" or not scope:
            scope = secrets.token_hex(24)
        payload["prompt_cache_key"] = "tp-login-" + hashlib.sha256(
            (session["id"]+"\0"+base_model+"\0"+scope).encode()).hexdigest()
        cap = selected["_metadata"].get("thinking")
        thinking = request.thinking
        control_applied = False
        if isinstance(cap, dict):
            levels = cap.get("levels")
            if isinstance(levels, list) and levels:
                control_applied = True
                value = "none" if thinking == "off" else thinking
                if value != "default":
                    if value not in levels and not (value == "none" and cap.get("zero_allowed") is True):
                        raise LoginError("login_thinking_unsupported", "This model cannot use the selected Thinking setting.", 400)
                    payload["reasoning_effort"] = value
            elif type(cap.get("min")) is int and type(cap.get("max")) is int and 0 <= cap["min"] <= cap["max"]:
                control_applied = True
                budget = 0 if thinking == "off" and cap.get("zero_allowed") is True else cap["min"] if thinking == "minimal" else cap["max"] if thinking == "max" else None
                if budget is not None:
                    payload["thinking_budget"] = budget
                elif thinking != "default":
                    raise LoginError("login_thinking_unsupported", "This model cannot use the selected Thinking setting.", 400)
        # Gemini Login is only the gemini.google.com web endpoint (handled
        # above; its module has no OAuth/API generate), so no Gemini API
        # thinking field (thinkingBudget/thinkingLevel) is ever built here.
        if session["provider"] in {"login_openrouter", "login_huggingface"}:
            rcaps = selected["model_capabilities"].get("reasoning", {})
            supported = rcaps.get("supported")
            if thinking == "off" and supported is not False and not (rcaps.get("can_disable") is True or "none" in rcaps.get("supported_efforts", [])):
                raise LoginError("login_thinking_unsupported", "This model has no verified Thinking Off control.", 400)
            if thinking not in {"off", "default"} and thinking not in rcaps.get("supported_efforts", []):
                raise LoginError("login_thinking_unsupported", "This model cannot use the selected Thinking setting.", 400)
            control_applied = supported is False or thinking == "default" or bool(prepared_reasoning)
            if session["provider"] == "login_openrouter" and prepared_reasoning:
                payload["reasoning"] = prepared_reasoning
            elif session["provider"] == "login_huggingface" and thinking != "default" and supported is not False:
                payload["reasoning_effort"] = "none" if thinking == "off" else thinking
                control_applied = True
        if not control_applied and thinking != "default" and not (thinking == "off" and selected["model_capabilities"].get("reasoning", {}).get("supported") is False):
            raise LoginError("login_thinking_unsupported", "Thinking controls are unverified for this model.", 400)
        if request.cancel_check and request.cancel_check():
            raise LoginError("login_cancelled", "Translation was cancelled.", 409)
        started = time.monotonic()
        data = native.generate(session, payload, cancel_check=request.cancel_check)
        try:
            choice = data["choices"][0]
            text = choice["message"]["content"]
            if not isinstance(text, str):
                raise ValueError()
            usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
            def count(value):
                return value if type(value) is int and value >= 0 else None
            i, o, total = count(usage.get("prompt_tokens")), count(usage.get("completion_tokens")), count(usage.get("total_tokens"))
            details = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
            cached = count(details.get("cached_tokens"))
            if cached is not None and (i is None or cached > i):
                cached = None
            output_details = usage.get("completion_tokens_details") if isinstance(usage.get("completion_tokens_details"), dict) else {}
            thinking_tokens = count(output_details.get("reasoning_tokens"))
            receipt = {"inputTokens": i, "outputTokens": o, "totalTokens": total, "cachedInputTokens": cached,
                "thinkingTokens": thinking_tokens, "source": "provider" if i is not None and o is not None else "unavailable",
                "usageStatus": "reported" if i is not None and o is not None else "unavailable",
                "billingAuthority": "own_login_account", "providerCostUsd": None, "customerChargeStatus": "not_applicable"}
            finish = choice.get("finish_reason")
            return ChatResult(text, request.model, i, o, total, finish, provider_ms=(time.monotonic()-started)*1000,
                usage_source=receipt["source"], usage_status=receipt["usageStatus"], cached_input_tokens=cached,
                thinking_tokens=thinking_tokens, terminal_completed=finish == "stop", terminal_evidence="login_native_finish_reason" if finish == "stop" else None,
                thinking_applied=thinking, upstream_provider=session["provider"],
                requested_output_tokens=payload["max_tokens"] if session["provider"] in {"login_gemini", "login_openrouter", "login_huggingface"} else None,
                usage_details=receipt)
        except (KeyError, IndexError, TypeError, ValueError):
            error = LoginError("login_response_invalid", "The AI account returned an invalid translation response.", 502)
            error.requestDispatched = True
            raise error from None

ADAPTER = LoginAdapter()
SPEC = ProviderSpec("login", "openai_chat_completions", "", "", conversation_transport="message_replay",
                    adapter=ADAPTER, rate_rpm=60, rate_burst=8, proactive_rate_gate=False)
