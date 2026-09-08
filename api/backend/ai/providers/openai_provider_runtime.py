"""Provider-neutral runtime for standard OpenAI chat-compatible clouds."""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, Mapping, Sequence

import httpx

from backend.ai.generation_defaults import DEFAULT_GENERATION, output_token_budget
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse
from backend.ai.providers.probe_support import openai_chat_probe
from backend.ai.transports.openai_chat import execute_chat_completion

ModelFilter = Callable[[Sequence[object]], list[str]]
CatalogueItems = Callable[[object], Sequence[object]]
ModelResolver = Callable[[str], str]

def bearer_headers(api_key: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers

def data_items(body: object) -> Sequence[object]:
    if isinstance(body, dict):
        value = body.get("data", [])
        return value if isinstance(value, list) else []
    return []

def array_or_data_items(body: object) -> Sequence[object]:
    return body if isinstance(body, list) else data_items(body)

def all_model_ids(items: Sequence[object]) -> list[str]:
    return [str(item.get("id")).strip() for item in items if isinstance(item, dict) and str(item.get("id") or "").strip()]

@dataclass(frozen=True, slots=True)
class OpenAIProviderPolicy:
    provider_id: str
    trace_file: str
    # Optional request fields are leaf-owned.  Compatibility with an OpenAI
    # response shape is not evidence that every gateway accepts the same input.
    temperature: float | None
    output_budget_field: str | None
    reasoning_policy: str
    model_filter: ModelFilter = all_model_ids
    catalogue_items: CatalogueItems = data_items
    list_path: str = "/models"
    list_params: Mapping[str, object] = field(default_factory=dict)
    model_resolver: ModelResolver | None = None

    def __post_init__(self) -> None:
        if self.output_budget_field not in {None, "max_tokens", "max_completion_tokens"}:
            raise ValueError("unsupported output budget field")
        if self.reasoning_policy not in {"unsupported", "requires_verified_capability"}:
            raise ValueError("unsupported reasoning policy")
        object.__setattr__(self, "list_params", MappingProxyType(dict(self.list_params)))

def build_messages(request: GenerationRequest) -> list[dict[str, Any]]:
    parts = [part for part in request.user_parts if part.strip()]
    system_text = request.system_text
    source_text = "\n\n".join(parts)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_text}]
    if request.image_b64:
        messages.append({"role": "user", "content": [
            {"type": "text", "text": source_text},
            {"type": "image_url", "image_url": {"url": f"data:{request.image_mime};base64,{request.image_b64}"}},
        ]})
    else:
        if source_text:
            messages.append({"role": "user", "content": source_text})
    return messages

def build_payload(request: GenerationRequest, model: str, policy: OpenAIProviderPolicy) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": build_messages(request),
    }
    if policy.temperature is not None:
        payload["temperature"] = policy.temperature
    if policy.output_budget_field is not None:
        payload[policy.output_budget_field] = output_token_budget(
            request.user_parts, request.system_text, unit_count=request.unit_count,
        )
    if policy.output_budget_field is not None:
        from backend.ai.workload import guard_request_budget
        payload[policy.output_budget_field] = guard_request_budget(request, payload[policy.output_budget_field])
    # No reasoning field is shared here. A provider that gains a verified
    # model capability must own its exact wire schema in its leaf adapter.
    return payload

class OpenAIProviderAdapter:
    def __init__(self, policy: OpenAIProviderPolicy) -> None:
        self.policy = policy

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        return openai_chat_probe(request)

    def generate(self, request: GenerationRequest):
        resolver = self.policy.model_resolver
        model = resolver(request.model) if resolver else request.model
        payload = build_payload(request, model, self.policy)
        return execute_chat_completion(
            url=request.base_url.rstrip("/") + "/chat/completions",
            headers=bearer_headers(request.api_key),
            payload=payload,
            model=model,
            provider_id=self.policy.provider_id,
            timeout=DEFAULT_GENERATION.timeout_sec,
            timeout_policy="cloud_default",
            expected_ids=list(request.expected_ids),
            cancel_check=request.cancel_check,
            trace_file=self.policy.trace_file,
            trace_fields={
                "temperatureSent": "temperature" in payload,
                "outputBudgetField": self.policy.output_budget_field,
                "requestedOutputTokens": (
                    payload.get(self.policy.output_budget_field)
                    if self.policy.output_budget_field else None
                ),
                "reasoningPolicy": self.policy.reasoning_policy,
                "reasoningControlSent": False,
            },
        )

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        if not api_key or not base_url:
            return ModelListResult(status="missing")
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.get(
                    base_url.rstrip("/") + self.policy.list_path,
                    headers=bearer_headers(api_key),
                    params=dict(self.policy.list_params) or None,
                )
        except httpx.RequestError as exc:
            return ModelListResult(status="unreachable", error=type(exc).__name__)
        if not response.is_success:
            status = "invalid_key" if response.status_code == 401 else "forbidden" if response.status_code == 403 else "error"
            return ModelListResult(status=status, http_status=response.status_code)
        try:
            body = response.json()
        except ValueError:
            return ModelListResult(status="error", http_status=response.status_code, error="invalid_json")
        models = self.policy.model_filter(self.policy.catalogue_items(body))
        return ModelListResult(models=models, status="valid", http_status=response.status_code)

__all__ = ["OpenAIProviderAdapter", "OpenAIProviderPolicy", "all_model_ids", "array_or_data_items", "data_items"]
