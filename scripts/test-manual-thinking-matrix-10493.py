"""10493 Manual AI think matrix: every Manual Cloud provider, catalogue only.

Owner question: "Can some Manual providers not check AI think, e.g. Hugging
Face?" Since 10491 selecting a Manual model sends no generation probe; the
AI think control comes only from the provider's own model list read by
/ai/resolve. This drives the real `resolve()` for all nine Manual Cloud
providers with each provider's real catalogue row shape (HTTP mocked, any
POST/stream fails the test) and records the state the popup will show.

Before 10491 the selected-model probe added reasoning evidence for exactly
two cases (ai/probe.py -> adapter.probe capabilities): Hugging Face routes
that accepted `reasoning_effort: "none"` (Off), and OpenAI IDs missing from
the documented model-card map (none/low). Neither catalogue publishes
reasoning (HF router /v1/models: provider/status/context_length/pricing/
supports_tools/supports_structured_output/latency/throughput; OpenAI
/v1/models: id/object/created/owned_by), so their honest state is now
"default" (provider decides, control disabled, no thinking field sent).
A failed/slow catalogue is "loading", never "default".

`--json` prints the rows for scripts/test-manual-thinking-matrix-10493.mjs,
which feeds them through the popup's own selection/classification code.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

import httpx  # noqa: E402

from backend.ai.resolve import resolve  # noqa: E402
from backend.ai.provider_resolution import forget_model_capabilities  # noqa: E402
from backend.ai.thinking_state import classify_thinking_state, thinking_control_options  # noqa: E402

LIVE_HF = {"provider": "groq", "status": "live", "context_length": 131072,
           "pricing": {"input": 0.1, "output": 0.5}, "supports_tools": True,
           "supports_structured_output": True, "first_token_latency_ms": 210,
           "throughput": 480.0, "is_model_author": False}

# provider, key, catalogue URL fragment, catalogue body, selected model,
# expected state now, options, state before 10491 (probe era), data source.
CASES = [
    ("openrouter", "sk-or-fixture", "/models/user",
     {"data": [{"id": "vendor/thinker", "supported_parameters": ["reasoning", "include_reasoning", "temperature"],
                "reasoning": {"mandatory": False, "supported_efforts": ["low", "medium", "high"]},
                "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}}]},
     "vendor/thinker", "controllable", ["off", "low", "medium", "high"], "controllable",
     "openrouter /models/user supported_parameters+reasoning"),
    ("openrouter", "sk-or-fixture", "/models/user",
     {"data": [{"id": "vendor/plain", "supported_parameters": ["temperature"],
                "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}}]},
     "vendor/plain", "none", [], "none", "openrouter /models/user (no reasoning parameter)"),
    ("huggingface", "hf_fixture", "router.huggingface.co/v1/models",
     {"data": [{"id": "vendor/hf-model", "object": "model", "owned_by": "vendor",
                "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
                "providers": [LIVE_HF]}]},
     "vendor/hf-model", "default", [], "controllable(off) if route accepted reasoning_effort=none",
     "HF router /v1/models (no reasoning field)"),
    ("huggingface", "hf_fixture", "router.huggingface.co/v1/models",
     {"data": [{"id": "vendor/hf-model", "object": "model", "owned_by": "vendor",
                "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
                "providers": [LIVE_HF]}]},
     "vendor/hf-model:groq", "default", [], "controllable(off) if route accepted reasoning_effort=none",
     "HF router /v1/models explicit route (no reasoning field)"),
    ("gemini", "AIzaFixture", "generativelanguage.googleapis.com",
     {"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"],
                  "thinking": True, "inputTokenLimit": 1048576, "outputTokenLimit": 65536}]},
     "gemini-2.5-flash", "controllable", ["off", "low", "medium", "high"], "controllable",
     "documented model map + models.list"),
    ("gemini", "AIzaFixture", "generativelanguage.googleapis.com",
     {"models": [{"name": "models/gemini-future-9", "supportedGenerationMethods": ["generateContent"],
                  "thinking": True}]},
     "gemini-future-9", "default", [], "default", "models.list thinking=true, no control published"),
    ("openai", "sk-fixture", "api.openai.com",
     {"data": [{"id": "gpt-5.2", "object": "model", "owned_by": "openai"}]},
     "gpt-5.2", "controllable", ["off", "low", "medium", "high", "xhigh"], "controllable",
     "documented model-card map"),
    ("openai", "sk-fixture", "api.openai.com",
     {"data": [{"id": "gpt-5-mini", "object": "model", "owned_by": "openai"}]},
     "gpt-5-mini", "default", [], "controllable(off/low) via probe",
     "OpenAI /v1/models (id only; not in documented map)"),
    ("openai", "sk-fixture", "api.openai.com",
     {"data": [{"id": "gpt-9-future", "object": "model", "owned_by": "openai"}]},
     "gpt-9-future", "default", [], "controllable(off/low) via probe",
     "OpenAI /v1/models (id only, no reasoning)"),
    ("anthropic", "sk-ant-fixture", "api.anthropic.com",
     {"data": [{"id": "claude-sonnet-4-5", "max_input_tokens": 200000, "max_tokens": 64000}]},
     "claude-sonnet-4-5", "controllable", None, "controllable", "documented native map + /v1/models"),
    ("anthropic", "sk-ant-fixture", "api.anthropic.com",
     {"data": [{"id": "claude-future-9",
                "capabilities": {"thinking": {"supported": False}, "effort": {"supported": False}}}]},
     "claude-future-9", "none", [], "none", "/v1/models capabilities.thinking=false"),
    ("anthropic", "sk-ant-fixture", "api.anthropic.com",
     {"data": [{"id": "claude-future-10"}]},
     "claude-future-10", "default", [], "default", "/v1/models (no capabilities object)"),
    ("groq", "gsk_fixture", "api.groq.com",
     {"data": [{"id": "openai/gpt-oss-20b", "context_window": 131072, "max_completion_tokens": 65536}]},
     "openai/gpt-oss-20b", "controllable", None, "controllable", "documented native map + /models limits"),
    ("groq", "gsk_fixture", "api.groq.com",
     {"data": [{"id": "vendor/future", "context_window": 131072}]},
     "vendor/future", "default", [], "default", "/models (no reasoning field)"),
    ("deepseek", "sk-fixture", "api.deepseek.com",
     {"data": [{"id": "deepseek-v4-pro", "effort": {"supported_levels": ["low", "high"], "default_level": "high"},
                "context_window": 1000000}]},
     "deepseek-v4-pro", "controllable", ["off", "low", "high"], "controllable", "/models effort.supported_levels"),
    ("deepseek", "sk-fixture", "api.deepseek.com",
     {"data": [{"id": "deepseek-v4-pro"}]},
     "deepseek-v4-pro", "default", [], "default", "/models (no effort object)"),
    ("together", "tg-fixture", "api.together.xyz",
     [{"id": "Qwen/Qwen3.5-9B", "type": "chat", "context_length": 262144}],
     "Qwen/Qwen3.5-9B", "controllable", ["off", "on"], "controllable", "documented native map + /models"),
    ("together", "tg-fixture", "api.together.xyz",
     [{"id": "vendor/future", "type": "chat", "context_length": 32768}],
     "vendor/future", "default", [], "default", "/models (no reasoning field)"),
    ("featherless", "fl-fixture", "api.featherless.ai",
     {"data": [{"id": "vendor/feather", "context_length": 32768, "max_completion_tokens": 4096,
                "vision_supported": False}]},
     "vendor/feather", "default", [], "default", "/models (no reasoning field)"),
]


class FakeResponse:
    def __init__(self, body, status=200):
        self._body, self.status_code = body, status
        self.is_success = 200 <= status < 300
        self.headers, self.text = {}, json.dumps(body)

    def json(self):
        return self._body


class FakeClient:
    routes: dict[str, object] = {}
    unreachable = False
    gets: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, url, *args, **kwargs):
        FakeClient.gets.append(str(url))
        if FakeClient.unreachable:
            raise httpx.ConnectTimeout("catalogue too slow")
        if str(url).rstrip("/").endswith("/plan"):
            return FakeResponse({"max_context_length": None})
        for fragment, body in FakeClient.routes.items():
            if fragment in str(url):
                return FakeResponse(body)
        return FakeResponse({"error": "not found"}, 404)

    def post(self, *args, **kwargs):
        raise AssertionError("selecting a Manual model must not send a generation request")

    stream = post


def fake_get(url, *args, **kwargs):
    return FakeClient().get(url, *args, **kwargs)


def popup_fresh(result, model):
    """Mirror of popup-ui-controller thinkingRecordForSelection (Manual Cloud)."""
    reasoning = (result.get("model_capabilities") or {}).get("reasoning")
    same = result.get("model") == model
    models = result.get("models") or []
    fresh = bool(same and model and (result.get("models_verified") is True or isinstance(reasoning, dict))
                 and result.get("model_status") != "unavailable" and (not models or model in models))
    return fresh, (reasoning if fresh else None)


POPUP_FIELDS = ("provider", "model", "requested_model", "models", "models_verified", "model_status",
                "key_status", "model_capabilities")


def run(provider, key, fragment, body, model, *, unreachable=False):
    FakeClient.routes, FakeClient.unreachable, FakeClient.gets = {fragment: body}, unreachable, []
    with patch.object(httpx, "Client", FakeClient), patch.object(httpx, "get", fake_get), \
            patch.object(httpx, "post", FakeClient.post):
        result = dict(resolve({"provider": provider, "api_key": key, "model": model, "lang": "th"}))
    forget_model_capabilities(provider, result.get("base_url") or "", key)
    return {field: result.get(field) for field in POPUP_FIELDS}


rows, checks = [], 0
for provider, key, fragment, body, model, expected, options, before, source in CASES:
    result = run(provider, key, fragment, body, model)
    fresh, reasoning = popup_fresh(result, model)
    state = classify_thinking_state(reasoning, fresh=fresh)
    assert result.get("models_verified") is True, (provider, model, result)
    assert state == expected, f"{provider} {model}: {state} != {expected} ({reasoning})"
    if options is not None:
        assert list(thinking_control_options(reasoning)) == options, (provider, model, reasoning)
    checks += 1
    rows.append({"provider": provider, "model": model, "credential": key, "resolve": result,
                 "state": state, "before": before, "source": source,
                 "changed": not before.startswith(expected)})
    # The same provider with an unreachable/slow catalogue is "loading", not "default".
    failed = run(provider, key, fragment, body, model, unreachable=True)
    fresh, reasoning = popup_fresh(failed, model)
    assert failed.get("models_verified") is False, (provider, failed)
    assert classify_thinking_state(reasoning, fresh=fresh) == "loading", (provider, model, failed)
    checks += 1
    rows.append({"provider": provider, "model": model, "credential": key, "resolve": failed,
                 "state": "loading", "before": "loading", "source": "catalogue unreachable",
                 "changed": False})

covered = {row["provider"] for row in rows}
assert covered == {"openrouter", "huggingface", "gemini", "openai", "anthropic", "groq",
                   "deepseek", "together", "featherless"}, covered
regressed = sorted({(row["provider"], row["model"]) for row in rows if row["changed"]})
assert regressed == [("huggingface", "vendor/hf-model"), ("huggingface", "vendor/hf-model:groq"),
                     ("openai", "gpt-5-mini"), ("openai", "gpt-9-future")], regressed

if "--json" in sys.argv:
    print(json.dumps(rows))
else:
    print(f"PASS Manual AI think matrix 10493: {checks} checks, 9 providers, no generation request; "
          f"changed since probe removal (catalogue has no reasoning -> default): {regressed}")
