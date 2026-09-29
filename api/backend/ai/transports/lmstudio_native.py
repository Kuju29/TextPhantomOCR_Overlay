"""One LM Studio native chat request; optional state, no implicit retry."""
from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable
from typing import Any

import httpx

from backend import trace
from backend.ai import accounting, content_stream, wire_trace
from backend.ai.clients.base import (ChatResult, LineCompletionDetector,
    ProviderGenerationCancelled, provider_output_error)
from backend.ai.clients.provider_error import ProviderHttpError, ProviderTransportError, safe_http_error
from backend.ai.transports.stream_timing import StreamTiming

_CURSOR = re.compile(r"resp_[A-Za-z0-9_-]{1,256}\Z")
_CURSOR_IN_TEXT = re.compile(r"resp_[A-Za-z0-9_-]{1,256}")
_REQUEST_LIMIT = 30 * 60
_KNOWN_EVENTS = {
    "model_load.start", "model_load.progress", "model_load.end",
    "prompt_processing.start", "prompt_processing.progress", "prompt_processing.end",
    "reasoning.start", "reasoning.delta", "reasoning.end",
    "message.start", "message.delta", "message.end",
    "tool_call.start", "tool_call.arguments", "tool_call.success", "tool_call.failure",
}


def _failure(message: str, model: str) -> ProviderTransportError:
    return ProviderTransportError(f"LM Studio native chat {message}", provider="lmstudio", model=model)


def _assert_model(actual: Any, model: str) -> None:
    if not isinstance(actual, str) or actual.strip() != model.strip():
        # A local auto-load or alias could switch models without the user's
        # consent. Never commit that answer to the selected model's chat.
        raise _failure("returned a different or missing model identity", model)


def _message_text(result: dict[str, Any], model: str) -> str:
    output = result.get("output")
    if not isinstance(output, list):
        raise _failure("has no valid output array", model)
    messages = [item.get("content") for item in output
                if isinstance(item, dict) and item.get("type") == "message"]
    if any(not isinstance(text, str) for text in messages):
        raise _failure("has no valid assistant message", model)
    return "".join(messages)


def _safe_trace_event(item: dict[str, Any]) -> dict[str, Any]:
    """Native response IDs are private control state, including in opt-in logs."""
    def clean(value):
        if isinstance(value, dict):
            kind = value.get("type")
            if isinstance(kind, str) and (kind == "reasoning" or kind.startswith("reasoning.")):
                return {"type": kind, "content": "<redacted>"}
            return {key: clean(content) for key, content in value.items()
                    if key not in ("response_id", "previous_response_id")}
        if isinstance(value, list):
            return [clean(row) for row in value]
        if isinstance(value, str):
            return _CURSOR_IN_TEXT.sub("<private_response_id>", value)
        return value
    return clean(item)


def _native_http_error(response: httpx.Response, model: str) -> ProviderHttpError:
    original = safe_http_error("LM Studio", response, model)
    clean = lambda value: _CURSOR_IN_TEXT.sub("<private_response_id>", str(value or ""))
    return ProviderHttpError(clean(original), provider=original.provider,
        model=original.model, status=original.status,
        provider_code=clean(original.provider_code),
        provider_type=clean(original.provider_type),
        provider_message=clean(original.provider_message),
        retry_after_sec=original.retry_after_sec)


def execute_lmstudio_chat(*, url: str, headers: dict[str, str],
                          payload: dict[str, Any], model: str,
                          expected_ids: tuple[str, ...] | list[str] = (),
                          cancel_check: Callable[[], bool] | None = None,
                          reject_observed_thinking: bool = False) -> ChatResult:
    """Consume the authoritative `chat.end` before accepting content or cursor."""
    trace_payload = {key: value for key, value in payload.items()
                     if key != "previous_response_id"}
    if payload.get("previous_response_id"):
        trace_payload["previous_response_id"] = "<private>"
    wire_trace.provider_request(url=url, headers=headers, payload=trace_payload)
    if cancel_check and cancel_check():
        raise ProviderGenerationCancelled("LM Studio generation was cancelled")

    started = time.perf_counter()
    timing = StreamTiming(started)
    detector = LineCompletionDetector(expected_ids)
    pieces: list[str] = []
    fields: list[str] = []
    final: dict[str, Any] | None = None
    reasoning_observed = False
    start_seen = False
    first_content_ms: float | None = None
    early_ms: float | None = None
    response: httpx.Response | None = None
    watcher_stop = threading.Event()
    owner_cancelled = threading.Event()
    timed_out = threading.Event()
    timeout = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=10.0)

    def dispatch() -> None:
        nonlocal final, start_seen, first_content_ms, early_ms, reasoning_observed
        if not fields:
            return
        raw = "\n".join(fields)
        fields.clear()
        try:
            item = json.loads(raw)
        except ValueError as exc:
            raise _failure("returned invalid SSE JSON", model) from exc
        if not isinstance(item, dict):
            raise _failure("returned invalid SSE event", model)
        kind = item.get("type")
        if final is not None:
            raise _failure("returned events after chat.end", model)
        with timing.measure("wireWrite"):
            wire_trace.append_text("05_provider_response.raw", "data: " +
                json.dumps(_safe_trace_event(item), ensure_ascii=False) + "\n\n")
        if kind == "error":
            # LM Studio can send an error followed by chat.end with a partial
            # result. That result is never a valid continuation point.
            synthetic = httpx.Response(502, json=item,
                request=httpx.Request("POST", "http://localhost/api/v1/chat"))
            raise _native_http_error(synthetic, model)
        if not start_seen and kind != "chat.start":
            raise _failure("began without chat.start", model)
        if kind == "chat.start":
            if start_seen or final is not None:
                raise _failure("returned duplicate chat.start", model)
            start_seen = True
            _assert_model(item.get("model_instance_id"), model)
        elif kind == "chat.end":
            if final is not None:
                raise _failure("returned duplicate chat.end", model)
            result = item.get("result")
            if not isinstance(result, dict):
                raise _failure("returned malformed chat.end", model)
            _assert_model(result.get("model_instance_id"), model)
            cursor = result.get("response_id")
            if payload.get("store") is True:
                if not _CURSOR.fullmatch(str(cursor or "")):
                    raise _failure("finished without a valid stored response ID", model)
            elif cursor is not None:
                raise _failure("returned a stored response ID despite store:false", model)
            output = result.get("output")
            if isinstance(output, list) and any(isinstance(part, dict) and
                    part.get("type") == "reasoning" and bool(part.get("content")) for part in output):
                reasoning_observed = True
            final = result
            timing.terminal("chat.end")
        elif kind == "reasoning.delta":
            if item.get("content"):
                reasoning_observed = True
        elif kind == "message.delta":
            fragment = item.get("content")
            if not isinstance(fragment, str):
                raise _failure("returned non-text message delta", model)
            if fragment:
                if first_content_ms is None:
                    first_content_ms = round((time.perf_counter() - started) * 1000, 1)
                pieces.append(fragment)
                with timing.measure("wireWrite"):
                    wire_trace.append_assembled(fragment)
                timing.content()
                with timing.measure("deltaCallback"):
                    content_stream.emit(fragment)
                elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
                if detector.inspect("".join(pieces), elapsed_ms) and early_ms is None:
                    early_ms = elapsed_ms
        elif kind in _KNOWN_EVENTS:
            pass
        else:
            raise _failure("returned an unknown SSE event", model)

    def watch(client: httpx.Client) -> None:
        while not watcher_stop.wait(0.05):
            if cancel_check and cancel_check():
                owner_cancelled.set()
            elif time.perf_counter() - started >= _REQUEST_LIMIT:
                timed_out.set()
            else:
                continue
            try:
                if response is not None:
                    response.close()
                client.close()
            except Exception:
                pass
            return

    trace.note("lmstudio.native.dispatch", {"stage": "provider_dispatch",
        "provider": "lmstudio", "model": model,
        "providerContinuation": "linked" if payload.get("previous_response_id") else "new",
        "expectedUnitCount": len(expected_ids)}, file="ai/transports/lmstudio_native.py")
    accounting.mark_dispatched()
    try:
        with httpx.Client(timeout=timeout) as client:
            watcher = threading.Thread(target=watch, args=(client,), daemon=True)
            watcher.start()
            try:
                with client.stream("POST", url, json=payload, headers=headers) as response:
                    if not response.is_success:
                        # Do not write the raw provider error; it might echo a
                        # previous_response_id from the private request body.
                        response.read()
                        raise _native_http_error(response, model)
                    for line in response.iter_lines():
                        with timing.frame():
                            if owner_cancelled.is_set() or cancel_check and cancel_check():
                                raise ProviderGenerationCancelled("LM Studio generation was cancelled")
                            if timed_out.is_set():
                                raise _failure("timed out", model)
                            line = line.decode() if isinstance(line, bytes) else line
                            if line == "":
                                dispatch()
                                # `chat.end` is authoritative. Some local
                                # runtimes leave the SSE socket open after it;
                                # waiting for EOF can stall a finished page.
                                if final is not None:
                                    break
                            elif line.startswith("data:"):
                                fields.append(line[5:].lstrip(" "))
                            elif line.startswith(("event:", "id:", "retry:", ":")):
                                continue
                            else:
                                raise _failure("returned malformed SSE framing", model)
                    dispatch()
            finally:
                watcher_stop.set()
                watcher.join(timeout=0.25)
    except httpx.RequestError as exc:
        if owner_cancelled.is_set() or cancel_check and cancel_check():
            raise ProviderGenerationCancelled("LM Studio generation was cancelled") from exc
        if timed_out.is_set():
            raise _failure("timed out", model) from exc
        raise _failure(f"transport failed ({type(exc).__name__})", model) from exc
    except Exception as exc:
        if owner_cancelled.is_set() or cancel_check and cancel_check():
            raise ProviderGenerationCancelled("LM Studio generation was cancelled") from exc
        if timed_out.is_set():
            raise _failure("timed out", model) from exc
        raise
    finally:
        watcher_stop.set()
        timing.finish()
        wire_trace.write_json("09_stream_timing.json", timing.snapshot())

    if owner_cancelled.is_set() or cancel_check and cancel_check():
        raise ProviderGenerationCancelled("LM Studio generation was cancelled")
    if timed_out.is_set():
        raise _failure("timed out", model)
    if final is None:
        raise _failure("ended without chat.end", model)
    provider_ms = round((time.perf_counter() - started) * 1000, 1)
    parse_started = time.perf_counter()
    stats = final.get("stats") if isinstance(final.get("stats"), dict) else {}
    def token(field):
        value = stats.get(field)
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
    inp, out, thinking = token("input_tokens"), token("total_output_tokens"), token("reasoning_output_tokens")
    usage_raw: dict[str, Any] = {}
    if inp is not None:
        usage_raw["prompt_tokens"] = inp
    if out is not None:
        usage_raw["completion_tokens"] = out
    if inp is not None and out is not None:
        usage_raw["total_tokens"] = inp + out
    if thinking is not None:
        usage_raw["completion_tokens_details"] = {"reasoning_tokens": thinking}
    usage = accounting.observe(usage_raw, complete=True)
    parse_ms = round((time.perf_counter() - parse_started) * 1000, 1)
    finish = "length" if out is not None and out >= payload["max_output_tokens"] else "stop"
    text = _message_text(final, model)
    trace.note("lmstudio.native.thinking_observed", {
        "provider": "lmstudio", "model": model, "reasoningObserved": reasoning_observed,
        "reasoningTokens": thinking}, file="ai/transports/lmstudio_native.py")
    if (reject_observed_thinking or payload.get("reasoning") == "off") and (
            reasoning_observed or thinking is not None and thinking > 0):
        error = provider_output_error(
            "LM Studio returned reasoning content or tokens despite the selected Thinking Off setting",
            provider="lmstudio", model=model, input_tokens=inp,
            output_tokens=out, total_tokens=usage.get("totalTokens"),
            finish_reason=None, provider_ms=provider_ms, parse_ms=parse_ms,
            timeout_policy="local_connect_bounded_native_total_30m",
            response_shape="lmstudio_reasoning_preference_violation",
            usage_details=usage)
        error.code = "ai_local_thinking_violated"
        raise error
    if not text.strip():
        error = provider_output_error("LM Studio returned no visible translation", provider="lmstudio",
            model=model, input_tokens=inp, output_tokens=out,
            total_tokens=usage.get("totalTokens"), finish_reason=finish,
            provider_ms=provider_ms, parse_ms=parse_ms,
            timeout_policy="local_connect_bounded_native_total_30m", usage_details=usage)
        if finish == "length":
            if reasoning_observed or thinking is not None and thinking > 0:
                error.structural_details["reasoningOnlyExhausted"] = True
            error.structural_details["validatorSubtype"] = (
                "reasoning_only_exhausted" if reasoning_observed or thinking is not None and thinking > 0
                else "empty_output")
            error.structural_details["requestedOutputTokens"] = payload["max_output_tokens"]
        raise error
    if not pieces:
        first_content_ms = provider_ms
        content_stream.emit(text)
        wire_trace.assembled_response(text)
    trace.note("lmstudio.native.generate", {"stage": "provider_complete", "provider": "lmstudio",
        "model": model, "providerContinuation": "linked" if payload.get("previous_response_id") else "new",
        "finishReason": finish, "providerMs": provider_ms, "firstContentMs": first_content_ms,
        "inputTokens": inp, "outputTokens": out, "thinkingTokens": thinking,
        "reasoningObserved": reasoning_observed,
        "terminalEvidence": "chat.end"}, file="ai/transports/lmstudio_native.py")
    return ChatResult(text=text, used_model=model, input_tokens=inp, output_tokens=out,
        total_tokens=usage.get("totalTokens"), finish_reason=finish,
        provider_ms=provider_ms, parse_ms=parse_ms,
        usage_source="provider" if inp is not None or out is not None else None,
        thinking_tokens=thinking, terminal_completed=True, terminal_evidence="chat.end",
        usage_details=usage, first_content_ms=first_content_ms,
        first_all_ids_ms=detector.first_all_ids_ms, early_completion_ms=early_ms,
        terminal_ms=provider_ms, requested_output_tokens=payload["max_output_tokens"],
        provider_response_id=final["response_id"] if payload.get("store") is True else "")


__all__ = ["execute_lmstudio_chat"]
