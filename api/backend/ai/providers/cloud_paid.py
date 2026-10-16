"""Paid uses a customer session at the operator's Center, never an OpenRouter key."""
import hashlib
import time
import httpx
from backend.ai.provider_contract import ProviderSpec, ModelListResult, ProbeResponse
from backend.ai.clients.base import ChatResult
from backend.ai.clients.provider_error import safe_http_error, ProviderTransportError, safe_diagnostic_label
from backend.ai.providers.cloud_openrouter import prepare_payload
from backend.ai import accounting, wire_trace
from backend.ai.usage import normalize_usage
from backend.paid_center import center_base_url, center_origin
from backend import diagnostics
from backend.ai.center_http import center_client

PROVIDER_ID = "paid"
DEFAULT_BASE_URL = center_base_url() + "/api/customer" if center_base_url() else ""

# These Center codes are emitted before this operation reserves credits or
# dispatches AI. HTTP status alone is not such proof: an upstream 402, an
# unknown Center error or a lost response may follow an actual dispatch.
_CENTER_ADMISSION_STATUSES = {
    "AUTH_REQUIRED": 401, "PAID_REFUND_PENDING": 403, "PAID_ACCOUNT_RESTRICTED": 403,
    "PAID_MODEL_PAUSED": 503, "PAID_PAUSED": 503, "PAID_BUSY": 429, "PAID_CAPACITY_BUSY": 429, "PAID_CREDITS_RESERVED": 429,
    "PAID_RATE_LIMITED": 429, "PAID_DAILY_BUDGET": 429, "MODEL_NOT_ALLOWED": 403,
    "INSUFFICIENT_CREDITS": 402, "MODEL_PRICE_UNVERIFIED": 503,
    "PAID_PRICE_REFRESHING": 503, "PAID_ROUTE_UNAVAILABLE": 503,
    "PAID_QUOTE_REQUIRED": 409, "PAID_QUOTE_INVALID": 409, "PAID_QUOTE_STALE": 409,
    "PAID_QUOTE_PRICE_CHANGED": 409, "IDEMPOTENCY_CONFLICT": 409,
    "AI_NOT_CONFIGURED": 503, "LEDGER_UNAVAILABLE": 503,
    "LEGACY_PAID_RECONCILIATION_REQUIRED": 503, "PAID_IMAGE_UNSUPPORTED": 400,
    "PAID_IMAGE_INVALID": 400, "PAID_IMAGE_TOO_LARGE": 413,
    "CHAT_INPUT_INVALID": 400, "CHAT_INPUT_TOO_LARGE": 413, "PAID_QUEUE_CANCELLED": 409,
    "PAID_THINKING_UNSUPPORTED": 400, "PAID_THINKING_UNVERIFIED": 400,
    "PAID_OUTPUT_UNSUPPORTED": 400, "REASONING_INVALID": 400, "PAID_UNAVAILABLE": 409,
    "CUSTOMER_ACCESS_UNAVAILABLE": 409, "VALIDATION_ERROR": 422,
    "PAID_PROVIDER_KEY_LIMIT": 503, "PAID_PROVIDER_CAPACITY": 503, "PAID_PROVIDER_BALANCE": 502,
}


# Center admission answers that prove nothing was sent to AI and no credit
# was reserved. The API waits and asks again (like a queue) instead of
# failing the image. Nothing here can create a second provider generation.
_ADMISSION_WAIT_CODES = {"PAID_CAPACITY_BUSY", "PAID_CREDITS_RESERVED", "PAID_BUSY"}
def _admission_wait_seconds():
    import os
    try:
        return max(0.0, min(300.0, float(os.environ.get("TP_PAID_ADMISSION_WAIT_SECONDS", "90"))))
    except ValueError:
        return 90.0


ADMISSION_WAIT_SECONDS = _admission_wait_seconds()


def _admission_busy(response):
    if response.status_code != 429:
        return None
    try:
        error = response.json().get("error") or {}
    except (ValueError, AttributeError, TypeError):
        return None
    details = error.get("details") if isinstance(error.get("details"), dict) else {}
    code = str(error.get("code") or "")
    if (code not in _ADMISSION_WAIT_CODES or details.get("upstream_http_status") is not None
            or details.get("provider_dispatched") is True or details.get("credit_reserved") is True
            or details.get("credit_state") not in (None, "not_reserved")):
        return None
    try:
        retry = float(response.headers.get("retry-after") or details.get("retry_after_seconds") or 2)
    except (TypeError, ValueError):
        retry = 2.0
    return code, max(0.5, min(5.0, retry))


def _stream_enabled():
    import os
    # Operator rollback switch: TP_PAID_STREAM=0 restores the JSON-only call.
    return os.environ.get("TP_PAID_STREAM", "1").strip().lower() not in {"0", "false", "off", "no"}


def _post_center(client, url, outgoing, headers, progress=None, expected_ids=None):
    """One Center call. With `stream` the Center relays provider deltas as
    NDJSON; they are shown immediately through content_stream. The terminal
    line is turned back into the exact HTTP response the JSON route returns,
    so admission, replay, error and settlement handling stay one code path.

    ``progress`` is a report-only StreamProgress: the Center owns the
    provider call, its deadline and its settlement, so this API never aborts a
    dispatched Paid request on its own clock; it only shows the phase."""
    if outgoing.get("stream") is not True:
        return client.post(url, json=outgoing, headers=headers)
    import json
    from backend.ai import content_stream
    from backend.ai.clients.base import LineCompletionDetector, ProviderGenerationCancelled
    lines = LineCompletionDetector(list(expected_ids or ()) or None)
    visible_text: list[str] = []
    tail = ""
    with client.stream("POST", url, json=outgoing, headers=headers) as response:
        kind = str(response.headers.get("content-type") or "").lower()
        if not response.is_success or "application/x-ndjson" not in kind:
            response.read()  # Ordinary JSON: errors, replay, or no delta yet.
            return response
        if progress is not None:
            # Only an accepted Center stream opens the phase display: a Center
            # rejection (credits, admission, replay) stays an ordinary HTTP
            # response instead of committing the client's NDJSON stream early.
            progress.opened()
        visible = True
        relay_headers = {name: value for name, value in response.headers.items()
                         if name.lower() in {"x-request-id", "x-tp-trace-id", "x-tp-routing-version",
                                             "x-tp-routing-settings"}}
        for line in response.iter_lines():
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except ValueError:
                raise httpx.DecodingError("Center returned an invalid Paid stream") from None
            kind = event.get("type") if isinstance(event, dict) else None
            if kind == "progress":
                # Optional Center phase rows (reasoning / keep-alive evidence the
                # Center saw from the provider). Older Centers never send them.
                phase = event.get("phase")
                if progress is not None and phase == "thinking":
                    progress.thinking()
                elif progress is not None and phase == "waiting":
                    progress.keepalive()
                continue
            if kind == "delta":
                text = event.get("text")
                if progress is not None and isinstance(text, str) and text:
                    visible_text.append(text)
                    boundary = tail + text
                    tail = boundary[-1:]
                    progress.writing(lines.closed_count("".join(visible_text)) if ">>" in boundary else None)
                if visible and isinstance(text, str) and text:
                    try:
                        content_stream.emit(text)
                    except ProviderGenerationCancelled:
                        # The page left; keep reading so the Center's charge
                        # and usage for this dispatched answer are recorded.
                        visible = False
                continue
            if kind in {"final", "error"} and isinstance(event.get("body"), dict):
                status = event.get("status")
                status = status if type(status) is int and 100 <= status <= 599 else 500
                if kind == "final" and event.get("replayed") is True:
                    relay_headers["x-tp-operation-replayed"] = "true"
                return httpx.Response(status, json=event["body"], headers=relay_headers,
                                      request=response.request)
        # Dispatched work without a terminal line has an unknown outcome.
        raise httpx.RemoteProtocolError("Center Paid stream ended without a result")


def _wait(seconds, cancel_check):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if cancel_check is not None and cancel_check():
            return False
        time.sleep(min(0.25, max(0.0, end - time.monotonic())))
    return not (cancel_check is not None and cancel_check())


# Centers that announced provider routing (X-TP-Routing-Version on a Paid
# response). Only these receive routing_feedback / avoid_host: an older Center
# rejects unknown body fields (extra="forbid").
_ROUTING_CENTERS: set[str] = set()


def _routing_fields(request):
    base = center_base_url()
    if base not in _ROUTING_CENTERS:
        return [], ""
    from backend.ai import routing
    from backend.ai.routing.openrouter import is_repair
    avoid = ""
    if is_repair(request.cache_context):
        hosts = routing.avoid_hosts("paid", request.model, routing.avoid_key(request.api_key, request.cache_context),
                                    len(tuple(request.expected_ids or ())))
        avoid = hosts[-1] if hosts else ""
    return routing.OBS.take_paid_feedback(_feedback_owner(request.api_key)), avoid


def _feedback_owner(api_key):
    """Credential commitment (never the token itself) that keeps feedback per customer."""
    import hashlib
    return hashlib.sha256(("tp-paid-feedback:" + str(api_key or "")).encode()).hexdigest()[:32]


def _return_feedback(items, request=None):
    if items:
        from backend.ai import routing
        routing.OBS.return_paid_feedback(items, _feedback_owner(getattr(request, "api_key", "")))


def _note_routing_version(response):
    try:
        version = str(getattr(response, "headers", {}).get("x-tp-routing-version") or "").strip()
    except Exception:  # noqa: BLE001
        version = ""
    if not version:
        return
    _ROUTING_CENTERS.add(center_base_url())
    from backend.ai import routing
    try:
        settings_version = str(getattr(response, "headers", {}).get("x-tp-routing-settings") or "").strip()
    except Exception:  # noqa: BLE001
        settings_version = ""
    routing.note_center_version(version, settings_version or None)


def _record_paid_attempt(request, operation_id, upstream):
    """Pending until validated; its outcome rides on the next Paid request."""
    if center_base_url() not in _ROUTING_CENTERS:
        return
    from backend.ai import routing
    routing.record("paid", request.model, upstream or "", "unknown", "unvalidated",
                   paid_operation=operation_id, owner=_feedback_owner(request.api_key),
                   avoid=routing.avoid_key(request.api_key, request.cache_context),
                   units=len(tuple(request.expected_ids or ())))


class PaidAdapter:
    def list_models(self, *, api_key, base_url):
        if not center_base_url() or not api_key:
            return ModelListResult(status="missing")
        try:
            diagnostics.emit("paid.models.started", path="/api/customer/me", timeout_seconds=8)
            with center_client(8) as client:
                response = client.get(center_base_url() + "/api/customer/me",
                                      headers={"Authorization": "Bearer " + api_key, **diagnostics.headers()})
            diagnostics.emit("paid.models.response", http_status=response.status_code,
                center_request_id=getattr(response,"headers",{}).get("x-request-id"))
            if response.status_code == 401:
                return ModelListResult(status="invalid_key", http_status=401)
            if not response.is_success:
                return ModelListResult(status="error", http_status=response.status_code)
            payload = response.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
                return ModelListResult(status="error", http_status=response.status_code)
            items = payload["models"]
            if any(not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] for item in items):
                return ModelListResult(status="error", http_status=response.status_code)
            ids = tuple(x["id"] for x in items if isinstance(x, dict) and isinstance(x.get("id"), str))
            return ModelListResult(models=ids, status="valid", http_status=200,
                capabilities={x["id"]: {**(x.get("model_capabilities") or {}), "limits": {**(x.get("model_capabilities") or {}).get("limits", {}), "maxOutputTokens": x.get("workload_max_output", x.get("max_output", 8192))}} for x in items if isinstance(x, dict) and x.get("id") in ids},
                candidates={key: {"eligibility": "usable", "evidence": "center_operator_model_policy"} for key in ids})
        except (httpx.HTTPError, ValueError) as exc:
            diagnostics.emit("paid.models.failed", outcome="error", **diagnostics.fault(exc))
            return ModelListResult(status="unreachable")

    def probe(self, request):
        # A paid probe must never spend credits. Catalogue eligibility is read-only.
        listed = self.list_models(api_key=request.api_key, base_url=request.base_url)
        return ProbeResponse(ok=request.model in listed.models, http_status=listed.http_status,
                             status="eligible" if request.model in listed.models else listed.status)

    def generate(self, request):
        if not center_base_url() or not request.api_key:
            raise ValueError("Paid requires a configured Center and customer login")
        operation = str(request.cache_context.get("operationId") or accounting.diagnostic_identity().get("operationId") or "")
        if not operation:
            raise ValueError("Paid generation requires an operation ID")
        from backend.ai.paid_protocol import require_protocol, stream_supported
        require_protocol(center_base_url(), request.model)
        from backend.ai import content_stream
        streamed = content_stream.active() and _stream_enabled() and stream_supported(center_base_url())
        # The operation id is opaque. OCR text still reaches the Center in
        # messages; customer-supplied prices or debit amounts never do.
        legacy_operation_id = hashlib.sha256((request.api_key + "\0" + operation).encode()).hexdigest()
        operation_id = hashlib.sha256(("tp-paid-v2\0" + operation).encode()).hexdigest()
        outgoing = prepare_payload(request)
        # Center resolves saved intent against its own fresh model metadata.
        outgoing.pop("reasoning", None)
        outgoing["thinking"] = str(request.cache_context.get("thinkingRequested") or request.thinking or "minimum")
        if outgoing["thinking"] == "default": outgoing["thinking"] = "minimum"
        if request.cache_context.get("thinkingProviderDefault") is True:
            # The Center catalogue offers no AI think control for this model
            # (no reasoning, or none that can be set). Center's optional
            # `thinking` is omitted so it sends no reasoning field either.
            outgoing.pop("thinking", None)
        scope = str(request.cache_context.get("conversationScope") or "")
        if scope:
            outgoing["legacy_session_id"] = "tp-c-" + hashlib.sha256(
                (request.api_key + "\0" + scope + "\0" + request.model).encode()).hexdigest()[:48]
            outgoing["session_id"] = "tp-c-" + hashlib.sha256(
                ("tp-paid-session-v2\0" + scope + "\0" + request.model).encode()).hexdigest()[:48]
        outgoing["operation_id"] = operation_id
        outgoing["legacy_operation_id"] = legacy_operation_id
        native = request.model_capabilities.get("limits", {}).get("maxOutputTokens")
        outgoing["legacy_max_tokens"] = max(64, min(8192, native)) if type(native) is int else 8192
        from backend.ai.user_run import identifier as user_run_identifier
        run = user_run_identifier(request.cache_context.get("userRunId"))
        if run:
            # Stable across session refresh; account ownership is enforced by
            # the Center. This groups presentation and cannot change charges.
            outgoing["user_run_id"] = hashlib.sha256(("tp-user-run\0" + run).encode()).hexdigest()
        diagnostics.update(operation_id=operation_id)
        if "max_completion_tokens" in outgoing:
            outgoing["max_tokens"] = outgoing.pop("max_completion_tokens")
        outgoing.pop("response_format", None)  # Conversation uses markers only.
        # prepare_payload uses the same workload/visible/reasoning guard as Manual.
        # Center validates native limits and prices the actual dispatched options.
        outgoing["max_tokens"] = max(64, min(32768, outgoing["max_tokens"]))
        outgoing["output_policy"] = "workload_v1"
        if streamed:
            outgoing["stream"] = True  # Transport only; never part of the charge.
        # Provider routing: the Center decides; this API only reports how
        # earlier Paid answers validated and which host a repair should avoid.
        routing_feedback, avoid_host = _routing_fields(request)
        if routing_feedback:
            outgoing["routing_feedback"] = routing_feedback
        if avoid_host:
            outgoing["avoid_host"] = avoid_host
        started = time.monotonic()
        url = center_base_url() + "/api/customer/chat/completions"
        headers = {**diagnostics.headers(), "Authorization": "Bearer " + request.api_key,
                   "Origin": center_origin(), "Content-Type": "application/json"}
        # Center chat performs strict owned replay before prices/admission.
        # No separate receipt or price-quote round trip for every new operation.
        replay_response = None
        wire_trace.provider_request(url=url, headers=headers, payload=outgoing)
        wire_trace.write_json("04_paid_boundary.json", {"recordKind": "paid_proxy",
            "providerKeyOwner": "center", "operationId": operation_id})
        try:
            if replay_response is not None:
                response=replay_response
                diagnostics.emit('paid.center.receipt_replayed',operation_id=operation_id,provider_dispatched=False)
            else:
                diagnostics.emit("paid.center.dispatch", operation_id=operation_id, model_id=request.model, path="/api/customer/chat/completions", timeout_seconds=250, streamed=streamed)
                progress = None
                if streamed:
                    from backend.ai.transports.stream_progress import StreamProgress, report_sink
                    sink = report_sink()
                    if sink is not None:
                        progress = StreamProgress(enforce=False, report=sink, model=request.model,
                                                  lines_total=len(tuple(request.expected_ids or ())) or None)
                admission_deadline = time.monotonic() + ADMISSION_WAIT_SECONDS
                waits = 0
                while True:
                    with center_client(httpx.Timeout(250, connect=8)) as client:
                        response = (_post_center(client, url, outgoing, headers) if progress is None else
                                    _post_center(client, url, outgoing, headers, progress=progress,
                                                 expected_ids=request.expected_ids))
                    busy = _admission_busy(response)
                    if busy is None or time.monotonic() + busy[1] > admission_deadline:
                        break
                    waits += 1
                    diagnostics.emit("paid.center.admission_wait", outcome="waiting", error_code=busy[0],
                                     wait_seconds=busy[1], attempt=waits, provider_dispatched=False,
                                     credit_reserved=False)
                    if not _wait(busy[1], request.cancel_check):
                        break
        except httpx.HTTPError as exc:
            # The Center may already have sent AI before its response was lost.
            _return_feedback(routing_feedback, request)
            accounting.mark_dispatched()
            diagnostics.emit("paid.center.failed", outcome="uncertain", **diagnostics.fault(exc))
            raise ProviderTransportError("Center could not confirm the Paid request outcome",
                                         provider="paid", model=request.model) from None
        _note_routing_version(response)
        diagnostics.emit("paid.center.response", outcome="ok" if response.is_success else "error", http_status=response.status_code, center_request_id=getattr(response, "headers", {}).get("x-request-id"), center_trace_id=getattr(response, "headers", {}).get("x-tp-trace-id"), elapsed_ms=round((time.monotonic()-started)*1000,2))
        wire_trace.provider_response_omitted(response, streamed=streamed)
        if not response.is_success:
            try:
                body_error = response.json().get("error") or {}
                code = str(body_error.get("code") or "")
            except (ValueError, AttributeError, TypeError): code, body_error = "", {}
            details = body_error.get("details") if isinstance(body_error, dict) else None
            details = details if isinstance(details, dict) else {}
            admission_rejected = (_CENTER_ADMISSION_STATUSES.get(code) == response.status_code
                and details.get("upstream_http_status") is None
                and details.get("provider_dispatched") is not True
                and details.get("credit_reserved") is not True
                and details.get("credit_state") in (None, "not_reserved"))
            if code in {"PAID_PROVIDER_KEY_LIMIT", "PAID_PROVIDER_CAPACITY", "PAID_PROVIDER_BALANCE"}:
                admission_rejected = admission_rejected and details.get("provider_dispatched") is False and details.get("credit_reserved") is False and details.get("credit_state") == "not_reserved"
            historical_expired = (code == "REQUEST_RESULT_EXPIRED" and response.status_code == 409
                and details.get("credit_state") == "settled" and details.get("provider_dispatched") is False)
            if historical_expired:
                diagnostics.emit("paid.center.result_expired", outcome="settled_result_unavailable",
                    charged_tp=details.get("charged_tp"), provider_dispatched=False, automatic_retry=False)
            elif admission_rejected:
                diagnostics.emit("paid.center.admission_blocked", outcome="blocked", error_code=code,
                    center_request_dispatched=True, provider_dispatched=False, credit_reserved=False,
                    owner="control_center", retryable=False)
            else:
                accounting.mark_dispatched()
            diagnostics.emit("paid.center.rejection", outcome="rejected", error_code=code,
                upstream_http_status=details.get("upstream_http_status"),
                provider_error_category=details.get("provider_error_category"),
                credit_state=details.get("credit_state"), next_action=details.get("next_action"),
                automatic_retry=False, center_request_id=getattr(response, "headers", {}).get("x-request-id"))
            failure = safe_http_error("paid", response, request.model)
            failure.centerRequestId = safe_diagnostic_label(response.headers.get("x-request-id"))
            if admission_rejected and code == "VALIDATION_ERROR":
                from backend.ai.paid_protocol import invalidate
                invalidate(center_base_url())
                fields = body_error.get("fields")
                fields = fields if isinstance(fields, list) else []
                protocol_fields = {"body.legacy_session_id", "body.legacy_operation_id", "body.legacy_max_tokens", "body.output_policy"}
                incompatible = any(isinstance(item, dict) and item.get("type") == "extra_forbidden"
                                   and item.get("field") in protocol_fields for item in fields)
                if any(isinstance(item, dict) and item.get("field") in {"body.routing_feedback", "body.avoid_host"}
                       for item in fields):
                    # This Center does not take routing fields: stop sending them.
                    _ROUTING_CENTERS.discard(center_base_url())
                failure.provider_code = "PAID_CENTER_UPGRADE_REQUIRED" if incompatible else "PAID_REQUEST_INVALID"
                diagnostics.emit("paid.center.validation_rejected", outcome="blocked",
                    error_code=failure.provider_code, validation_fields=[{"field": item["field"][:160], "type": item["type"][:80]} for item in fields
                        if isinstance(item, dict) and isinstance(item.get("field"), str) and isinstance(item.get("type"), str)][:30],
                    provider_dispatched=False, credit_reserved=False)
            if historical_expired:
                failure.centerHistoricalResultUnavailable = True
                failure.centerFinancialState = "settled"
                failure.requestDispatched = False
                failure.providerAttempts = 0
                failure.generationAttempts = 0
            if admission_rejected:
                # The adapter, rather than HTTP status/prose classification,
                # supplies this trusted negative dispatch evidence.
                failure.centerAdmissionRejected = True
                failure.centerRequestDispatched = True
                failure.requestDispatched = False
                failure.providerAttempts = 0
                failure.generationAttempts = 0
            # Preserve the Center's outer HTTP response separately from the
            # observed provider status. It is never guessed from prose.
            upstream = details.get("upstream_http_status")
            failure.provider_limit_scope = details.get('scope') if details.get('scope') in {'model','provider','key','account','service','unknown'} else 'unknown'
            failure.center_credit_state = details.get('credit_state')
            failure.center_next_action = details.get('next_action')
            # The Center stopped a streamed call by its progress rules (no charge,
            # credit released): keep the specific reason for the page message.
            if isinstance(details.get('stream_stop'), str):
                failure.stream_stop_code = details['stream_stop'][:64]
            if type(upstream) is int and 100 <= upstream <= 599:
                failure.center_http_status = response.status_code
                failure.status = upstream
            raise failure
        dispatch_marked = False
        try:
            data = response.json()
            if getattr(response, "headers", {}).get("x-tp-operation-replayed") == "true" or data.get("operation_replayed") is True:
                replay_response = response
                diagnostics.emit("paid.center.receipt_replayed", operation_id=data.get("operation_id"), provider_dispatched=False)
            else:
                accounting.mark_dispatched()
                dispatch_marked = True
            text = data["choices"][0]["message"]["content"]
            if not isinstance(text, str):
                raise ValueError("bad content")
            # Receipt replay skips provider_request's secret registration.
            # Redact this diagnostic copy only; the returned answer is intact.
            wire_trace.assembled_response(text.replace(request.api_key, "<redacted>"))
            usage = data.get("usage") or {}
            if not isinstance(usage, dict):
                usage = {}
            prompt, completion = usage.get("prompt_tokens"), usage.get("completion_tokens")
            prompt = prompt if type(prompt) is int and prompt >= 0 else None
            completion = completion if type(completion) is int and completion >= 0 else None
            total = usage.get("total_tokens")
            total = total if type(total) is int and total >= 0 else None
            # The OpenRouter upstream the Center reached (a bounded label, absent
            # on older Centers). Conversation evidence records it per turn.
            upstream = safe_diagnostic_label(data.get("provider")) if isinstance(data.get("provider"), str) else ""
            prompt_details = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
            cached = prompt_details.get("cached_tokens")
            if replay_response is None:
                _record_paid_attempt(request, operation_id, upstream)
            diagnostics.emit("paid.center.completed", outcome="ok", charged_tp=data.get("charged_tp"), balance_tp=data.get("balance_tp"), input_tokens=prompt, output_tokens=completion,
                cached_input_tokens=cached if type(cached) is int and cached >= 0 else None, upstream_provider=upstream or None,
                center_operation_replayed=replay_response is not None, provider_dispatched=replay_response is None)
            timing = data.get('timing') if isinstance(data.get('timing'), dict) else {}
            timing = {name:value for name,value in timing.items()
                      if name in {'prepareMs','admissionWaitMs','upstreamMs','settlementPreCommitMs'}
                      and type(value) is int and 0 <= value <= 3600000}
            diagnostics.emit('paid.center.timing', outcome='replayed' if replay_response is not None else 'ok',
                             timing_scope='center_stages_v1', round_trip_scope='center_round_trip', **timing)
            return ChatResult(text=text, used_model=str(data.get("model") or request.model),
                input_tokens=prompt, output_tokens=completion, total_tokens=total,
                finish_reason=str(data["choices"][0].get("finish_reason") or "stop"),
                provider_ms=0 if replay_response is not None else (time.monotonic() - started) * 1000, usage_source="center_paid",
                terminal_completed=True, terminal_evidence="center_ndjson_final" if streamed else "center_http_json",
                upstream_provider=upstream or None,
                usage_details={**normalize_usage(usage, cost_authoritative=True,
                                               response_id=str(data.get("id") or "")),
                               "billingAuthority": "center_paid",
                               "providerTimingScope": "center_round_trip",
                               "centerTiming": timing,
                               # The original usage/charge stays with the
                               # returned answer; this read sent no new AI.
                               "centerOperationReplayed": replay_response is not None,
                               "chargedTp": data.get("charged_tp"),
                               "balanceTp": data.get("balance_tp")})
        except (ValueError, TypeError, KeyError, IndexError, AttributeError) as exc:
            if replay_response is None and not dispatch_marked:
                # A success status whose body is not a JSON object: the Center
                # accepted the request and may have sent it to AI, so the
                # outcome is uncertain (one usage observation), never "not sent".
                accounting.mark_dispatched()
            diagnostics.emit("paid.center.invalid_completion", outcome="uncertain", **diagnostics.fault(exc))
            raise ProviderTransportError("Center returned an invalid Paid completion",
                                         provider="paid", model=request.model) from None


ADAPTER = PaidAdapter()
SPEC = ProviderSpec(PROVIDER_ID, "openai_chat_completions", "", DEFAULT_BASE_URL,
                    conversation_transport="message_replay", adapter=ADAPTER, rate_rpm=60.0, rate_burst=8)
