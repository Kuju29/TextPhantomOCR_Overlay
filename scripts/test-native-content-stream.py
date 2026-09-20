"""Native-provider loopback proof: text before terminal, final usage retained."""
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai import content_stream
from backend.ai.providers import cloud_gemini, cloud_anthropic
from backend.ai.clients.base import ProviderGenerationCancelled
from backend.ai.clients.provider_error import ProviderTransportError, ProviderHttpError
from backend.ai.transports.native_stream import post_native_stream

A, B = '<<TP_I1_P1:ไทย>>', '<<TP_I2_P1:สอง>>'

def events(provider):
    if provider == 'gemini':
        return [
            {'candidates': [{'content': {'parts': [{'text': 'private reasoning', 'thought': True}]}}]},
            {'candidates': [{'content': {'parts': [{'text': A}]}}]},
            {'candidates': [{'content': {'parts': [{'text': B}]}, 'finishReason': 'STOP'}]},
            {'usageMetadata': {'promptTokenCount': 100, 'candidatesTokenCount': 20,
                              'totalTokenCount': 125, 'thoughtsTokenCount': 5,
                              'cachedContentTokenCount': 80}, 'responseId': 'g1'},
        ]
    return [
        {'type': 'message_start', 'message': {'id': 'a1', 'usage': {
            'input_tokens': 100, 'output_tokens': 1, 'cache_read_input_tokens': 80}}},
        {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': A}},
        {'type': 'ping'},
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': B}},
        {'type': 'content_block_stop', 'index': 0},
        {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 20}},
        {'type': 'message_stop'},
    ]

class Server:
    def __init__(self, frames, gate=False, status=200):
        self.frames, self.gate, self.status = frames, gate, status
        self.seen = threading.Event()
        self.calls = []
    def __enter__(self):
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                owner.calls.append((self.path, json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(owner.status)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                try:
                    for frame in owner.frames:
                        raw = json.dumps(frame, ensure_ascii=False)
                        self.wfile.write(('data: ' + raw + '\n\n').encode()); self.wfile.flush()
                        if owner.gate and A in raw:
                            if not owner.seen.wait(3):
                                raise AssertionError('Provider buffered A until terminal')
                except (BrokenPipeError, ConnectionResetError): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/generateContent'
        return self
    def __exit__(self, *args):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

class NativeStreamTests(unittest.TestCase):
    def setUp(self):
        clean = {key: value for key, value in os.environ.items() if not key.lower().endswith("_proxy")}
        proxy_patch = patch.dict(os.environ, clean, clear=True)
        proxy_patch.start()
        self.addCleanup(proxy_patch.stop)
    def generate(self, provider, cancel=None):
        module = cloud_gemini if provider == 'gemini' else cloud_anthropic
        model = 'gemini-2.5-flash' if provider == 'gemini' else 'claude-sonnet-4-6'
        return module.generate('test', model, 'translate', ['source'], cancel_check=cancel)
    def test_live_text_precedes_terminal_and_usage_retained(self):
        for provider in ('gemini', 'anthropic'):
            with self.subTest(provider=provider), Server(events(provider), gate=True) as server:
                module = cloud_gemini if provider == 'gemini' else cloud_anthropic
                url = server.url + ':generateContent?key={key}' if provider == 'gemini' else server.url
                seen = []
                def receive(text):
                    seen.append(text)
                    if text == A: server.seen.set()
                with patch.object(module, '_ENDPOINT', url), content_stream.scope(receive):
                    result = self.generate(provider)
                self.assertTrue(server.seen.is_set())
                self.assertEqual(seen, [A, B]); self.assertEqual(result.text, A+B)
                self.assertEqual(result.output_tokens, 25 if provider == "gemini" else 20)
                self.assertIsNotNone(result.first_content_ms)
                self.assertEqual(result.cached_input_tokens, 80)
                self.assertTrue(result.terminal_completed)
                self.assertEqual(len(server.calls), 1)
                if provider == 'gemini': self.assertIn('streamGenerateContent?alt=sse', server.calls[0][0])
                else: self.assertTrue(server.calls[0][1]['stream'])
    def test_missing_terminal_is_failure_not_success(self):
        for provider in ('gemini', 'anthropic'):
            frames = events(provider)[:2] if provider == 'gemini' else events(provider)[:-1]
            with self.subTest(provider=provider), Server(frames) as server, content_stream.scope(lambda _: None):
                with self.assertRaises(ProviderTransportError):
                    post_native_stream(server.url, json={}, headers={}, timeout=2,
                        cancel_check=None, provider=provider, model='test', trace_file=__file__)
    def test_error_event_is_visible(self):
        with Server([{'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}]) as server:
            with self.assertRaises(ProviderHttpError):
                post_native_stream(server.url, json={}, headers={}, timeout=2,
                    cancel_check=None, provider='anthropic', model='test', trace_file=__file__)
    def test_precancel_never_dispatches(self):
        with Server([]) as server:
            with self.assertRaises(ProviderGenerationCancelled):
                post_native_stream(server.url, json={}, headers={}, timeout=2,
                    cancel_check=lambda: True, provider='gemini', model='test', trace_file=__file__)
            self.assertEqual(server.calls, [])
    def test_cancel_after_first_text(self):
        cancelled = threading.Event()
        with Server(events('gemini')) as server, content_stream.scope(lambda _: cancelled.set()):
            with self.assertRaises(ProviderGenerationCancelled):
                post_native_stream(server.url, json={}, headers={}, timeout=2,
                    cancel_check=cancelled.is_set, provider='gemini', model='test', trace_file=__file__)
            self.assertEqual(len(server.calls), 1)
    def test_blocked_and_empty_responses_fail(self):
        for body in ({'promptFeedback': {'blockReason': 'SAFETY'}},
                     {'candidates': [{'finishReason': 'STOP', 'content': {'parts': []}}]}):
            with self.subTest(body=body), Server([body]) as server:
                with patch.object(cloud_gemini, '_ENDPOINT', server.url), content_stream.scope(lambda _: None):
                    with self.assertRaises(RuntimeError):
                        self.generate('gemini')

    def test_thinking_not_visible_and_cumulative_usage_not_summed(self):
        from backend.ai.transports.native_stream import NativeResponse
        seen = []
        state = NativeResponse('anthropic', 'test')
        with content_stream.scope(seen.append):
            state.accept({'type': 'message_start', 'message': {'usage': {'input_tokens': 10}}})
            state.accept({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'thinking', 'thinking': ''}})
            state.accept({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'private'}})
            state.accept({'type': 'message_delta', 'usage': {'output_tokens': 3}})
            state.accept({'type': 'message_delta', 'usage': {'output_tokens': 7}})
        self.assertEqual(seen, [])
        self.assertEqual(state.data['usage'], {'input_tokens': 10, 'output_tokens': 7})

if __name__ == '__main__': unittest.main()
