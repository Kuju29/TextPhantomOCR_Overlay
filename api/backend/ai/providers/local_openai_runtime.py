from __future__ import annotations
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Mapping

import httpx

from backend.ai.generation_defaults import output_token_budget
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.openai_chat import execute_chat_completion

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

    def __post_init__(self) -> None:
        object.__setattr__(self, "aliases", tuple(self.aliases))
        object.__setattr__(self, "model_aliases", MappingProxyType(dict(self.model_aliases)))
        object.__setattr__(self, "key_prefixes", tuple(self.key_prefixes))
        object.__setattr__(self, "strip_paths", tuple(self.strip_paths))
        object.__setattr__(self, "model_allow_prefixes", tuple(self.model_allow_prefixes))
        object.__setattr__(self, "model_deny_prefixes", tuple(self.model_deny_prefixes))

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
        return messages

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
        control_verified = isinstance(reasoning, dict) and reasoning.get("supported") is True \
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

    def generate(self, request: GenerationRequest):
        payload = self.prepare_payload(request)
        reasoning = "local_think" if self.policy.thinking_field in payload else "standard"
        result = execute_chat_completion(
            url=self.normalize_base_url(request.base_url) + self.policy.completion_path,
            headers=self._headers(request.api_key), payload=payload,
            model=request.model, provider_id=self.policy.provider_id, timeout=self._timeout(),
            timeout_policy="local_connect_bounded_read_unbounded",
            expected_ids=list(request.expected_ids), cancel_check=request.cancel_check,
            trace_event=f"ai.{self.policy.provider_id}.generate",
            trace_file=f"ai/providers/local_{self.policy.provider_id}.py",
            trace_fields={"requestedOutputTokens": payload["max_tokens"],
                          "reasoningPolicyApplied": reasoning,
                          "reasoningModeRequested": request.thinking},
        )
        applied = (f"requested_{request.thinking}" if self.policy.thinking_field in payload
                   else "provider_default" if request.thinking == "auto" else "unverified")
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
        models = tuple(model for item in (items or []) if isinstance(item, dict)
                       if (model := str(item.get("id") or "").strip())
                       and (not self.policy.model_allow_prefixes
                            or model.startswith(self.policy.model_allow_prefixes))
                       and not model.startswith(self.policy.model_deny_prefixes))
        return ModelListResult(models=models, status="valid", http_status=response.status_code)

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        normalized = ProbeRequest(model=request.model, api_key=request.api_key,
                                  base_url=self.normalize_base_url(request.base_url),
                                  timeout_sec=request.timeout_sec)
        return openai_chat_probe(normalized, include_bearer=self.policy.auth_optional)

__all__ = ["LocalOpenAIChatAdapter", "LocalOpenAIChatPolicy"]
