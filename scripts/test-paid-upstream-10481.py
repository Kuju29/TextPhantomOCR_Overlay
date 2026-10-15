""".81: the API keeps the OpenRouter upstream the Center reports for a Paid call,
so each Conversation turn records which server answered (cache can only hit on
the same server). Older Centers that do not report it keep working unchanged."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
os.environ["TP_CENTER_URL"] = "http://127.0.0.1:8787"

import httpx
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_paid

BASE = {"id": "gen", "model": "qa/test", "choices": [{"message": {"content": "<<I1_P0:ok>>"},
        "finish_reason": "stop"}], "usage": {"prompt_tokens": 30, "completion_tokens": 2, "cost": "0.0001",
        "prompt_tokens_details": {"cached_tokens": 24}}, "charged_tp": "1", "balance_tp": "9"}


def run(body):
    class Client:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def post(self, url, **kwargs):
            return httpx.Response(200, json=body, request=httpx.Request("POST", url))

    request = GenerationRequest(provider="paid", model="qa/test", api_key="synthetic-session",
                                system_text="QA", user_parts=("hello",), cache_context={"operationId": "up-qa"})
    events = []
    with patch.object(cloud_paid, "center_client", lambda *a, **k: Client()), \
         patch("backend.ai.paid_protocol.require_protocol", lambda *a, **k: None), \
         patch.object(cloud_paid.diagnostics, "emit", lambda event, **data: events.append((event, data))):
        return cloud_paid.ADAPTER.generate(request), events


result, events = run({**BASE, "provider": "DeepInfra"})
assert result.text == "<<I1_P0:ok>>" and result.upstream_provider == "DeepInfra", result
done = dict(next(data for event, data in events if event == "paid.center.completed"))
assert done["upstream_provider"] == "DeepInfra" and done["cached_input_tokens"] == 24, done

result, events = run(BASE)  # An older Center: no label, nothing invented.
assert result.text == "<<I1_P0:ok>>" and not result.upstream_provider, result
done = dict(next(data for event, data in events if event == "paid.center.completed"))
assert done["upstream_provider"] is None, done

result, _ = run({**BASE, "provider": "<img src=x onerror=1>"})  # Not a bounded label: dropped.
assert not result.upstream_provider, result

# The Conversation path already turns ChatResult.upstream_provider into
# resolvedUpstreamProvider for every committed turn.
source = (ROOT / "api/backend/ai/translation_paths/conversation.py").read_text(encoding="utf-8")
assert 'ev["resolvedUpstreamProvider"]' in source and '"upstreamProvider": resolved_upstream' in source
print('{"passed": 4, "scope": "API keeps the Center-reported OpenRouter upstream for Paid; old Centers unchanged"}')
