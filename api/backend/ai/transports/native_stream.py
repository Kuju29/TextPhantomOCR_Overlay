"""Native SSE reception: publish text deltas, retain the final provider contract."""
from __future__ import annotations

import json as json_codec
import threading
import time
import httpx
from backend.ai import accounting, content_stream, wire_trace
from backend.ai.clients.base import ProviderGenerationCancelled
from backend.ai.transports.stream_timing import StreamTiming
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
                for part in (candidate.get('content') or {}).get('parts') or []:
                    self.parts.append(part)
                    if not part.get('thought') and isinstance(part.get('text'), str):
                        self.publish(part['text'])
                target['content'] = {'parts': self.parts}
                self.terminal = self.terminal or bool(candidate.get('finishReason'))
            self.terminal = self.terminal or bool((event.get('promptFeedback') or {}).get('blockReason'))
        else:
            kind = event.get('type')
            if kind == 'message_start':
                self.data = dict(event.get('message') or {})
            elif kind == 'content_block_start':
                block = dict(event.get('content_block') or {})
                self.blocks[event['index']] = block
                if block.get('type') == 'text' and block.get('text'):
                    self.publish(block['text'])
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
                elif delta.get('type') == 'signature_delta':
                    block['signature'] = block.get('signature', '') + (delta.get('signature') or '')
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


def post_native_stream(url, *, json: dict, headers, timeout, cancel_check, provider, model, trace_file):
    if cancel_check and cancel_check():
        raise ProviderGenerationCancelled(f'{provider} generation was cancelled')
    client = httpx.Client(timeout=timeout)
    stop = threading.Event()
    cancelled = threading.Event()
    def watch():
        while not stop.wait(0.05):
            if cancel_check and cancel_check():
                cancelled.set()
                try:
                    client.close()
                except Exception:
                    pass
                return
    watcher = threading.Thread(target=watch, daemon=True) if cancel_check else None
    if watcher:
        watcher.start()
    state = NativeResponse(provider, model, trace_file)
    started = time.perf_counter()
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
            from backend import trace
            trace.note(f'{provider}.generate.response_headers', {
                'stage': 'provider_response_headers', 'provider': provider, 'model': model,
                'status': response.status_code, 'elapsedMs': round((time.perf_counter()-started)*1000, 1),
            }, file=trace_file)
            if not response.is_success:
                response.read()
                return response
            for line in response.iter_lines():
                with state.timing.frame():
                    if cancelled.is_set() or (cancel_check and cancel_check()):
                        raise ProviderGenerationCancelled(f'{provider} generation was cancelled')
                    if line == '':
                        dispatch()
                    elif line.startswith('data:'):
                        fields.append(line[5:].lstrip(' '))
            dispatch()
            if cancelled.is_set() or (cancel_check and cancel_check()):
                raise ProviderGenerationCancelled(f"{provider} generation was cancelled")
            if not state.terminal:
                state.fail('ended_without_terminal')
            return httpx.Response(response.status_code, json=state.data,
                                  request=response.request, extensions={"first_content_ms": state.first_content_ms})
    except Exception as exc:
        if cancelled.is_set() or (cancel_check and cancel_check()):
            raise ProviderGenerationCancelled(f'{provider} generation was cancelled') from exc
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
