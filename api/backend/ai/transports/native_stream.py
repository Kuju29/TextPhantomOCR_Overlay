"""Native SSE reception: publish text deltas, retain the final provider contract."""
from __future__ import annotations

import json as json_codec
import threading
import time
import httpx
from backend.ai import accounting, content_stream, wire_trace
from backend.ai.clients.base import LineCompletionDetector, ProviderGenerationCancelled
from backend.ai.transports.stream_timing import StreamTiming
from backend.ai.transports.stream_progress import (
    StreamProgress, current_line_ids, reasoning_budget_from_payload, report_sink,
)
from backend.ai.clients.provider_error import ProviderTransportError, safe_http_error


class NativeResponse:
    def __init__(self, provider, model, trace_file=""):
        self.started = time.perf_counter()
        self.timing = StreamTiming(self.started)
        self.first_content_ms = None
        self.trace_file = trace_file
        self.provider, self.model = provider, model
        self.data = {}
        self.parts = []
        self.blocks = {}
        self.terminal = False
        # Phase evidence; set by post_native_stream.
        self.guard = None
        self.lines = LineCompletionDetector(None)
        self.visible = []
        self.tail = ""

    def thinking(self):
        if self.guard is not None:
            self.guard.thinking()

    def idle(self):
        if self.guard is not None:
            self.guard.keepalive()

    def publish(self, text):
        if text and self.first_content_ms is None:
            self.first_content_ms = round((time.perf_counter() - self.started) * 1000, 1)
            from backend import trace
            trace.note(f"{self.provider}.generate.first_content", {
                "stage": "provider_first_content", "provider": self.provider,
                "elapsedMs": self.first_content_ms,
            }, file=self.trace_file)
        if text:
            self.timing.content()
            self.visible.append(text)
            if self.guard is not None:
                boundary = self.tail + text
                self.tail = boundary[-1:]
                count = (self.lines.closed_count("".join(self.visible)) if ">>" in boundary
                         else None)
                self.guard.writing(count)
        with self.timing.measure("deltaCallback"):
            content_stream.emit(text)

    def accept(self, event):
        if not isinstance(event, dict):
            self.fail('invalid_event')
        if event.get('error') or event.get('type') == 'error':
            # Use the common structured redactor; HTTP success can contain SSE errors.
            response = httpx.Response(502, json=event, request=httpx.Request('POST', 'https://provider.invalid'))
            raise safe_http_error(self.provider, response, self.model)
        if self.provider == 'gemini':
            for key, value in event.items():
                if key != 'candidates':
                    self.data[key] = value
            candidates = event.get('candidates') or []
            if candidates:
                candidate = candidates[0]
                target = self.data.setdefault('candidates', [{}])[0]
                target.update({k: v for k, v in candidate.items() if k != 'content'})
                progressed = False
                for part in (candidate.get('content') or {}).get('parts') or []:
                    self.parts.append(part)
                    if not part.get('thought') and isinstance(part.get('text'), str):
                        self.publish(part['text'])
                        progressed = progressed or bool(part['text'])
                    elif part.get('thought'):
                        self.thinking()
                        progressed = True
                if not progressed:
                    self.idle()
                target['content'] = {'parts': self.parts}
                self.terminal = self.terminal or bool(candidate.get('finishReason'))
            else:
                self.idle()
            self.terminal = self.terminal or bool((event.get('promptFeedback') or {}).get('blockReason'))
        else:
            kind = event.get('type')
            if kind == 'ping':
                self.idle()  # Anthropic keep-alive: the socket, not the model.
            if kind == 'message_start':
                self.data = dict(event.get('message') or {})
            elif kind == 'content_block_start':
                block = dict(event.get('content_block') or {})
                self.blocks[event['index']] = block
                if block.get('type') == 'text' and block.get('text'):
                    self.publish(block['text'])
                elif block.get('type') in ('thinking', 'redacted_thinking'):
                    self.thinking()
            elif kind == 'content_block_delta':
                block = self.blocks.get(event.get('index'))
                if block is None:
                    self.fail('delta_without_block')
                delta = event.get('delta') or {}
                if delta.get('type') == 'text_delta':
                    text = delta.get('text') or ''
                    block['text'] = block.get('text', '') + text
                    self.publish(text)
                elif delta.get('type') == 'thinking_delta':
                    block['thinking'] = block.get('thinking', '') + (delta.get('thinking') or '')
                    self.thinking()
                elif delta.get('type') == 'signature_delta':
                    block['signature'] = block.get('signature', '') + (delta.get('signature') or '')
                    self.thinking()
            elif kind == 'message_delta':
                self.data.update(event.get('delta') or {})
                self.data['usage'] = {**self.data.get('usage', {}), **event.get('usage', {})}
            elif kind == 'message_stop':
                self.terminal = True
            self.data['content'] = [self.blocks[key] for key in sorted(self.blocks)]
        field = 'usageMetadata' if self.provider == 'gemini' else 'usage'
        usage_event = field in event or event.get('type') in ('message_start', 'message_delta')
        if usage_event:
            accounting.observe(self.data.get(field), self.provider, complete=False,
                           response_id=str(self.data.get('id') or self.data.get('responseId') or ''), http_status=200)

    def fail(self, code):
        raise ProviderTransportError(f'{self.provider} stream {code}', provider=self.provider, model=self.model)


def post_native_stream(url, *, json: dict, headers, timeout, cancel_check, provider, model, trace_file,
                       expected_ids=None):
    if cancel_check and cancel_check():
        raise ProviderGenerationCancelled(f'{provider} generation was cancelled')
    budget = (float(timeout) if isinstance(timeout, (int, float)) and not isinstance(timeout, bool)
              and float(timeout) > 0 else None)
    if budget is not None:
        # Not a per-read timeout: pings would keep such a stream alive forever.
        # Socket reads are bounded like the OpenAI-compatible path; the phase
        # guard (stream_progress) bounds the generation.
        timeout = httpx.Timeout(connect=min(10.0, budget), read=min(30.0, budget),
                                write=min(30.0, budget), pool=min(10.0, budget))
    client = httpx.Client(timeout=timeout)
    stop = threading.Event()
    cancelled = threading.Event()
    state = NativeResponse(provider, model, trace_file)
    started = state.started
    expected_ids = list(expected_ids or ()) or current_line_ids()
    state.lines = LineCompletionDetector(expected_ids or None)
    guard = StreamProgress(started=started, budget_sec=budget, model=model,
                           reasoning_budget_tokens=reasoning_budget_from_payload(json),
                           lines_total=len(expected_ids) if expected_ids else None,
                           report=report_sink(), enforce=budget is not None)
    state.guard = guard
    stopped = [None]
    current = [None]
    def abort():
        for target in (current[0], client):
            try:
                if target is not None:
                    target.close()
            except Exception:
                pass
    def watch():
        while not stop.wait(0.05):
            if cancel_check and cancel_check():
                cancelled.set()
                abort()
                return
            stop_now = guard.check()
            if stop_now is not None:
                stopped[0] = stop_now
                abort()
                return
    watcher = threading.Thread(target=watch, daemon=True) if cancel_check or budget is not None else None
    if watcher:
        watcher.start()
    fields = []
    def dispatch():
        if fields:
            raw = '\n'.join(fields)
            fields.clear()
            with state.timing.measure('wireWrite'):
                wire_trace.append_text('response-stream.sse', 'data: ' + raw + '\n\n')
            try:
                event = json_codec.loads(raw)
            except ValueError:
                state.fail('invalid_json')
            was_terminal = state.terminal
            state.accept(event)
            if state.terminal and not was_terminal:
                state.timing.terminal("provider_terminal")
    try:
        accounting.mark_dispatched()
        with client.stream('POST', url, json=json, headers=headers) as response:
            current[0] = response
            from backend import trace
            trace.note(f'{provider}.generate.response_headers', {
                'stage': 'provider_response_headers', 'provider': provider, 'model': model,
                'status': response.status_code, 'elapsedMs': round((time.perf_counter()-started)*1000, 1),
            }, file=trace_file)
            if not response.is_success:
                response.read()
                return response
            guard.opened()
            for line in response.iter_lines():
                with state.timing.frame():
                    if cancelled.is_set() or (cancel_check and cancel_check()):
                        raise ProviderGenerationCancelled(f'{provider} generation was cancelled')
                    if stopped[0] is not None:
                        raise stopped[0]
                    if line == '':
                        dispatch()
                    elif line.startswith('data:'):
                        fields.append(line[5:].lstrip(' '))
                    elif line.startswith(':'):
                        guard.keepalive()
            dispatch()
            if cancelled.is_set() or (cancel_check and cancel_check()):
                raise ProviderGenerationCancelled(f"{provider} generation was cancelled")
            if stopped[0] is not None:
                raise stopped[0]
            if not state.terminal:
                state.fail('ended_without_terminal')
            return httpx.Response(response.status_code, json=state.data,
                                  request=response.request, extensions={"first_content_ms": state.first_content_ms})
    except Exception as exc:
        if cancelled.is_set() or (cancel_check and cancel_check()):
            raise ProviderGenerationCancelled(f'{provider} generation was cancelled') from exc
        if stopped[0] is not None:
            from backend import trace
            trace.note(f'{provider}.generate.stream_stopped', {
                'stage': 'provider_stream_stopped', 'provider': provider,
                'elapsedMs': round((time.perf_counter() - started) * 1000, 1),
                **getattr(stopped[0], 'stream_stop', {}),
            }, file=trace_file)
            if stopped[0] is exc:
                raise
            raise stopped[0] from exc
        raise
    finally:
        state.timing.finish()
        stop.set()
        if watcher:
            watcher.join(timeout=0.2)
        try:
            client.close()
        except Exception:
            pass
        timing = state.timing.snapshot()
        wire_trace.write_json("09_stream_timing.json", timing)
        from backend import trace
        trace.note(f"{provider}.generate.stream_timing", state.timing.audit(), file=trace_file)
