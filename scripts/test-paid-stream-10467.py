""".67: Paid relays Center NDJSON deltas live; terminal lines reuse the JSON paths.

No Center, provider or credits are used. The Center client is a local fake.
"""
from __future__ import annotations

import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
os.environ["TP_CENTER_URL"] = "http://127.0.0.1:8787"
os.environ["TP_PAID_ADMISSION_WAIT_SECONDS"] = "6"

import httpx
from backend.ai import content_stream
from backend.ai.clients.base import ProviderGenerationCancelled
from backend.ai.clients.provider_error import ProviderHttpError, ProviderTransportError
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_paid

FINAL = {"id": "gen", "model": "qa/test", "choices": [{"message": {"content": "<<I1_P0:สวัสดี>>"},
         "finish_reason": "stop"}], "usage": {"prompt_tokens": 3, "completion_tokens": 2, "cost": "0.0001"},
         "charged_tp": "7", "balance_tp": "93"}
NOT_ENOUGH = {"error": {"code": "INSUFFICIENT_CREDITS", "message": "x"}}
RELEASED = {"error": {"code": "PROVIDER_OUTCOME_UNKNOWN", "message": "x",
            "details": {"provider_dispatched": True, "credit_state": "released", "upstream_http_status": 502}}}


def ndjson(*events):
    return "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events).encode()


def run(responses, *, scoped=True, advertised=True, emit=None):
    sent, shown = [], []

    class Client:
        def __enter__(self): return self
        def __exit__(self, *args): return False

        def _response(self, url, body):
            sent.append(body)
            status, kind, content = responses[min(len(sent) - 1, len(responses) - 1)]
            return httpx.Response(status, headers={"content-type": kind, "x-request-id": "rq"},
                                  content=content, request=httpx.Request("POST", url))

        def post(self, url, json, headers):
            return self._response(url, json)

        @contextmanager
        def stream(self, method, url, json, headers):
            yield self._response(url, json)

    request = GenerationRequest(provider="paid", model="qa/test", api_key="synthetic-session",
                                system_text="QA", user_parts=("hello",),
                                cache_context={"operationId": "stream-qa"})
    deliver = emit or shown.append
    with patch.object(cloud_paid, "center_client", lambda *a, **k: Client()), \
         patch("backend.ai.paid_protocol.require_protocol", lambda *a, **k: None), \
         patch("backend.ai.paid_protocol.stream_supported", lambda base: advertised), \
         patch.object(cloud_paid, "_wait", lambda seconds, check: True):
        try:
            if scoped:
                with content_stream.scope(deliver):
                    return cloud_paid.ADAPTER.generate(request), sent, shown
            return cloud_paid.ADAPTER.generate(request), sent, shown
        except (ProviderHttpError, ProviderTransportError) as exc:
            return exc, sent, shown


NDJSON, JSON = "application/x-ndjson", "application/json"
checks = 0

# 1. Deltas are shown as they arrive; the final line is the same JSON answer.
result, sent, shown = run([(200, NDJSON, ndjson({"type": "delta", "text": "<<I1_P0:สวั"},
                                                {"type": "delta", "text": "สดี>>"},
                                                {"type": "final", "status": 200, "body": FINAL}))])
assert sent[0]["stream"] is True and shown == ["<<I1_P0:สวั", "สดี>>"], (sent, shown)
assert result.text == "<<I1_P0:สวัสดี>>" and result.usage_details["chargedTp"] == "7"
assert result.terminal_evidence == "center_ndjson_final"
checks += 1

# 2. A failure after deltas keeps the Center's status and credit evidence.
result, sent, shown = run([(200, NDJSON, ndjson({"type": "delta", "text": "<<I1"},
                                                {"type": "error", "status": 502, "body": RELEASED}))])
assert isinstance(result, ProviderHttpError) and shown == ["<<I1"]
assert result.center_credit_state == "released" and result.status == 502
checks += 1

# 3. Errors before any delta are ordinary JSON with no-dispatch evidence.
result, sent, shown = run([(402, JSON, json.dumps(NOT_ENOUGH).encode())])
assert isinstance(result, ProviderHttpError) and result.centerAdmissionRejected is True and not shown
checks += 1

# 4. Admission waits and owned replays still use the JSON route semantics.
busy = {"error": {"code": "PAID_CAPACITY_BUSY", "details": {"provider_dispatched": False,
        "credit_reserved": False, "credit_state": "not_reserved", "retry_after_seconds": 1}}}
result, sent, shown = run([(429, JSON, json.dumps(busy).encode()), (200, JSON, json.dumps(FINAL).encode())])
assert result.text == FINAL["choices"][0]["message"]["content"] and len(sent) == 2
assert len({body["operation_id"] for body in sent}) == 1
checks += 1

# 5. Stream is only requested when the page streams and the Center advertises it.
for kwargs in ({"scoped": False}, {"advertised": False}):
    result, sent, shown = run([(200, JSON, json.dumps(FINAL).encode())], **kwargs)
    assert "stream" not in sent[0] and result.terminal_evidence == "center_http_json"
os.environ["TP_PAID_STREAM"] = "0"
result, sent, shown = run([(200, JSON, json.dumps(FINAL).encode())])
assert "stream" not in sent[0]
del os.environ["TP_PAID_STREAM"]
checks += 1

# 6. A cut stream after dispatch is an unknown outcome, never a retry.
result, sent, shown = run([(200, NDJSON, ndjson({"type": "delta", "text": "<<I1"}))])
assert isinstance(result, ProviderTransportError) and len(sent) == 1
checks += 1

# 7. If the page leaves, keep reading so the dispatched answer's charge is recorded.
def leave(text):
    raise ProviderGenerationCancelled("page closed")
result, sent, shown = run([(200, NDJSON, ndjson({"type": "delta", "text": "<<I1"},
                                                {"type": "final", "status": 200, "body": FINAL}))], emit=leave)
assert result.usage_details["chargedTp"] == "7"
checks += 1
print(json.dumps({"passed": checks, "scope": "Paid NDJSON relay over the unchanged Center JSON contract"}))
