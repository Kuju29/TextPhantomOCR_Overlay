import re

import httpx

from backend.ai.generation_defaults import output_token_budget
from backend.ai.provider_contract import ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.providers.local_openai_runtime import LocalOpenAIChatAdapter, LocalOpenAIChatPolicy
from backend.ai.workload import guard_request_budget
from backend.ai.transports.lmstudio_native import execute_lmstudio_chat
from backend.ai.reasoning_preference import normalize_reasoning_preference

DEFAULT_MODEL = "local-model"
DEFAULT_BASE_URL = "http://localhost:1234/v1"
ALIASES = ("lm-studio", "lm_studio", "lms")
MODEL_ALIASES = {}
KEY_PREFIXES = ()

POLICY = LocalOpenAIChatPolicy(
    provider_id="lmstudio", aliases=ALIASES,
    default_model=DEFAULT_MODEL, default_base_url=DEFAULT_BASE_URL,
    model_aliases=MODEL_ALIASES, key_prefixes=KEY_PREFIXES,
    auth_optional=False, thinking_field=None,
    temperature=None, output_token_ceiling=8192,
    append_path="/v1", completion_path="/chat/completions",
    discovery_path="/models", strip_paths=("/chat/completions",),
    model_allow_prefixes=(), model_deny_prefixes=(),
)
class LocalLmStudioAdapter(LocalOpenAIChatAdapter):
    """Native chat handles both stateless Independent and linked Conversation."""

    @staticmethod
    def conversation_cursor(history):
        if not history:
            return ""
        cursor = str(history[-1].get("providerResponseId") or "")
        if not re.fullmatch(r"resp_[A-Za-z0-9_-]{1,256}", cursor):
            from backend.ai.translation_paths.store import ConversationError
            error = ConversationError(
                "LM Studio conversation has no validated provider continuation cursor; no provider request was sent")
            error.code = "ai_conversation_cursor_missing"
            raise error
        return cursor

    @staticmethod
    def conversation_result_error(result, *, reason, malformed_count=0):
        """Validate a native retained reply without pretending a partial text is its cursor."""
        if reason == "cursor_missing" and re.fullmatch(
                r"resp_[A-Za-z0-9_-]{1,256}", result.provider_response_id or ""):
            return None
        if reason not in ("cursor_missing", "transcript_invalid"):
            raise ValueError("Unknown LM Studio conversation failure")
        from backend.ai.clients.base import provider_output_error, usage_meta
        error = provider_output_error(
            "LM Studio did not return a valid conversation continuation cursor" if reason == "cursor_missing"
            else "LM Studio returned a response that cannot be retained as a conversation turn",
            provider="lmstudio", model=result.used_model,
            input_tokens=result.input_tokens, output_tokens=result.output_tokens,
            total_tokens=result.total_tokens, finish_reason=None,
            provider_ms=result.provider_ms, parse_ms=result.parse_ms,
            timeout_policy="local_connect_bounded_native_total_30m",
            response_shape="lmstudio_stateful_chat", usage_details=usage_meta(result))
        error.code = "ai_conversation_cursor_missing" if reason == "cursor_missing" \
            else "ai_conversation_native_transcript_invalid"
        if reason == "transcript_invalid":
            error.structural_details["malformedOutputRecordCount"] = malformed_count
        return error

    @staticmethod
    def _positive_context(value):
        return value if type(value) is int and 0 < value <= 100_000_000 else None

    def _native_models(self, api_key: str, base_url: str, timeout: float) -> ModelListResult:
        """Read exact loaded instances or downloaded keys backed by native JIT."""
        base = self.normalize_base_url(base_url)
        url = (base[:-3] if base.lower().endswith("/v1") else base) + "/api/v1/models"
        headers = self._headers(api_key)
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.get(url, headers=headers)
        except httpx.RequestError as exc:
            return ModelListResult(status="unreachable", error=type(exc).__name__)
        if not response.is_success:
            return ModelListResult(status="error", http_status=response.status_code)
        try:
            data = response.json()
        except ValueError:
            return ModelListResult(status="error", http_status=response.status_code, error="invalid_json")
        if not isinstance(data, dict) or not isinstance(data.get("models"), list):
            return ModelListResult(status="error", http_status=response.status_code,
                                   error="invalid_native_model_catalogue")

        # /v1/models includes downloaded models only when JIT is enabled. A
        # native downloaded key alone does not prove it can be used in chat.
        instances = {}
        unloaded = {}
        for item in data["models"]:
            if not isinstance(item, dict) or item.get("type") != "llm":
                continue
            loaded = item.get("loaded_instances")
            if not isinstance(loaded, list):
                continue
            for instance in loaded:
                if isinstance(instance, dict) and isinstance(instance.get("id"), str):
                    identifier = instance["id"].strip()
                    if identifier:
                        instances.setdefault(identifier, []).append((item, instance))
            key = item.get("key")
            maximum = self._positive_context(item.get("max_context_length"))
            if not loaded and isinstance(key, str) and key.strip() == key and key and maximum:
                unloaded.setdefault(key, []).append(item)
        jit_visible = set()
        if unloaded:
            try:
                with httpx.Client(timeout=timeout) as client:
                    jit_response = client.get(base + "/models", headers=headers)
                if jit_response.is_success:
                    compat = jit_response.json()
                    rows = compat.get("data") if isinstance(compat, dict) else None
                    if isinstance(rows, list):
                        jit_visible = {entry["id"] for entry in rows if isinstance(entry, dict)
                                       and isinstance(entry.get("id"), str)}
            except (httpx.RequestError, ValueError, TypeError):
                pass
        models, capabilities, candidates = [], {}, {}
        for identifier in dict.fromkeys((*instances, *unloaded)):
            owners = instances.get(identifier, [])
            jit = not owners and identifier in jit_visible and len(unloaded.get(identifier, [])) == 1
            if len(owners) != 1 and not jit:
                continue
            item, instance = owners[0] if owners else (unloaded[identifier][0], None)
            models.append(identifier)
            cap = {}
            info = item.get("capabilities") if isinstance(item.get("capabilities"), dict) else {}
            if isinstance(info.get("vision"), bool):
                cap["vision"] = {"supported": info["vision"],
                    "source": "lmstudio_native_jit_catalogue" if jit else "lmstudio_native_loaded_instance"}
            reasoning = info.get("reasoning") if isinstance(info.get("reasoning"), dict) else {}
            options = reasoning.get("allowed_options")
            if isinstance(options, list) and all(isinstance(option, str) and
                    option in ("off", "on", "low", "medium", "high") for option in options):
                allowed = list(dict.fromkeys(options))
                cap["reasoning"] = {"supported": bool(allowed), "mandatory": bool(allowed) and "off" not in allowed,
                    "control": "toggle" if set(allowed) <= {"off", "on"} else "levels",
                    "supported_efforts": allowed}
                native_default = reasoning.get("default")
                if isinstance(native_default, str) and native_default in allowed:
                    cap["reasoning"].update(default_effort=native_default,
                                             default_enabled=native_default != "off")
            config = instance.get("config") if instance and isinstance(instance.get("config"), dict) else {}
            context = self._positive_context(config.get("context_length"))
            if context:
                cap["limits"] = {"contextTokens": context, "runtimeContextTokens": context,
                    "source": "lmstudio_native_loaded_instance", "scope": "runtime"}
            elif jit:
                maximum = self._positive_context(item.get("max_context_length"))
                requested = min(16384, maximum)
                cap["limits"] = {"contextTokens": requested, "modelContextTokens": maximum,
                    "source": "lmstudio_native_jit_catalogue", "scope": "requested"}
            capabilities[identifier] = cap
            candidates[identifier] = {"eligibility": "jit_requested_unverified" if jit else "unknown",
                "evidence": "lmstudio_native_jit_catalogue" if jit else "lmstudio_native_loaded_instance"}
        return ModelListResult(models=tuple(models), status="valid", http_status=response.status_code,
                               capabilities=capabilities, candidates=candidates)

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        return self._native_models(api_key, base_url, 3.0)

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        # Opening Settings must not perform a generation or implicitly load an
        # unloaded model. This is a new metadata read scoped to this endpoint.
        listed = self._native_models(request.api_key, request.base_url, request.timeout_sec)
        if listed.status != "valid":
            return ProbeResponse(False, listed.http_status, status=listed.status, error=listed.error)
        exact = self.normalize_model(request.model)
        if exact not in listed.models:
            return ProbeResponse(False, listed.http_status, status="model_unavailable",
                                 error="Selected LM Studio model is not an exact loaded instance or verified JIT key")
        return ProbeResponse(True, listed.http_status, capabilities=listed.capabilities.get(exact, {}))

    def prepare_native_payload(self, request):
        if request.response_schema:
            raise ValueError("LM Studio native chat requires the marker output contract")
        linked_mode = request.cache_context.get("translationMode") == "conversation"
        if not linked_mode and (request.previous_response_id or request.history_messages):
            raise ValueError("LM Studio Independent cannot send conversation history or a continuation cursor")
        parts = [part for part in request.user_parts if part.strip()]
        source = "\n\n".join(parts)
        if request.image_b64.strip():
            input_value = [
                {"type": "image", "data_url": f"data:{request.image_mime or 'image/jpeg'};base64,{request.image_b64}"},
                {"type": "text", "content": source},
            ]
        else:
            input_value = source
        if not source and not request.image_b64.strip():
            raise ValueError("LM Studio native chat requires a current user message")
        output = output_token_budget(request.user_parts, request.system_text,
                                     unit_count=request.unit_count,
                                     ceiling=self.policy.output_token_ceiling)
        output = guard_request_budget(request, output)
        body = {"model": self.normalize_model(request.model), "input": input_value,
                "stream": True, "store": linked_mode, "max_output_tokens": output}
        limits = request.model_capabilities.get("limits")
        limits = limits if isinstance(limits, dict) else {}
        if (not request.previous_response_id and
                limits.get("scope") == "requested" and
                limits.get("source") == "lmstudio_native_jit_catalogue"):
            requested_context = self._positive_context(limits.get("contextTokens"))
            if not requested_context or request.cache_context.get("reasoningCapabilityVerified") is not True:
                raise ValueError("LM Studio JIT context has no verified catalogue bound")
            body["context_length"] = requested_context
        if request.previous_response_id:
            if not re.fullmatch(r"resp_[A-Za-z0-9_-]{1,256}", request.previous_response_id):
                raise ValueError("LM Studio Conversation continuation cursor is invalid")
            body["previous_response_id"] = request.previous_response_id
        else:
            if request.history_messages:
                raise ValueError("LM Studio Conversation history has no validated provider cursor")
            body["system_prompt"] = request.system_text
        thinking = request.thinking
        capability = request.model_capabilities.get("reasoning")
        capability = capability if isinstance(capability, dict) else {}
        verified = request.cache_context.get("reasoningCapabilityVerified") is True
        requested = normalize_reasoning_preference(
            request.cache_context.get("providerThinkingPreference",
                                      request.cache_context.get("thinkingRequested", thinking)), "off")
        if (requested == "off" and (not verified or thinking != "off")):
            from backend.ai.translation_paths.store import ConversationError
            error = ConversationError("LM Studio cannot verify the selected Thinking preference for this model")
            error.code = "ai_local_thinking_unsupported"
            raise error
        if (not linked_mode and requested == "minimum" and
                (not verified or thinking == "default" and capability.get("supported") is not False)):
            from backend.ai.translation_paths.store import ConversationError
            error = ConversationError("LM Studio Independent cannot verify the selected lowest Thinking setting")
            error.code = "ai_local_thinking_unsupported"
            raise error
        if requested == "minimum" and thinking == "default" and capability.get("supported") is False:
            return body, "not_applicable_non_reasoning_model"
        if requested == "minimum" and thinking == "default":
            return body, "provider_managed_unverified"
        if thinking != "default":
            if not verified and requested == "minimum":
                return body, "provider_managed_unverified"
            if not verified:
                from backend.ai.translation_paths.store import ConversationError
                error = ConversationError("LM Studio has no verified native Thinking control for this model")
                error.code = "ai_local_thinking_unsupported"
                raise error
            if thinking == "off" and capability.get("supported") is False:
                return body, "not_applicable_non_reasoning_model"
            supported = capability.get("supported_efforts") or []
            native = "off" if thinking == "off" and "none" in supported else thinking
            if (capability.get("supported") is not True or
                    (thinking not in supported and not (thinking == "off" and "none" in supported)) or
                    native not in ("off", "on", "low", "medium", "high")):
                from backend.ai.translation_paths.store import ConversationError
                error = ConversationError("Selected LM Studio model has no verified native control for the requested Thinking setting")
                error.code = "ai_local_thinking_unsupported"
                raise error
            body["reasoning"] = native
        return body, f"requested_{thinking}" if "reasoning" in body else "provider_default"

    def generate(self, request):
        body, applied = self.prepare_native_payload(request)
        base = self.normalize_base_url(request.base_url)
        url = base[:-3] + "/api/v1/chat" if base.lower().endswith("/v1") else base + "/api/v1/chat"
        headers = self._headers(request.api_key)
        if request.api_key:
            # Native LM Studio may require its own optional API token.
            headers["Authorization"] = f"Bearer {request.api_key}"
        result = execute_lmstudio_chat(url=url, headers=headers,
            payload=body, model=request.model, expected_ids=request.expected_ids,
            cancel_check=request.cancel_check,
            reject_observed_thinking=normalize_reasoning_preference(
                request.cache_context.get("providerThinkingPreference",
                    request.cache_context.get("thinkingRequested", request.thinking)), "off") == "off")
        if "context_length" in body:
            # The first real chat performs JIT loading. Its model identity was
            # checked at chat.start/end; now verify the actual loaded window
            # before accepting this answer as translated by the selected model.
            listed = self._native_models(request.api_key, request.base_url, 3.0)
            loaded = listed.capabilities.get(request.model, {}).get("limits") or {}
            if (listed.status != "valid" or request.model not in listed.models or
                    loaded.get("source") != "lmstudio_native_loaded_instance" or
                    not self._positive_context(loaded.get("runtimeContextTokens")) or
                    loaded["runtimeContextTokens"] < body["context_length"]):
                from backend.ai.clients.base import provider_output_error, usage_meta
                error = provider_output_error(
                    "LM Studio JIT response has no verified loaded model context",
                    provider="lmstudio", model=result.used_model,
                    input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                    total_tokens=result.total_tokens, finish_reason=None,
                    provider_ms=result.provider_ms, parse_ms=result.parse_ms,
                    timeout_policy="local_connect_bounded_native_total_30m",
                    response_shape="lmstudio_jit_instance_unverified", usage_details=usage_meta(result))
                error.code = "ai_conversation_native_transcript_invalid"
                raise error
            from backend.ai.provider_resolution import remember_model_capabilities
            remember_model_capabilities("lmstudio", request.base_url, request.api_key,
                dict(listed.capabilities), models=listed.models)
        if applied == "requested_off" and result.thinking_tokens is None:
            applied = "requested_off_usage_unreported"
        return result._replace(thinking_applied=applied)


ADAPTER = LocalLmStudioAdapter(POLICY)
SPEC = ProviderSpec(POLICY.provider_id, "openai_chat_completions",
                    POLICY.default_model, POLICY.default_base_url,
                    aliases=POLICY.aliases, model_aliases=POLICY.model_aliases,
                    key_prefixes=POLICY.key_prefixes, local=True, conversation_transport="native_response_cursor", adapter=ADAPTER)

normalize_base_url = ADAPTER.normalize_base_url
normalize_model = ADAPTER.normalize_model
prepare_payload = ADAPTER.prepare_payload

__all__ = ["ADAPTER", "ALIASES", "DEFAULT_BASE_URL", "DEFAULT_MODEL", "LocalLmStudioAdapter",
           "KEY_PREFIXES", "MODEL_ALIASES", "POLICY", "SPEC",
           "normalize_base_url", "normalize_model", "prepare_payload"]
