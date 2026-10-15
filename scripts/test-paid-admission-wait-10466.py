""".66: Center answers that prove 'not sent to AI, no credit reserved' are waited
out by the API (bounded), never turned into a failed image or a second generation."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
os.environ["TP_CENTER_URL"] = "http://127.0.0.1:8787"
os.environ["TP_PAID_ADMISSION_WAIT_SECONDS"] = "6"

import httpx
from backend.ai.clients.provider_error import ProviderHttpError
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_paid

BUSY = {"error": {"code": "PAID_CREDITS_RESERVED", "details": {
    "provider_dispatched": False, "credit_reserved": False, "credit_state": "not_reserved",
    "retry_after_seconds": 2}}}
DISPATCHED_429 = {"error": {"code": "PAID_PROVIDER_LIMITED", "details": {
    "upstream_http_status": 429, "provider_dispatched": True, "credit_state": "released"}}}
OK = {"id": "gen", "model": "qa/test", "choices": [{"message": {"content": "<<I1_P0:ok>>"},
      "finish_reason": "stop"}], "usage": {"prompt_tokens": 3, "completion_tokens": 2, "cost": "0.0001"},
      "charged_tp": "1", "balance_tp": "9"}


def run(responses, cancel_check=None):
    posts = []

    class Client:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def post(self, url, **kwargs):
            posts.append(kwargs["json"]["operation_id"])
            status, body, headers = responses[min(len(posts) - 1, len(responses) - 1)]
            return httpx.Response(status, json=body, headers=headers or {},
                                  request=httpx.Request("POST", url))

    request = GenerationRequest(provider="paid", model="qa/test", api_key="synthetic-session",
                                system_text="QA", user_parts=("hello",),
                                cache_context={"operationId": "wait-qa"}, cancel_check=cancel_check)
    with patch.object(cloud_paid, "center_client", lambda *a, **k: Client()), \
         patch("backend.ai.paid_protocol.require_protocol", lambda *a, **k: None), \
         patch.object(cloud_paid, "_wait", lambda seconds, check: not (check and check())):
        try:
            return cloud_paid.ADAPTER.generate(request), posts
        except ProviderHttpError as exc:
            return exc, posts


result, posts = run([(429, BUSY, {"Retry-After": "2"}), (429, BUSY, None), (200, OK, None)])
assert result.text == "<<I1_P0:ok>>", result
assert len(posts) == 3 and len(set(posts)) == 1, "Same operation id; Center admits it once"

result, posts = run([(502, DISPATCHED_429, None), (200, OK, None)])
assert isinstance(result, ProviderHttpError) and len(posts) == 1, "Dispatched/upstream errors are never re-sent"

result, posts = run([(429, BUSY, None), (200, OK, None)], cancel_check=lambda: True)
assert isinstance(result, ProviderHttpError) and len(posts) == 1, "Cancellation stops waiting"

result, posts = run([(429, {"error": {"code": "PAID_CREDITS_RESERVED", "details": {
    "provider_dispatched": True}}}, None), (200, OK, None)])
assert isinstance(result, ProviderHttpError) and len(posts) == 1, "No wait without no-dispatch evidence"
print('{"passed": 4, "scope": "API waits on Center no-dispatch busy answers only"}')
