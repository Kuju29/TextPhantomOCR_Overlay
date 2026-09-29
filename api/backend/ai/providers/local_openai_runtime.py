from __future__ import annotations
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any, Mapping
import hashlib
import threading
import time

import httpx

from backend.ai.generation_defaults import output_token_budget
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.reasoning_preference import normalize_reasoning_preference
from backend.ai.transports.openai_chat import execute_chat_completion
from backend.ai.workload import WorkloadBudgetError, positive


@dataclass(slots=True)
class RuntimeContextEvidence:
    """Private, one-use READY proof, never copied into workload or wire traces."""
    provider: str
    model: str
    base_url: str
    key_digest: str = field(repr=False)
    limits: dict[str, Any] = field(repr=False)
    issued_at: float = field(repr=False)
    used: bool = field(default=False, repr=False)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def matches(self, provider: str, model: str, base_url: str, api_key: str) -> bool:
        with self.lock:
            return (not self.used and (self.provider, self.model, self.base_url, self.key_digest) == (
                provider, model, base_url, hashlib.sha256(api_key.encode()).hexdigest()) and
                time.monotonic() - self.issued_at <= 5.0)

    def consume(self, provider: str, model: str, base_url: str, api_key: str) -> bool:
        with self.lock:
            if self.used or (self.provider, self.model, self.base_url, self.key_digest) != (
                provider, model, base_url, hashlib.sha256(api_key.encode()).hexdigest()):
                return False
            self.used = True
            return time.monotonic() - self.issued_at <= 5.0


def _runtime_error(reason: str) -> WorkloadBudgetError:
    error = WorkloadBudgetError(f"Selected Local model's current runtime context {reason}; no generation was sent")
    error.diagnostics = {"constraintScope": "per_request", "constraint": "runtime_context_unverified"}
    return error


def _numeric_path(data: Mapping[str, Any], fields: tuple[str, ...]) -> int | None:
    value: Any = data
    for field in fields:
        if not isinstance(value, Mapping):
            return None
        value = value.get(field)
    return positive(value) if fields else None

@dataclass(frozen=True, slots=True)
class LocalOpenAIChatPolicy:
    provider_id: str
    aliases: tuple[str, ...]
    default_model: str
    default_base_url: str
    model_aliases: Mapping[str, str] = field(default_factory=dict)
    key_prefixes: tuple[str, ...] = ()
    auth_optional: bool = False
    # OpenAI-compatible is a transport shape, not evidence that a runtime
    # accepts any particular reasoning control.  A concrete provider must opt
    # in only when its native API documents that field.
    thinking_field: str | None = None
    # Omit sampling controls unless a concrete leaf has independently opted in.
    # Sharing the OpenAI wire shape is not evidence that a local runtime accepts
    # or interprets a particular temperature value.
    temperature: float | None = None
    output_token_ceiling: int = 8192
    append_path: str = "/v1"
    completion_path: str = "/chat/completions"
    discovery_path: str = "/models"
    strip_paths: tuple[str, ...] = ("/chat/completions",)
    model_allow_prefixes: tuple[str, ...] = ()
    model_deny_prefixes: tuple[str, ...] = ()
    # Only leaves with a documented live model field opt into runtime probing.
    # A props endpoint may supply the allocation for a sole exact model.
    runtime_context_fields: tuple[str, ...] = ()
    # Leaves that own an additional native runtime endpoint can publish a
    # current bound through list_models without inventing a /models field.
    runtime_context_probe: bool = False
    runtime_props_path: str = ""
    runtime_props_context_fields: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "aliases", tuple(self.aliases))
        object.__setattr__(self, "model_aliases", MappingProxyType(dict(self.model_aliases)))
        object.__setattr__(self, "key_prefixes", tuple(self.key_prefixes))
        object.__setattr__(self, "strip_paths", tuple(self.strip_paths))
        object.__setattr__(self, "model_allow_prefixes", tuple(self.model_allow_prefixes))
        object.__setattr__(self, "model_deny_prefixes", tuple(self.model_deny_prefixes))
        object.__setattr__(self, "runtime_context_fields", tuple(self.runtime_context_fields))
        object.__setattr__(self, "runtime_props_context_fields", tuple(self.runtime_props_context_fields))

class LocalOpenAIChatAdapter:
    def __init__(self, policy: LocalOpenAIChatPolicy) -> None:
        self.policy = policy

    def normalize_base_url(self, value: str) -> str:
        root = (value or self.policy.default_base_url).strip().rstrip("/")
        lowered = root.lower()
        for suffix in self.policy.strip_paths:
            if lowered.endswith(suffix.lower()):
                root = root[: -len(suffix)].rstrip("/")
                break
        path = self.policy.append_path
        if path and not root.lower().endswith(path.lower()):
            root += path
        return root

    def normalize_model(self, value: str) -> str:
        model = (value or "").strip() or self.policy.default_model
        return self.policy.model_aliases.get(model, model)

    def inspect_runtime_context(self, *, model: str, api_key: str, base_url: str,
                                prior_limits: Mapping[str, Any] | None = None) -> RuntimeContextEvidence:
        """Check the exact running model when the provider owns a live field."""
        if not (self.policy.runtime_context_fields or self.policy.runtime_context_probe):
            raise ValueError("This Local adapter does not publish runtime context")
        listed = self.list_models(api_key=api_key, base_url=base_url)
        selected = self.normalize_model(model)
        if listed.status != "valid" or listed.models.count(selected) != 1:
            raise _runtime_error("is unavailable from the live model list")
        limits = dict(listed.capabilities.get(selected, {}).get("limits") or {})
        if (self.policy.runtime_props_path and self.policy.runtime_props_context_fields
                and not limits and listed.models == (selected,)):
            # An unqualified props endpoint is usable only when the exact
            # selected model is the sole /models row.
            root = self.normalize_base_url(base_url)
            suffix = self.policy.append_path
            if suffix and root.lower().endswith(suffix.lower()):
                root = root[:-len(suffix)].rstrip("/")
            props_url = root + self.policy.runtime_props_path
            try:
                with httpx.Client(timeout=3.0) as client:
                    response = client.get(props_url, headers=self._headers(api_key))
                props = response.json() if response.is_success else {}
                runtime = _numeric_path(props, self.policy.runtime_props_context_fields)
                if runtime:
                    limits = {"contextTokens": runtime, "runtimeContextTokens": runtime,
                              "scope": "runtime", "source": self.policy.provider_id + "-models-props"}
            except (httpx.RequestError, ValueError, TypeError, AttributeError):
                pass  # Unsupported /props leaves the capacity unknown.
        previous = prior_limits if isinstance(prior_limits, Mapping) else {}
        verified_source = str(previous.get("source") or "")
        if (positive(previous.get("contextTokens")) and
                previous.get("scope") == "runtime" and
                (verified_source.startswith(self.policy.provider_id + "-models") or
                 self.policy.runtime_context_probe and self.policy.provider_id == "koboldcpp" and
                 verified_source == "koboldcpp-api-extra-true-max-context-length") and
                not positive(limits.get("contextTokens"))):
            raise _runtime_error("lost its previously verified numeric bound")
        return RuntimeContextEvidence(
            self.policy.provider_id, selected, self.normalize_base_url(base_url),
            hashlib.sha256(api_key.encode()).hexdigest(), limits, time.monotonic())

    @staticmethod
    def build_messages(request: GenerationRequest) -> list[dict[str, Any]]:
        system_text = request.system_text
        messages: list[dict[str, Any]] = [{"role": "system", "content": system_text}]
        parts = [part for part in request.user_parts if part.strip()]
        source_text = "\n\n".join(parts)
        if request.image_b64.strip():
            content: list[dict[str, Any]] = [{"type": "image_url", "image_url": {"url": f"data:{request.image_mime or 'image/jpeg'};base64,{request.image_b64}"}}]
            if source_text:
                content.append({"type": "text", "text": source_text})
            messages.append({"role": "user", "content": content})
        else:
            if source_text:
                messages.append({"role": "user", "content": source_text})
        from backend.ai.translation_paths.messages import insert_history
        return insert_history(messages, request.history_messages, "openai_image_first")

    def prepare_payload(self, request: GenerationRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.normalize_model(request.model),
            "messages": self.build_messages(request),
            "max_tokens": output_token_budget(request.user_parts, request.system_text,
                                               unit_count=request.unit_count,
                                               ceiling=self.policy.output_token_ceiling),
        }
        from backend.ai.workload import guard_request_budget
        payload["max_tokens"] = guard_request_budget(request, payload["max_tokens"])
        if self.policy.temperature is not None:
            payload["temperature"] = self.policy.temperature
        reasoning = request.model_capabilities.get("reasoning", {})
        control_verified = request.cache_context.get("reasoningCapabilityVerified") is True and \
            isinstance(reasoning, dict) and reasoning.get("supported") is True \
            and reasoning.get("control") in {"toggle", "boolean"}
        if self.policy.thinking_field and control_verified and request.thinking in {"on", "off"}:
            payload[self.policy.thinking_field] = request.thinking == "on"
        return payload

    def _headers(self, api_key: str) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.policy.auth_optional and api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    @staticmethod
    def _timeout() -> Any:
        factory = getattr(httpx, "Timeout", None)
        return factory(connect=10.0, read=None, write=30.0, pool=10.0) if factory else 600.0

    def _admit_thinking(self, request: GenerationRequest, payload: dict[str, Any]) -> str:
        """Never mistake an omitted OpenAI-compatible field for an Off switch.

        The caller preserves the original preference even if capability
        resolution changed Lowest available or an unsupported named effort to
        provider default. Only server-proven model facts can allow an explicit
        preference; a client-supplied capability snapshot is insufficient.
        """
        requested = normalize_reasoning_preference(
            request.cache_context.get("thinkingRequested", request.thinking), "off")
        if requested == "default":
            return "provider_default"
        verified = request.cache_context.get("reasoningCapabilityVerified") is True
        reasoning = request.model_capabilities.get("reasoning")
        reasoning = reasoning if isinstance(reasoning, dict) else {}
        if (requested in {"off", "minimum"} and verified and
                reasoning.get("supported") is False):
            return "not_applicable_non_reasoning_model"
        if (verified and self.policy.thinking_field and
                request.thinking in {"on", "off"} and
                payload.get(self.policy.thinking_field) is (request.thinking == "on") and
                (requested == request.thinking or requested == "minimum")):
            return f"requested_{request.thinking}"
        if requested == "minimum":
            # The compatibility endpoint offers no model-specific control for
            # these runtimes. Keep Lowest as intent, send no guessed field and
            # report that the provider chooses its own unverified minimum.
            return "provider_managed_unverified"
        from backend.ai.translation_paths.store import ConversationError
        error = ConversationError(
            f"{self.policy.provider_id} cannot verify and apply Thinking {requested} "
            "for this local model")
        error.code = "ai_local_thinking_unsupported"
        raise error

    def generate(self, request: GenerationRequest):
        if self.policy.runtime_context_fields or self.policy.runtime_context_probe:
            supplied = request.cache_context.get("_localRuntimeEvidence")
            valid = (isinstance(supplied, RuntimeContextEvidence) and
                     supplied.consume(self.policy.provider_id, self.normalize_model(request.model),
                                      self.normalize_base_url(request.base_url), request.api_key))
            evidence = supplied if valid else self.inspect_runtime_context(
                model=request.model, api_key=request.api_key, base_url=request.base_url,
                prior_limits=(request.model_capabilities.get("limits") or {}))
            previous = request.model_capabilities.get("limits") or {}
            if supplied is not None and not valid and isinstance(supplied, RuntimeContextEvidence):
                # Conversation.prepare sized/truncated history against this
                # operation's earlier evidence. A changed runtime invalidates
                # that preparation; do not silently dispatch the old request.
                if positive(previous.get("contextTokens")) != positive(evidence.limits.get("contextTokens")):
                    raise _runtime_error("changed after the Conversation batch was prepared")
            request = replace(request, model_capabilities={
                "limits": dict(evidence.limits),
            }, cache_context={
                **dict(request.cache_context), "reasoningCapabilityVerified": False,
            })
        payload = self.prepare_payload(request)
        applied = self._admit_thinking(request, payload)
        reasoning = "local_think" if self.policy.thinking_field in payload else "standard"
        result = execute_chat_completion(
            url=self.normalize_base_url(request.base_url) + self.policy.completion_path,
            headers=self._headers(request.api_key), payload=payload,
            model=request.model, provider_id=self.policy.provider_id, timeout=self._timeout(),
            timeout_policy="local_connect_bounded_read_unbounded",
            expected_ids=list(request.expected_ids), cancel_check=request.cancel_check,
            trace_event=f"ai.{self.policy.provider_id}.generate",
            trace_file=f"ai/providers/local_{self.policy.provider_id}.py",
            local_provider=True,
            trace_fields={"requestedOutputTokens": payload["max_tokens"],
                          "reasoningPolicyApplied": reasoning,
                          "reasoningModeRequested": request.cache_context.get(
                              "thinkingRequested", request.thinking),
                          "reasoningModeSelected": request.thinking},
        )
        if applied in {"not_applicable_non_reasoning_model", "requested_off"}:
            from backend.ai.clients.base import provider_output_error, usage_meta
            usage = usage_meta(result)
            reported = (result.thinking_tokens, usage.get("thinkingTokens"))
            observed = [value for value in reported if type(value) is int and value > 0]
            if observed or result.reasoning_observed:
                # A positive provider count overrides stale model metadata.
                # Reject the answer before Conversation can commit this turn;
                # keep the dispatched generation's usage receipt intact.
                error = provider_output_error(
                    "Local AI returned Thinking despite the selected Off policy",
                    provider=self.policy.provider_id, model=result.used_model,
                    input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                    total_tokens=result.total_tokens, finish_reason=None,
                    provider_ms=result.provider_ms, parse_ms=result.parse_ms,
                    timeout_policy="local_connect_bounded_read_unbounded",
                    response_shape="local_openai_chat_thinking",
                    usage_details=usage,
                )
                error.code = "ai_local_thinking_violated"
                error.structural_details["observedThinkingTokens"] = max(observed) if observed else None
                error.structural_details["reasoningContentObserved"] = bool(result.reasoning_observed)
                error.requestDispatched = True
                error.providerAttempts = error.generationAttempts = 1
                raise error
            if applied == "requested_off" and not any(
                    type(value) is int and value == 0 for value in reported):
                applied = "requested_off_usage_unreported"
        return result._replace(thinking_applied=applied)

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        try:
            with httpx.Client(timeout=3.0) as client:
                response = client.get(self.normalize_base_url(base_url) + self.policy.discovery_path,
                                      headers=self._headers(api_key))
        except httpx.RequestError as exc:
            return ModelListResult(status="unreachable", error=type(exc).__name__)
        if not response.is_success:
            return ModelListResult(status="error", http_status=response.status_code)
        try:
            data = response.json()
        except ValueError:
            return ModelListResult(status="error", http_status=response.status_code,
                                   error="invalid_json")
        items = data.get("data") if isinstance(data, dict) else data
        models, capabilities = [], {}
        for item in (items or []):
            if not isinstance(item, dict):
                continue
            model = str(item.get("id") or "").strip()
            if not model or (self.policy.model_allow_prefixes and
                    not model.startswith(self.policy.model_allow_prefixes)) or model.startswith(self.policy.model_deny_prefixes):
                continue
            models.append(model)
            context = _numeric_path(item, self.policy.runtime_context_fields)
            if context:
                capabilities[model] = {"limits": {"contextTokens": context,
                    "runtimeContextTokens": context, "scope": "runtime",
                    "source": self.policy.provider_id + "-models"}}
        return ModelListResult(models=tuple(models), status="valid", http_status=response.status_code,
                               capabilities=capabilities)

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        normalized = ProbeRequest(model=request.model, api_key=request.api_key,
                                  base_url=self.normalize_base_url(request.base_url),
                                  timeout_sec=request.timeout_sec)
        return openai_chat_probe(normalized, include_bearer=self.policy.auth_optional)

__all__ = ["LocalOpenAIChatAdapter", "LocalOpenAIChatPolicy"]
