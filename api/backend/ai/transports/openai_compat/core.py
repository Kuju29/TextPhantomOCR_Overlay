"""One-shot OpenAI chat-completions HTTP/SSE execution.

This module deliberately knows no vendors, model families, aliases, default
URLs, reasoning policy or payload policy.  A concrete provider prepares the
complete URL, headers and payload; this transport performs exactly one request
and normalizes its response into :class:`ChatResult`.
"""

from __future__ import annotations

from typing import Any, Callable
import httpx, time, json, threading, re
from decimal import Decimal

from backend.ai.clients.base import (
    ChatResult, LineCompletionDetector, ProviderGenerationCancelled,
    provider_output_error, token_usage,
)
from backend.ai.clients.provider_error import safe_http_error
from backend.ai import wire_trace, accounting, content_stream
from backend.ai.transports.stream_timing import StreamTiming

from backend.ai.transports.openai_compat.streaming import (
    JsonObjectCompletionDetector, JsonClosureGate, WireStreamCapture, merge_usage,
)
from backend.ai.transports.openai_compat.response import json_response, response_text

def execute_openai_compatible_request(
    *, url: str, headers: dict[str, str], payload: dict[str, Any],
    model: str, provider_id: str, timeout: Any,
    timeout_policy: str, expected_ids: list[str] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    trace_event: str = "ai.chat.generate", trace_file: str = "ai/transports/openai_compat/core.py",
    trace_fields: dict[str, Any] | None = None,
    cache_policy: dict[str, Any] | None = None,
    cost_authoritative: bool = False,
) -> ChatResult:
    """Execute one prepared request; never retry, probe or mutate policy.

    ``payload`` is copied because streaming flags are transport mechanics while
    all other fields remain owned by the concrete provider.
    """
    request_payload = dict(payload)
    cache_policy = dict(cache_policy or {})
    request_payload["stream"] = True
    request_payload["stream_options"] = {"include_usage": True}
    wire_trace.provider_request(url=url, headers=headers, payload=request_payload)
    started = time.perf_counter()
    hard_total_sec = (
        float(timeout)
        if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and float(timeout) > 0
        else None
    )
    transport_timeout = timeout
    idle_timeout_sec = None
    connect_timeout_sec = None
    if hard_total_sec is not None:
        # ``httpx.Client(timeout=N)`` is an inactivity timeout, not a wall-clock
        # generation deadline.  Cloud callers pass a numeric total budget, so
        # keep individual socket stalls bounded too while the watcher below
        # enforces the real end-to-end total.  Local runtimes pass an explicit
        # httpx.Timeout with read=None and therefore retain unbounded generation.
        idle_timeout_sec = min(30.0, hard_total_sec)
        connect_timeout_sec = min(10.0, hard_total_sec)
        transport_timeout = httpx.Timeout(
            connect=connect_timeout_sec,
            read=idle_timeout_sec,
            write=idle_timeout_sec,
            pool=connect_timeout_sec,
        )
    response = None
    detector = LineCompletionDetector(expected_ids)
    json_detector = JsonObjectCompletionDetector(expected_ids)
    json_gate = JsonClosureGate()
    content_tail = ""
    early_evidence = None
    early_completion_ms = None
    from backend import trace
    trace.note(trace_event + ".dispatch", {
        "stage": "provider_dispatch", "provider": provider_id,
        "model": model, "expectedUnitCount": len(expected_ids or []),
        "connectTimeoutMs": round(connect_timeout_sec * 1000, 1) if connect_timeout_sec else None,
        "idleTimeoutMs": round(idle_timeout_sec * 1000, 1) if idle_timeout_sec else None,
        "totalTimeoutMs": round(hard_total_sec * 1000, 1) if hard_total_sec else None,
    }, file=trace_file)
    try:
        if cancel_check is not None and cancel_check():
            raise ProviderGenerationCancelled("AI generation was cancelled")
        accounting.mark_dispatched()
        with httpx.Client(timeout=transport_timeout) as client:
            watch_stop = threading.Event()
            cancelled_by_owner = threading.Event()
            total_timeout_hit = threading.Event()

            def abort_transport() -> None:
                current = response
                if current is not None:
                    try:
                        current.close()
                    except Exception:
                        pass
                close = getattr(client, "close", None)
                if callable(close):
                    try:
                        close()
                    except Exception:
                        pass

            def transport_watch() -> None:
                deadline = started + hard_total_sec if hard_total_sec is not None else None
                while not watch_stop.wait(0.05):
                    if cancel_check is not None and cancel_check():
                        cancelled_by_owner.set()
                        abort_transport()
                        return
                    if deadline is not None and time.perf_counter() >= deadline:
                        total_timeout_hit.set()
                        abort_transport()
                        return

            watcher = (
                threading.Thread(target=transport_watch, daemon=True)
                if cancel_check is not None or hard_total_sec is not None
                else None
            )
            if watcher:
                watcher.start()
            try:
                stream_method = getattr(client, "stream", None)
                can_stream = callable(stream_method) and (
                    type(client).__module__.startswith("httpx")
                    or getattr(client, "_textphantom_streaming", False) is True
                )
                upstream_provider = ""
                if can_stream:
                    pieces: list[str] = []
                    usage_data: dict[str, Any] = {}
                    response_id = ""
                    actual_model = model
                    finish = None
                    first_content_ms = None
                    chunk_count = 0
                    reasoning_chunk_count = 0
                    protocol_done = False
                    timing = StreamTiming(started)
                    wire_capture = WireStreamCapture()
                    try:
                        with stream_method("POST", url, json=request_payload, headers=headers) as response:
                            if not response.is_success:
                                response.read()
                                wire_trace.http_response(response)
                            response.raise_for_status()
                            try:
                                header_upstream = str(response.headers.get("x-inference-provider") or "").strip()
                            except Exception:
                                header_upstream = ""
                            if header_upstream:
                                upstream_provider = header_upstream[:160]
                            trace.note(trace_event + ".response_headers", {
                                "stage": "provider_response_headers",
                                "status": getattr(response, "status_code", None),
                                "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
                                "upstreamProvider": upstream_provider or None,
                            }, file=trace_file)
                            for raw_line in response.iter_lines():
                                with timing.frame():
                                    if cancelled_by_owner.is_set() or (cancel_check is not None and cancel_check()):
                                        raise ProviderGenerationCancelled("AI generation was cancelled")
                                    if total_timeout_hit.is_set():
                                        raise TimeoutError(
                                            f"AI provider total timeout after {hard_total_sec:g}s (model={model}, attempts=1)"
                                        )
                                    line = raw_line.decode() if isinstance(raw_line, bytes) else str(raw_line or "")
                                    with timing.measure("wireWrite"):
                                        wire_capture.raw(line + "\n")
                                    line = line.strip()
                                    if not line or line.startswith(":"): continue
                                    if line.startswith("data:"): line = line[5:].strip()
                                    if line == "[DONE]":
                                        protocol_done = True
                                        timing.terminal("protocol_done")
                                        break
                                    try: item = json.loads(line, parse_float=Decimal)
                                    except ValueError as exc: raise RuntimeError(f"AI returned invalid SSE (model={model})") from exc
                                    if isinstance(item.get("id"), str): response_id = item["id"]
                                    if isinstance(item.get("usage"), dict):
                                        merge_usage(usage_data, item["usage"])
                                        accounting.observe(usage_data, complete=False,
                                            cost_authoritative=cost_authoritative,
                                            response_id=response_id)
                                    if item.get("error"):
                                        raise RuntimeError("Provider reported an in-stream error")
                                    if isinstance(item.get("provider"), str): upstream_provider = item["provider"]
                                    if isinstance(item.get("model"), str): actual_model = item["model"]
                                    choices = item.get("choices") or []
                                    if choices:
                                        choice = choices[0]
                                        finish = str(choice.get("finish_reason") or "").strip() or finish
                                        if choice.get("finish_reason"):
                                            timing.terminal("finish_reason")
                                        delta = choice.get("delta") or {}
                                        reasoning = delta.get("reasoning_content", delta.get("reasoning"))
                                        if isinstance(reasoning, str) and reasoning: reasoning_chunk_count += 1
                                        content = delta.get("content") or ""
                                        if isinstance(content, str) and content:
                                            if first_content_ms is None:
                                                first_content_ms = round((time.perf_counter() - started) * 1000, 1)
                                                trace.note(trace_event + ".first_content", {"stage": "provider_first_content", "elapsedMs": first_content_ms, "reasoningChunksBeforeContent": reasoning_chunk_count, "upstreamProvider": upstream_provider or None}, file=trace_file)
                                            pieces.append(content)
                                            timing.content()
                                            with timing.measure("deltaCallback"):
                                                content_stream.emit(content)
                                            elapsed = round((time.perf_counter() - started) * 1000, 1)
                                            # Joining and fully scanning the accumulated
                                            # output on every token makes this path
                                            # quadratic. Inspect only when a semantic
                                            # close can have arrived. Include the prior
                                            # tail so a marker delimiter split as `>` +
                                            # `>` is still detected.
                                            boundary = content_tail + content
                                            marker_candidate = (early_evidence is None
                                                                and ">>" in boundary)
                                            json_candidate = (early_evidence is None
                                                              and json_gate.feed(content))
                                            content_tail = boundary[-1:]
                                            assembled = ("".join(pieces)
                                                         if marker_candidate or json_candidate
                                                         else "")
                                            marker_evidence = (detector.inspect(assembled, elapsed)
                                                               if marker_candidate else None)
                                            json_evidence = (json_detector.inspect(assembled, elapsed)
                                                             if json_candidate else None)
                                            evidence = marker_evidence or json_evidence
                                            if evidence and early_evidence is None:
                                                # All records being visible is useful latency evidence,
                                                # but it is not the end of the provider protocol.  Usage
                                                # and the authoritative finish reason commonly arrive in
                                                # the final SSE frame, so keep draining this same request.
                                                early_evidence = evidence
                                                early_completion_ms = elapsed
                                    chunk_count += 1
                            if cancelled_by_owner.is_set():
                                raise ProviderGenerationCancelled("AI generation was cancelled")
                            if total_timeout_hit.is_set():
                                raise TimeoutError(
                                    f"AI provider total timeout after {hard_total_sec:g}s (model={model}, attempts=1)"
                                )
                    finally:
                        # Flush on success, malformed SSE, cancellation and
                        # transport interruption. Never influence completion,
                        # usage collection or provider-drain semantics.
                        timing.finish()
                        with timing.measure("wireWrite"):
                            wire_capture.finish("".join(pieces))
                        stream_timing = timing.snapshot()
                        wire_trace.write_json("09_stream_timing.json", stream_timing)
                        trace.note(trace_event + ".stream_timing", timing.audit(), file=trace_file)
                    data = {"choices": [{"finish_reason": finish, "message": {"content": "".join(pieces)}}], "usage": usage_data, "provider": upstream_provider, "model": actual_model, "id": response_id}
                    # Raw SSE was appended before parsing each frame so a broken
                    # or interrupted stream still leaves the received prefix.
                    streamed = True
                    normal_finish = str(finish or "").lower() in {"stop", "end_turn", "completed", "complete"}
                    # Complete marker records are latency evidence only. They do
                    # not prove that the provider protocol ended normally.
                    terminal_completed = protocol_done or normal_finish
                    terminal_evidence = (
                        "protocol_done" if protocol_done
                        else "finish_reason" if normal_finish
                        else "none"
                    )
                else:
                    request_payload["stream"] = False
                    request_payload.pop("stream_options", None)
                    response = client.post(url, json=request_payload, headers=headers)
                    try:
                        upstream_provider = str(response.headers.get("x-inference-provider") or "")[:160]
                    except Exception:
                        upstream_provider = ""
                    if cancelled_by_owner.is_set():
                        raise ProviderGenerationCancelled("AI generation was cancelled")
                    if total_timeout_hit.is_set():
                        raise TimeoutError(
                            f"AI provider total timeout after {hard_total_sec:g}s (model={model}, attempts=1)"
                        )
                    wire_trace.http_response(response)
                    body_ms = round((time.perf_counter() - started) * 1000, 1)
                    trace.note(trace_event + ".response_body", {
                        "stage": "provider_response_body",
                        "status": getattr(response, "status_code", None),
                        "elapsedMs": body_ms,
                    }, file=trace_file)
                    data = json_response(response)
                    first_content_ms = body_ms
                    chunk_count = 1
                    streamed = False
                    reasoning_chunk_count = 0
                    terminal_completed = True
                    terminal_evidence = "non_stream_body_read"
                    try:
                        assembled_nonstream = response_text(data)
                    except RuntimeError:
                        # Keep the raw response useful even when provider output is
                        # structurally invalid; normal validation reports the error.
                        assembled_nonstream = ""
                    wire_trace.assembled_response(assembled_nonstream)
            finally:
                watch_stop.set()
                if watcher:
                    watcher.join(timeout=0.2)
    except ProviderGenerationCancelled:
        trace.note(trace_event + ".cancelled", {
            "stage": "provider_cancelled",
            "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
        }, file=trace_file)
        raise
    except Exception as exc:
        if 'cancelled_by_owner' in locals() and cancelled_by_owner.is_set():
            trace.note(trace_event + ".cancelled", {
                "stage": "provider_cancelled",
                "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
            }, file=trace_file)
            raise ProviderGenerationCancelled("AI generation was cancelled") from exc
        if 'total_timeout_hit' in locals() and total_timeout_hit.is_set():
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            trace.note(trace_event + ".timeout", {
                "stage": "provider_timeout", "elapsedMs": elapsed_ms,
                "totalTimeoutMs": round(hard_total_sec * 1000, 1) if hard_total_sec else None,
            }, file=trace_file)
            raise TimeoutError(
                f"AI provider total timeout after {hard_total_sec:g}s (model={model}, attempts=1)"
            ) from exc
        if isinstance(exc, httpx.RequestError):
            raise RuntimeError(f"AI transport error (model={model}, attempts=1, errorType={type(exc).__name__})") from exc
        raise

    try:
        assert response is not None
        response.raise_for_status()
        provider_ms = round((time.perf_counter() - started) * 1000, 1)
        parse_started = time.perf_counter()
        if not isinstance(data, dict):
            raise ValueError("invalid response shape")
        choices = data.get("choices") or []
        finish = str((choices[0] if choices else {}).get("finish_reason") or "").strip() or None
        usage = accounting.observe(data.get("usage"), complete=terminal_completed,
            cost_authoritative=cost_authoritative,
            response_id=str(data.get("id") or ""), http_status=response.status_code)
        if provider_id == "huggingface":
            upstream = str(data.get("provider") or upstream_provider or "")[:160]
            if upstream:
                usage["upstreamProvider"] = upstream
        inp, out, total = (usage[key] for key in ("inputTokens", "outputTokens", "totalTokens"))
        details = (data.get("usage") or {}).get("completion_tokens_details") or {}
        reasoning_tokens = details.get("reasoning_tokens")
        if not isinstance(reasoning_tokens, int) or isinstance(reasoning_tokens, bool):
            reasoning_tokens = None
        try:
            content = response_text(data)
        except RuntimeError as exc:
            parse_ms = round((time.perf_counter() - parse_started) * 1000, 1)
            raw_content = str(((choices[0].get("message") or {}).get("content") or "") if choices else "")
            trace.note(trace_event + ".output_unusable", {
                "stage": "provider_output_unusable",
                "visibleContentChars": len(raw_content),
                "visibleMarkerCount": len(set(re.findall(r"<<(?:TP_P\d+|I[1-9][0-9]{0,6}_P[0-9]{1,6}):", raw_content))),
                "reasoningChunkCount": reasoning_chunk_count,
                "thinkingTokens": reasoning_tokens,
                "finishReason": finish,
                "providerMs": provider_ms,
            }, file=trace_file)
            raise provider_output_error(str(exc), provider=provider_id, model=model,
                input_tokens=inp, output_tokens=out, total_tokens=total,
                finish_reason=finish, provider_ms=provider_ms, parse_ms=parse_ms,
                timeout_policy=timeout_policy, usage_details=usage) from exc
        parse_ms = round((time.perf_counter() - parse_started) * 1000, 1)
        fields = {
            "stream": streamed, "streamChunkCount": chunk_count,
            "firstContentMs": first_content_ms, "providerMs": provider_ms,
            "parseMs": parse_ms, "finishReason": finish,
            "reasoningChunkCount": reasoning_chunk_count,
            "visibleContentChars": len(content),
            "visibleMarkerCount": len(set(re.findall(r"<<(?:TP_P\d+|I[1-9][0-9]{0,6}_P[0-9]{1,6}):", content))),
            "thinkingTokens": reasoning_tokens,
            "firstAllIdsMs": (detector.first_all_ids_ms
                              if detector.first_all_ids_ms is not None
                              else json_detector.first_all_ids_ms),
            "earlyCompletionMs": early_completion_ms,
            "terminalMs": provider_ms if terminal_completed else None,
            "completionEvidence": terminal_evidence,
            "upstreamProvider": str(data.get("provider") or upstream_provider or "")[:160] or None,
            "inputTokens": inp,
            "cachedInputTokens": usage.get("cachedInputTokens"),
            "promptCachePct": (round(float(usage.get("cachedInputTokens")) / float(inp) * 100.0, 1)
                               if isinstance(usage.get("cachedInputTokens"), int)
                               and not isinstance(usage.get("cachedInputTokens"), bool)
                               and isinstance(inp, int) and not isinstance(inp, bool) and inp > 0
                               else None),
        }
        fields.update(trace_fields or {})
        trace.note(trace_event, fields, file=trace_file)
        usage_status = "incomplete_due_to_early_completion" if early_evidence and not any(v is not None for v in (inp, out, total)) else None
        return ChatResult(content, str(data.get("model") or model), inp, out, total, finish, provider_ms, parse_ms,
            "provider" if any(v is not None for v in (inp, out, total)) else None,
            reasoning_tokens, terminal_completed, terminal_evidence, None,
            usage_status, (detector.first_all_ids_ms
                           if detector.first_all_ids_ms is not None
                           else json_detector.first_all_ids_ms), early_completion_ms,
            provider_ms if terminal_completed else None,
            requested_output_tokens=request_payload.get("max_completion_tokens", request_payload.get("max_tokens")),
            upstream_provider=str(data.get("provider") or upstream_provider or "")[:160],
            cached_input_tokens=usage.get("cachedInputTokens"), usage_details=usage, cache_policy=cache_policy,
            first_content_ms=first_content_ms)
    except httpx.HTTPStatusError as exc:
        raise safe_http_error("AI", response, model) from exc

__all__ = ["execute_openai_compatible_request"]
