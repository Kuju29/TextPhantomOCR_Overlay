"""Paid uses a customer session at the operator's Center, never an OpenRouter key."""
import hashlib
import time
import httpx
from backend.ai.provider_contract import ProviderSpec, ModelListResult, ProbeResponse
from backend.ai.clients.base import ChatResult
from backend.ai.clients.provider_error import safe_http_error, ProviderTransportError
from backend.ai.providers.cloud_openrouter import prepare_payload
from backend.ai import accounting
from backend.paid_center import center_base_url, center_origin

PROVIDER_ID = "paid"
DEFAULT_BASE_URL = center_base_url() + "/api/customer" if center_base_url() else ""


class PaidAdapter:
    def list_models(self, *, api_key, base_url):
        if not center_base_url() or not api_key:
            return ModelListResult(status="missing")
        try:
            with httpx.Client(timeout=8, follow_redirects=False, trust_env=False) as client:
                response = client.get(center_base_url() + "/api/customer/me",
                                      headers={"Authorization": "Bearer " + api_key})
            if response.status_code == 401:
                return ModelListResult(status="invalid_key", http_status=401)
            if not response.is_success:
                return ModelListResult(status="error", http_status=response.status_code)
            items = response.json().get("models") or []
            ids = tuple(x["id"] for x in items if isinstance(x, dict) and isinstance(x.get("id"), str))
            return ModelListResult(models=ids, status="valid", http_status=200,
                candidates={key: {"eligibility": "usable", "evidence": "center_operator_model_policy"} for key in ids})
        except (httpx.HTTPError, ValueError):
            return ModelListResult(status="unreachable")

    def probe(self, request):
        # A paid probe must never spend credits. Catalogue eligibility is read-only.
        listed = self.list_models(api_key=request.api_key, base_url=request.base_url)
        return ProbeResponse(ok=request.model in listed.models, http_status=listed.http_status,
                             status="eligible" if request.model in listed.models else listed.status)

    def generate(self, request):
        if not center_base_url() or not request.api_key:
            raise ValueError("Paid requires a configured Center and customer login")
        if request.image_b64:
            raise ValueError("Paid page-image input is not enabled for this local pilot")
        operation = str(request.cache_context.get("operationId") or "")
        if not operation:
            raise ValueError("Paid generation requires an operation ID")
        # The Center sees an opaque stable id, never a page URL, OCR text or
        # a browser-controlled amount to debit.
        operation_id = hashlib.sha256((request.api_key + "\0" + operation).encode()).hexdigest()
        outgoing = prepare_payload(request)
        scope = str(request.cache_context.get("conversationScope") or "")
        if scope:
            outgoing["session_id"] = "tp-c-" + hashlib.sha256(
                (request.api_key + "\0" + scope + "\0" + request.model).encode()).hexdigest()[:48]
        outgoing["operation_id"] = operation_id
        if "max_completion_tokens" in outgoing:
            outgoing["max_tokens"] = outgoing.pop("max_completion_tokens")
        outgoing.pop("response_format", None)  # Conversation uses markers only.
        started = time.monotonic()
        try:
            accounting.mark_dispatched()
            with httpx.Client(timeout=httpx.Timeout(130, connect=8), follow_redirects=False,
                              trust_env=False) as client:
                response = client.post(center_base_url() + "/api/customer/chat/completions",
                    json=outgoing, headers={"Authorization": "Bearer " + request.api_key,
                                            "Origin": center_origin(), "Content-Type": "application/json"})
        except httpx.HTTPError:
            raise ProviderTransportError("Center could not confirm the Paid request outcome",
                                         provider="paid", model=request.model) from None
        if not response.is_success:
            raise safe_http_error("paid", response, request.model)
        try:
            data = response.json()
            text = data["choices"][0]["message"]["content"]
            if not isinstance(text, str):
                raise ValueError("bad content")
            usage = data.get("usage") or {}
            if not isinstance(usage, dict):
                usage = {}
            prompt, completion = usage.get("prompt_tokens"), usage.get("completion_tokens")
            prompt = prompt if type(prompt) is int and prompt >= 0 else None
            completion = completion if type(completion) is int and completion >= 0 else None
            total = usage.get("total_tokens")
            total = total if type(total) is int and total >= 0 else None
            return ChatResult(text=text, used_model=str(data.get("model") or request.model),
                input_tokens=prompt, output_tokens=completion, total_tokens=total,
                finish_reason=str(data["choices"][0].get("finish_reason") or "stop"),
                provider_ms=(time.monotonic() - started) * 1000, usage_source="center_paid",
                terminal_completed=True, terminal_evidence="center_http_json",
                usage_details={"inputTokens": prompt, "outputTokens": completion,
                               "totalTokens": total, "source": "center_paid",
                               "chargedTp": data.get("charged_tp"),
                               "balanceTp": data.get("balance_tp")})
        except (ValueError, TypeError, KeyError, IndexError):
            raise ProviderTransportError("Center returned an invalid Paid completion",
                                         provider="paid", model=request.model) from None


ADAPTER = PaidAdapter()
SPEC = ProviderSpec(PROVIDER_ID, "openai_chat_completions", "", DEFAULT_BASE_URL,
                    adapter=ADAPTER, rate_rpm=60.0, rate_burst=8)
