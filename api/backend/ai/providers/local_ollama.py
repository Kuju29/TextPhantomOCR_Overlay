"""Native Ollama provider using `/api/chat` and `/api/tags`."""

from __future__ import annotations
from typing import Any

import httpx, time, threading, json
from backend.ai import wire_trace, accounting

from backend import trace
from backend.ai.generation_defaults import DEFAULT_GENERATION, output_token_budget
from backend.ai.clients.base import ChatResult, LineCompletionDetector, provider_output_error, token_usage
from backend.ai.clients.provider_error import safe_http_error
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeRequest, ProbeResponse, ProviderSpec
from backend.ai.providers.probe_support import response_error

_USAGE_DRAIN_GRACE_SEC = 2.0
_DRAIN_WATCH_POLL_SEC = 0.025
DEFAULT_MODEL = "llama3.1"
DEFAULT_BASE_URL = "http://localhost:11434"
ALIASES = ("local", "llama")
KEY_PREFIXES: tuple[str, ...] = ()
MODEL_ALIASES: dict[str, str] = {}

def _thinking_mode(selected: str, capabilities: Any) -> str:
    reasoning = capabilities.get("reasoning", {}) if isinstance(capabilities, dict) else {}
    requested = "on" if selected == "on" else "off"
    if isinstance(reasoning, dict) and reasoning.get("mandatory") is True and requested == "off":
        return "required"
    if isinstance(reasoning, dict) and reasoning.get("supported") is True \
            and reasoning.get("control") in {"toggle", "boolean"}:
        return requested
    return "omit"

class OllamaAdapter:
    """Provider-owned native Ollama generation and tag discovery."""

    def probe(self, request: ProbeRequest) -> ProbeResponse:
        payload = {"model": request.model,
                   "messages": [{"role": "user", "content": "Reply only OK."}],
                   "stream": False, "options": {"num_predict": 8}}
        thinking = _thinking_mode("off", dict(request.model_capabilities))
        if thinking == "required":
            return ProbeResponse(False, 0, "local_ai_thinking_required",
                                 "The selected Ollama model requires thinking")
        if thinking == "off":
            payload["think"] = False
        with httpx.Client(timeout=request.timeout_sec) as client:
            response = client.post(normalize_base_url(request.base_url) + "/api/chat",
                                   headers={"Content-Type": "application/json"}, json=payload)
        if not response.is_success:
            return ProbeResponse(False, response.status_code, error=response_error(response))
        try:
            data = response.json()
            if not isinstance(data, dict): raise ValueError("invalid response shape")
            _extract_text(data)
        except (ValueError, RuntimeError) as exc:
            return ProbeResponse(False, response.status_code, "invalid_model_output", str(exc))
        return ProbeResponse(True, response.status_code)

    def generate(self, request: GenerationRequest) -> ChatResult:
        thinking = _thinking_mode(request.thinking, dict(request.model_capabilities))
        if thinking == "required":
            raise RuntimeError("local_ai_thinking_required: the selected Ollama model requires thinking")
        if thinking == "omit":
            thinking = "auto"
        result = generate(
            request.base_url or DEFAULT_BASE_URL, request.model, request.system_text,
            list(request.user_parts), image_b64=request.image_b64,
            image_mime=request.image_mime,
            response_schema=dict(request.response_schema or {}) or None,
            thinking=thinking, unit_count=request.unit_count,
            cancel_check=request.cancel_check, expected_ids=list(request.expected_ids),
            **({"workload": dict(request.workload), "model_capabilities": dict(request.model_capabilities)}
               if request.workload else {}),
        )
        # Boolean think is a request, not acknowledgement (GPT-OSS ignores it).
        applied = f"requested_{thinking}" if thinking in {"off", "on"} else (
            "provider_default" if request.thinking == "auto" else "unverified")
        return (result._replace(thinking_applied=applied)
                if hasattr(result, "_replace") else result)

    def list_models(self, *, api_key: str, base_url: str) -> ModelListResult:
        _ = api_key
        result = models_status(base_url or DEFAULT_BASE_URL)
        return ModelListResult(models=tuple(result["models"]), status=result["status"],
                               http_status=result["http_status"], error=result["error"])

ADAPTER = OllamaAdapter()
SPEC = ProviderSpec(
    provider_id="ollama", protocol="ollama_native_chat",
    default_model=DEFAULT_MODEL, default_base_url=DEFAULT_BASE_URL, aliases=ALIASES,
    local=True, default_local=True, adapter=ADAPTER,
)

def normalize_base_url(base_url: str) -> str:
    """Return an Ollama server root, migrating a legacy trailing ``/v1``."""
    root = (base_url or "").strip().rstrip("/")
    if root.lower().endswith("/v1"):
        root = root[:-3].rstrip("/")
    return root

def _content_text(value: Any) -> str:
    """Losslessly join common Ollama text content shapes."""
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for part in value:
        if isinstance(part, str):
            text = part
        elif isinstance(part, dict):
            text = part.get("text") or part.get("content") or ""
        else:
            text = ""
        if isinstance(text, str) and text:
            parts.append(text)
    return "".join(parts).strip()

def _extract_text(data: dict) -> str:
    message = data.get("message") or {}
    text = _content_text(message.get("content")) if isinstance(message, dict) else ""
    done_reason = str(data.get("done_reason") or "").strip()
    if data.get("done") is True and done_reason and done_reason not in ("stop",):
        raise RuntimeError(f"Ollama response was incomplete (done_reason={done_reason})")
    if text:
        return text
    has_thinking = bool(
        isinstance(message, dict)
        and (message.get("thinking") or message.get("reasoning") or message.get("reasoning_content"))
    )
    if has_thinking:
        # Never include the reasoning itself: it can contain source dialogue,
        # private prompt context, or model chain-of-thought.
        suffix = f" (done_reason={done_reason})" if done_reason else ""
        raise RuntimeError(
            "Ollama returned thinking/reasoning but no final answer"
            f"{suffix}; turn AI thinking off or choose a compatible model"
        )
    suffix = f" (done_reason={done_reason})" if done_reason else ""
    raise RuntimeError(f"Ollama returned no final text{suffix}")

def _messages(
    system_text: str,
    user_parts: list[str],
    image_b64: str = "",
) -> list[dict]:
    messages: list[dict] = [{"role": "system", "content": system_text}]
    clean_parts = [part for part in user_parts if (part or "").strip()]
    source_text = "\n\n".join(clean_parts)
    if image_b64.strip():
        messages.append({
            "role": "user",
            "content": source_text,
            "images": [image_b64.strip()],
        })
    else:
        if source_text:
            messages.append({"role": "user", "content": source_text})
    return messages

def list_models(base_url: str, *, timeout_sec: float = 3.0) -> list[str]:
    """Return installed Ollama model names from the native tags endpoint."""
    url = normalize_base_url(base_url) + "/api/tags"
    try:
        with httpx.Client(timeout=timeout_sec) as client:
            response = client.get(url)
    except httpx.RequestError as exc:
        raise RuntimeError(
            f"Ollama transport error (operation=list_models, errorType={type(exc).__name__})"
        ) from exc
    try:
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPStatusError as exc:
        raise safe_http_error("Ollama", response, "model-list") from exc
    except ValueError as exc:
        raise RuntimeError("Ollama model list returned invalid JSON") from exc
    if not isinstance(data, dict):
        raise RuntimeError("Ollama model list returned an invalid response shape")
    models: list[str] = []
    for item in data.get("models") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("model") or "").strip()
        if name:
            models.append(name)
    return models

def models_status(base_url: str, *, timeout_sec: float = 3.0) -> dict:
    """Enumerate tags while preserving settings-facing reachability status."""
    try:
        return {
            "models": list_models(base_url, timeout_sec=timeout_sec),
            "status": "valid",
            "http_status": 200,
            "error": "",
        }
    except RuntimeError as exc:
        text = str(exc)
        status = "unreachable" if "transport error" in text else "error"
        return {
            "models": [],
            "status": status,
            "http_status": 0,
            "error": text[:240],
        }

def generate(
    base_url: str,
    model: str,
    system_text: str,
    user_parts: list[str],
    *,
    image_b64: str = "",
    image_mime: str = "image/jpeg",
    response_schema: dict | None = None,
    thinking: str = "auto",
    unit_count: int | None = None,
    cancel_check=None,
    expected_ids: list[str] | None = None,
    workload=None,
    model_capabilities=None,
) -> ChatResult:
    """Stream one native Ollama generation, buffering before layout decode."""
    _ = image_mime  # Ollama accepts raw base64 and infers the image format.
    thinking_mode = (thinking or "").strip().lower()
    requested_output_tokens = (
        DEFAULT_GENERATION.max_output_tokens
        if thinking_mode == "on"
        else output_token_budget(user_parts, system_text, unit_count=unit_count)
    )
    from backend.ai.workload import guard_output_budget
    requested_output_tokens = guard_output_budget(requested_output_tokens, workload=workload,
        limits=(model_capabilities or {}).get("limits"), system=system_text, parts=user_parts,
        schema=response_schema, image=bool(image_b64))
    payload: dict[str, Any] = {
        "model": model,
        "messages": _messages(system_text, user_parts, image_b64),
        "stream": True,
        "options": {
            "num_predict": requested_output_tokens,
        },
    }
    if response_schema:
        payload["format"] = response_schema
    if thinking_mode in {"off", "on"}:
        payload["think"] = thinking_mode == "on"

    url = normalize_base_url(base_url) + "/api/chat"
    wire_trace.provider_request(url=url, headers={"Content-Type": "application/json"}, payload=payload)
    provider_started = time.perf_counter()
    response = None
    try:
        # Local reads are unbounded; connect/write remain bounded and cancellable.
        timeout_factory = getattr(httpx, "Timeout", None)
        timeout = (
            timeout_factory(connect=10.0, read=None, write=30.0, pool=10.0)
            if timeout_factory else DEFAULT_GENERATION.timeout_sec
        )
        if cancel_check is not None and cancel_check():
            from backend.ai.clients.base import ProviderGenerationCancelled
            raise ProviderGenerationCancelled("Local AI generation was cancelled")
        accounting.mark_dispatched()
        with httpx.Client(timeout=timeout) as client:
            stream_method = getattr(client, "stream", None)
            can_stream = callable(stream_method) and (
                type(client).__module__.startswith("httpx")
                or getattr(client, "_textphantom_streaming", False) is True
            )
            provider_done = False
            if can_stream:
                chunks: list[str] = []
                raw_wire_lines: list[str] = []
                final_data: dict[str, Any] = {}
                first_content_ms: float | None = None
                chunk_count = 0
                detector = LineCompletionDetector(expected_ids)
                early_evidence: str | None = None
                early_completion_ms: float | None = None
                drain_started: float | None = None
                drain_outcome: str | None = None
                drain_stop = threading.Event()
                drain_state_lock = threading.Lock()
                drain_watcher: threading.Thread | None = None
                with stream_method("POST", url, json=payload, headers={"Content-Type": "application/json"}) as response:
                    if not response.is_success:
                        response.read()
                        wire_trace.http_response(response)
                    response.raise_for_status()
                    def start_stream_watcher() -> None:
                        """Interrupt reads on cancellation or bounded usage drain."""
                        nonlocal drain_outcome, drain_watcher
                        def watch() -> None:
                            nonlocal drain_outcome
                            while not drain_stop.wait(_DRAIN_WATCH_POLL_SEC):
                                reason = None
                                if cancel_check is not None and cancel_check():
                                    reason = "cancelled"
                                elif (drain_started is not None
                                      and time.monotonic() >= drain_started + _USAGE_DRAIN_GRACE_SEC):
                                    reason = "timeout"
                                if reason is None:
                                    continue
                                with drain_state_lock:
                                    if drain_outcome is None:
                                        drain_outcome = reason
                                # httpx.Response.close() is the supported way
                                # to interrupt its blocking sync stream read.
                                response.close()
                                return

                        drain_watcher = threading.Thread(
                            target=watch, name="ollama-usage-drain", daemon=True,
                        )
                        drain_watcher.start()

                    start_stream_watcher()

                    try:
                        try:
                            for raw_line in response.iter_lines():
                                if cancel_check is not None and cancel_check():
                                    from backend.ai.clients.base import ProviderGenerationCancelled
                                    raise ProviderGenerationCancelled("Local AI generation was cancelled")
                                line = raw_line.decode() if isinstance(raw_line, bytes) else str(raw_line or "")
                                raw_wire_lines.append(line)
                                wire_trace.append_text("05_provider_response.raw", line + "\n")
                                if not line.strip():
                                    continue
                                try:
                                    item = json.loads(line)
                                except ValueError as exc:
                                    raise RuntimeError(f"Ollama returned invalid NDJSON (model={model})") from exc
                                if not isinstance(item, dict):
                                    continue
                                final_data.update(item)
                                accounting.observe(final_data, "ollama", complete=item.get("done") is True)
                                if item.get("done") is True:
                                    provider_done = True
                                message = item.get("message") or {}
                                raw_content = message.get("content") if isinstance(message, dict) else ""
                                content = raw_content if isinstance(raw_content, str) else _content_text(raw_content)
                                # Completion evidence is latency telemetry only. Continue
                                # accumulating through the authoritative provider terminal so
                                # a later suffix cannot be hidden from strict contract decode.
                                if content:
                                    wire_trace.append_assembled(content)
                                    if first_content_ms is None:
                                        first_content_ms = round((time.perf_counter() - provider_started) * 1000, 1)
                                    chunks.append(content)
                                    elapsed = round((time.perf_counter() - provider_started) * 1000, 1)
                                    early_evidence = detector.inspect("".join(chunks), elapsed)
                                    if early_evidence:
                                        early_completion_ms = elapsed
                                        drain_started = time.monotonic()
                                chunk_count += 1
                                if provider_done:
                                    with drain_state_lock:
                                        if drain_outcome is None:
                                            drain_outcome = "provider_done"
                                    break
                        except httpx.RequestError:
                            if drain_outcome not in {"timeout", "cancelled"}:
                                raise
                    finally:
                        drain_stop.set()
                        if drain_watcher is not None:
                            drain_watcher.join(timeout=0.25)
                    if drain_outcome == "cancelled":
                        from backend.ai.clients.base import ProviderGenerationCancelled
                        raise ProviderGenerationCancelled("Local AI generation was cancelled")
                data = dict(final_data)
                message = dict(data.get("message") or {})
                message["content"] = "".join(chunks)
                data["message"] = message
                # Each NDJSON frame is persisted before parsing; retain the
                # partial stream if Ollama disconnects or emits invalid JSON.
                streamed = True
                terminal_completed = bool(
                    provider_done
                    and str(data.get("done_reason") or "").strip().lower() == "stop"
                )
                terminal_evidence = "provider_done" if terminal_completed else "none"
            else:
                # Compatibility fallback for older/mock transports only.
                payload["stream"] = False
                response = client.post(url, json=payload, headers={"Content-Type": "application/json"})
                wire_trace.http_response(response)
                response.raise_for_status()
                data = response.json()
                message_value = data.get("message") if isinstance(data, dict) else None
                if isinstance(message_value, dict):
                    wire_trace.assembled_response(_content_text(message_value.get("content")))
                first_content_ms = None
                chunk_count = 1
                streamed = False
                provider_done = True
                terminal_completed = True
                terminal_evidence = "non_stream_body_read"
                detector = LineCompletionDetector(expected_ids)
                early_evidence = None
                early_completion_ms = None
    except httpx.HTTPStatusError as exc:
        # Normalize 4xx/5xx from streaming and compatibility transports.
        raise safe_http_error("Ollama", getattr(exc, "response", None) or response, model) from exc
    except httpx.RequestError as exc:
        raise RuntimeError(
            f"Ollama transport error (model={model}, attempts=1, "
            f"errorType={type(exc).__name__})"
        ) from exc
    provider_ms = round((time.perf_counter() - provider_started) * 1000, 1)
    parse_started = time.perf_counter()
    try:
        if not isinstance(data, dict):
            raise ValueError("invalid response shape")
    except ValueError as exc:
        raise RuntimeError(f"Ollama returned invalid JSON (model={model})") from exc
    parse_ms = round((time.perf_counter() - parse_started) * 1000, 1)
    finish_reason = str(data.get("done_reason") or "unknown")[:80]
    trace.note(
        "ollama.generate",
        {
            "requestedOutputTokens": requested_output_tokens,
            "finishReason": finish_reason,
            "providerMs": provider_ms,
            "parseMs": parse_ms,
            "thinking": thinking_mode or "off",
            "timeoutPolicy": "local_generation_unbounded_post_completion_drain_bounded",
            "stream": streamed,
            "streamChunkCount": chunk_count,
            "firstContentMs": first_content_ms,
            "modelLoadMs": round(float(data.get("load_duration") or 0) / 1_000_000, 1) or None,
            "promptEvalMs": round(float(data.get("prompt_eval_duration") or 0) / 1_000_000, 1) or None,
            "generationMs": round(float(data.get("eval_duration") or 0) / 1_000_000, 1) or None,
            "evalCount": data.get("eval_count"),
            "firstAllIdsMs": detector.first_all_ids_ms,
            "earlyCompletionMs": early_completion_ms,
            "terminalMs": provider_ms if provider_done else None,
            "completionEvidence": terminal_evidence,
            "usageDrainGraceMs": round(_USAGE_DRAIN_GRACE_SEC * 1000),
            "usageDrainMs": (
                round((time.monotonic() - drain_started) * 1000, 1)
                if streamed and drain_started is not None else None
            ),
            "usageDrainOutcome": drain_outcome if streamed else None,
        },
        file="ai/providers/local_ollama.py",
    )
    usage_details = accounting.observe(data, "ollama", complete=terminal_completed,
        response_id=str(data.get("id") or data.get("responseId") or ""))
    inp, out, total = (usage_details[key] for key in ("inputTokens", "outputTokens", "totalTokens"))
    if total is None and inp is not None and out is not None:
        # Exact total from provider counters; no estimation.
        total = inp + out
    try:
        text = _extract_text(data)
    except RuntimeError as exc:
        raise provider_output_error(
            str(exc), provider="ollama", model=model,
            input_tokens=inp, output_tokens=out, total_tokens=total,
            finish_reason=finish_reason, provider_ms=provider_ms, parse_ms=parse_ms,
            timeout_policy="local_generation_unbounded_post_completion_drain_bounded", usage_details=usage_details,
        ) from exc
    usage_status = "incomplete_due_to_early_completion" if early_evidence and not any(v is not None for v in (inp, out, total)) else None
    return ChatResult(text, model, inp, out, total, finish_reason,
                      provider_ms, parse_ms,
                      "provider" if any(v is not None for v in (inp, out, total)) else None,
                      None, terminal_completed, terminal_evidence,
                      round(float(data.get("prompt_eval_duration") or 0) / 1_000_000, 1) or None,
                      usage_status, detector.first_all_ids_ms, early_completion_ms,
                      provider_ms if provider_done else None,
                      requested_output_tokens=requested_output_tokens,
                      cached_input_tokens=usage_details.get("cachedInputTokens"), usage_details=usage_details)
