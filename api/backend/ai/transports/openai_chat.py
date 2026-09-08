"""One-shot OpenAI chat-completions HTTP/SSE execution.

This module deliberately knows no vendors, model families, aliases, default
URLs, reasoning policy or payload policy.  A concrete provider prepares the
complete URL, headers and payload; this transport performs exactly one request
and normalizes its response into :class:`ChatResult`.
"""

from __future__ import annotations

from typing import Any, Callable
from urllib.parse import urlsplit

import httpx, time, json, threading, re
from decimal import Decimal

from backend.ai.clients.base import (
    ChatResult, LineCompletionDetector, ProviderGenerationCancelled,
    provider_output_error, token_usage,
)
from backend.ai.clients.provider_error import safe_http_error
from backend.ai import wire_trace, accounting
from backend.ai.prompt_cache import apply_chat_cache

def _merge_usage(target, incoming):
    for key, value in incoming.items():
        if value is None:
            continue
        if isinstance(value, dict):
            child = target.get(key)
            if not isinstance(child, dict): child = {}
            _merge_usage(child, value)
            target[key] = child
        else:
            target[key] = value

def _json_response(response):
    # Real httpx supports JSON decoder kwargs. Old offline fakes may not.
    if isinstance(response, httpx.Response):
        return response.json(parse_float=Decimal)
    return response.json()

def _text(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("AI returned no choices")
    value = ((choices[0].get("message") or {}).get("content") or "").strip()
    if not value:
        raise RuntimeError("AI returned empty text")
    return value

def execute_chat_completion(
    *, url: str, headers: dict[str, str], payload: dict[str, Any],
    model: str, provider_id: str, timeout: Any,
    timeout_policy: str, expected_ids: list[str] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    trace_event: str = "ai.chat.generate", trace_file: str = "ai/transports/openai_chat.py",
    trace_fields: dict[str, Any] | None = None,
) -> ChatResult:
    """Execute one prepared request; never retry, probe or mutate policy.

    ``payload`` is copied because streaming flags are transport mechanics while
    all other fields remain owned by the concrete provider.
    """
    request_payload, cache_policy = apply_chat_cache(payload, provider=provider_id, model=model, url=url, headers=headers)
    request_payload["stream"] = True
    request_payload["stream_options"] = {"include_usage": True}
    wire_trace.provider_request(url=url, headers=headers, payload=request_payload)
    started = time.perf_counter()
    response = None
    detector = LineCompletionDetector(expected_ids)
    early_evidence = None
    early_completion_ms = None
    from backend import trace
    trace.note(trace_event + ".dispatch", {
        "stage": "provider_dispatch", "provider": provider_id,
        "model": model, "expectedUnitCount": len(expected_ids or []),
    }, file=trace_file)
    try:
        if cancel_check is not None and cancel_check():
            raise ProviderGenerationCancelled("AI generation was cancelled")
        accounting.mark_dispatched()
        with httpx.Client(timeout=timeout) as client:
            stream_method = getattr(client, "stream", None)
            can_stream = callable(stream_method) and (
                type(client).__module__.startswith("httpx")
                or getattr(client, "_textphantom_streaming", False) is True
            )
            if can_stream:
                pieces: list[str] = []
                usage_data: dict[str, Any] = {}
                response_id = ""
                upstream_provider = ""
                actual_model = model
                finish = None
                first_content_ms = None
                chunk_count = 0
                reasoning_chunk_count = 0
                protocol_done = False
                raw_wire_lines: list[str] = []
                with stream_method("POST", url, json=request_payload, headers=headers) as response:
                    if not response.is_success:
                        response.read()
                        wire_trace.http_response(response)
                    response.raise_for_status()
                    trace.note(trace_event + ".response_headers", {
                        "stage": "provider_response_headers",
                        "status": getattr(response, "status_code", None),
                        "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
                    }, file=trace_file)
                    cancel_stop = threading.Event()
                    cancelled_by_owner = threading.Event()
                    def cancel_watch() -> None:
                        while not cancel_stop.wait(0.05):
                            if cancel_check is not None and cancel_check():
                                cancelled_by_owner.set()
                                try: response.close()
                                except Exception: pass
                                return
                    watcher = (threading.Thread(target=cancel_watch, daemon=True)
                               if cancel_check is not None else None)
                    if watcher: watcher.start()
                    try:
                        for raw_line in response.iter_lines():
                            if cancelled_by_owner.is_set() or (cancel_check is not None and cancel_check()):
                                raise ProviderGenerationCancelled("AI generation was cancelled")
                            line = raw_line.decode() if isinstance(raw_line, bytes) else str(raw_line or "")
                            raw_wire_lines.append(line)
                            wire_trace.append_text("05_provider_response.raw", line + "\n")
                            line = line.strip()
                            if not line or line.startswith(":"): continue
                            if line.startswith("data:"): line = line[5:].strip()
                            if line == "[DONE]": protocol_done = True; break
                            try: item = json.loads(line, parse_float=Decimal)
                            except ValueError as exc: raise RuntimeError(f"AI returned invalid SSE (model={model})") from exc
                            if isinstance(item.get("id"), str): response_id = item["id"]
                            if isinstance(item.get("usage"), dict):
                                _merge_usage(usage_data, item["usage"])
                                accounting.observe(usage_data, complete=False,
                                    cost_authoritative=provider_id == "openrouter" and urlsplit(url).hostname == "openrouter.ai",
                                    response_id=response_id)
                            if item.get("error"):
                                raise RuntimeError("Provider reported an in-stream error")
                            if isinstance(item.get("provider"), str): upstream_provider = item["provider"]
                            if isinstance(item.get("model"), str): actual_model = item["model"]
                            choices = item.get("choices") or []
                            if choices:
                                choice = choices[0]
                                finish = str(choice.get("finish_reason") or "").strip() or finish
                                delta = choice.get("delta") or {}
                                reasoning = delta.get("reasoning_content", delta.get("reasoning"))
                                if isinstance(reasoning, str) and reasoning: reasoning_chunk_count += 1
                                content = delta.get("content") or ""
                                if isinstance(content, str) and content:
                                    wire_trace.append_assembled(content)
                                    if first_content_ms is None:
                                        first_content_ms = round((time.perf_counter() - started) * 1000, 1)
                                        trace.note(trace_event + ".first_content", {"stage": "provider_first_content", "elapsedMs": first_content_ms, "reasoningChunksBeforeContent": reasoning_chunk_count}, file=trace_file)
                                    pieces.append(content)
                                    elapsed = round((time.perf_counter() - started) * 1000, 1)
                                    evidence = detector.inspect("".join(pieces), elapsed)
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
                    except Exception as exc:
                        if cancelled_by_owner.is_set():
                            raise ProviderGenerationCancelled("AI generation was cancelled") from exc
                        raise
                    finally:
                        cancel_stop.set()
                        if watcher: watcher.join(timeout=0.2)
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
                wire_trace.http_response(response)
                body_ms = round((time.perf_counter() - started) * 1000, 1)
                trace.note(trace_event + ".response_body", {
                    "stage": "provider_response_body",
                    "status": getattr(response, "status_code", None),
                    "elapsedMs": body_ms,
                }, file=trace_file)
                data = _json_response(response)
                first_content_ms = body_ms
                chunk_count = 1
                streamed = False
                reasoning_chunk_count = 0
                terminal_completed = True
                terminal_evidence = "non_stream_body_read"
                try:
                    assembled_nonstream = _text(data)
                except RuntimeError:
                    # Keep the raw response useful even when provider output is
                    # structurally invalid; normal validation reports the error.
                    assembled_nonstream = ""
                wire_trace.assembled_response(assembled_nonstream)
    except ProviderGenerationCancelled:
        trace.note(trace_event + ".cancelled", {
            "stage": "provider_cancelled",
            "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
        }, file=trace_file)
        raise
    except httpx.RequestError as exc:
        raise RuntimeError(f"AI transport error (model={model}, attempts=1, errorType={type(exc).__name__})") from exc

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
            cost_authoritative=provider_id == "openrouter" and urlsplit(url).hostname == "openrouter.ai",
            response_id=str(data.get("id") or ""), http_status=response.status_code)
        inp, out, total = (usage[key] for key in ("inputTokens", "outputTokens", "totalTokens"))
        details = (data.get("usage") or {}).get("completion_tokens_details") or {}
        reasoning_tokens = details.get("reasoning_tokens")
        if not isinstance(reasoning_tokens, int) or isinstance(reasoning_tokens, bool):
            reasoning_tokens = None
        try:
            content = _text(data)
        except RuntimeError as exc:
            parse_ms = round((time.perf_counter() - parse_started) * 1000, 1)
            raw_content = str(((choices[0].get("message") or {}).get("content") or "") if choices else "")
            trace.note(trace_event + ".output_unusable", {
                "stage": "provider_output_unusable",
                "visibleContentChars": len(raw_content),
                "visibleMarkerCount": len(set(re.findall(r"<<TP_P\d+:", raw_content))),
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
            "visibleMarkerCount": len(set(re.findall(r"<<TP_P\d+:", content))),
            "thinkingTokens": reasoning_tokens,
            "firstAllIdsMs": detector.first_all_ids_ms,
            "earlyCompletionMs": early_completion_ms,
            "terminalMs": provider_ms if terminal_completed else None,
            "completionEvidence": terminal_evidence,
        }
        fields.update(trace_fields or {})
        trace.note(trace_event, fields, file=trace_file)
        usage_status = "incomplete_due_to_early_completion" if early_evidence and not any(v is not None for v in (inp, out, total)) else None
        return ChatResult(content, str(data.get("model") or model), inp, out, total, finish, provider_ms, parse_ms,
            "provider" if any(v is not None for v in (inp, out, total)) else None,
            reasoning_tokens, terminal_completed, terminal_evidence, None,
            usage_status, detector.first_all_ids_ms, early_completion_ms,
            provider_ms if terminal_completed else None,
            requested_output_tokens=request_payload.get("max_completion_tokens", request_payload.get("max_tokens")),
            upstream_provider=str(data.get("provider") or "")[:160],
            cached_input_tokens=usage.get("cachedInputTokens"), usage_details=usage, cache_policy=cache_policy)
    except httpx.HTTPStatusError as exc:
        raise safe_http_error("AI", response, model) from exc

__all__ = ["execute_chat_completion"]
