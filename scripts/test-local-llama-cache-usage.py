"""Mocked llama.cpp / llamafile cache counters at the API transport boundary."""
from __future__ import annotations

import json
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from backend.ai.transports.openai_compat.core import execute_openai_compatible_request


class LlamaCacheUsageTests(unittest.TestCase):
    def observe(self, provider: str, streamed: bool, cache_n, cached_tokens=...,
                prompt_tokens=30, raw_cached_tokens=...):
        usage = {"completion_tokens": 2, "total_tokens": 32}
        if prompt_tokens is not None:
            usage["prompt_tokens"] = prompt_tokens
        if cached_tokens is not ...:
            usage["prompt_tokens_details"] = {"cached_tokens": cached_tokens}
        if raw_cached_tokens is not ...:
            usage["cached_tokens"] = raw_cached_tokens
        response = {"choices": [{"finish_reason": "stop", "message": {"content": "<<TP_P0:ไทย>>"}}],
                    "usage": usage}
        if cache_n is not ...:
            response["timings"] = {"cache_n": cache_n}

        class Client:
            _textphantom_streaming = streamed

            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            @contextmanager
            def stream(self, *args, **kwargs):
                class StreamResponse:
                    is_success = True
                    status_code = 200
                    headers = {}

                    def raise_for_status(self):
                        pass

                    def close(self):
                        pass

                    def iter_lines(self):
                        yield "data: " + json.dumps({"choices": [{"delta": {"content": "<<TP_P0:ไทย>>"},
                                                                     "finish_reason": "stop"}]})
                        yield "data: " + json.dumps({"choices": [], "usage": usage,
                                                     **({"timings": {"cache_n": cache_n}}
                                                        if cache_n is not ... else {})})
                        yield "data: [DONE]"

                yield StreamResponse()

            def post(self, url, **kwargs):
                return httpx.Response(200, json=response, request=httpx.Request("POST", url))

        with patch.object(httpx, "Client", Client):
            return execute_openai_compatible_request(
                url="http://localhost:8080/v1/chat/completions", headers={},
                payload={"model": "m", "messages": [], "max_tokens": 32},
                model="m", provider_id=provider, timeout=httpx.Timeout(30),
                timeout_policy="local", local_provider=provider not in ("openai",)).usage_details

    def test_llama_native_cache_hits_json_and_sse(self):
        for provider in ("llamacpp", "llamafile"):
            for streamed in (False, True):
                with self.subTest(provider=provider, streamed=streamed):
                    self.assertEqual(self.observe(provider, streamed, 17)["cachedInputTokens"], 17)
                    self.assertEqual(self.observe(provider, streamed, 17, 0)["cachedInputTokens"], 0)
                    self.assertEqual(self.observe(provider, streamed, 17,
                                                  raw_cached_tokens=0)["cachedInputTokens"], 0)
                    self.assertEqual(self.observe(provider, streamed, 17, 7)["cachedInputTokens"], 7)
                    self.assertEqual(self.observe(provider, streamed, 0)["cachedInputTokens"], 0)
                    for invalid in (..., None, True, -1, 31, 1.5, "17"):
                        self.assertIsNone(self.observe(provider, streamed, invalid)["cachedInputTokens"])

    def test_other_local_and_cloud_ignore_native_cache_timings(self):
        for provider in ("jan", "vllm", "openai"):
            for streamed in (False, True):
                with self.subTest(provider=provider, streamed=streamed):
                    self.assertIsNone(self.observe(provider, streamed, 17)["cachedInputTokens"])

    def test_input_must_be_reported_before_timings_mean_cache_hit(self):
        for provider in ("llamacpp", "llamafile"):
            for streamed in (False, True):
                with self.subTest(provider=provider, streamed=streamed):
                    self.assertIsNone(self.observe(provider, streamed, 17,
                                                   prompt_tokens=None)["cachedInputTokens"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
