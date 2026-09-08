"""Behavioral API contract tests for schema-first translation routing."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

try:
    import httpx  # noqa: F401
except ModuleNotFoundError:
    httpx_stub = types.ModuleType("httpx")
    httpx_stub.RequestError = RuntimeError
    httpx_stub.HTTPStatusError = RuntimeError
    httpx_stub.Response = object
    httpx_stub.Client = object
    httpx_stub.Timeout = lambda **kwargs: kwargs
    httpx_stub.get = lambda *args, **kwargs: None
    sys.modules["httpx"] = httpx_stub

from backend.ai import prompts  # noqa: E402
from backend.ai.capabilities import COMPACT_MARKERS, SCHEMA_OBJECT  # noqa: E402
from backend.ai.clients.base import ChatResult  # noqa: E402
from backend.ai.errors import ModelOutputContractError  # noqa: E402
from backend.ai.provider_registry import provider_registry  # noqa: E402
from backend.ai.translation.contracts import AiConfig  # noqa: E402
from backend.ai.translation.invocation import _translate_once  # noqa: E402


SOURCE = "<<TP_P0>>\n一\n\n<<TP_P1>>\n二"
STYLE = prompts.lang_style("th")


def result(text: str) -> ChatResult:
    return ChatResult(
        text=text, used_model="test-model", input_tokens=20, output_tokens=8,
        total_tokens=28, finish_reason="stop", terminal_completed=True,
        terminal_evidence="provider_done", thinking_applied="requested_off_unverified",
    )


def invoke(provider: str, answer: str, capabilities: dict | None = None):
    spec = provider_registry.require(provider)
    captured = []

    def generate(request):
        captured.append(request)
        return result(answer)

    ai = AiConfig(
        api_key="" if spec.local else "test-api-key",
        provider=provider,
        model="test-model",
        base_url=spec.default_base_url,
        prompt_editable=STYLE,
        prompt_mode="replace",
        thinking="off",
        model_capabilities=capabilities or {},
    )
    with patch.object(spec.adapter, "generate", side_effect=generate), patch(
        "backend.ai.provider_resolution.discovered_model_capabilities",
        return_value=(False, {}),
    ):
        translated = _translate_once(SOURCE, "th", ai)
    return translated, captured


schema_result, schema_calls = invoke("ollama", '{"P1":"สอง","P0":"หนึ่ง"}')
assert len(schema_calls) == 1, "one image must use one provider generation"
schema_request = schema_calls[0]
assert schema_request.response_schema is not None
assert list(schema_request.response_schema["required"]) == ["P0", "P1"]
assert schema_request.response_schema["additionalProperties"] is False
assert "<<TP_" not in schema_request.system_text
assert "expert translator" in schema_request.system_text
assert "Return only the JSON object required by the supplied schema" not in schema_request.system_text
assert len(schema_request.user_parts) == 1
schema_user = schema_request.user_parts[0]
assert schema_user.count("Return only the JSON object required by the supplied schema") == 1
assert schema_user.count("Its keys must be exactly") == 1
assert "TRANSLATION STYLE" not in schema_user
assert schema_user.endswith("SOURCE TEXT\nP0:一\nP1:二")
assert schema_result["meta"]["selected_contract"] == SCHEMA_OBJECT
assert schema_result["meta"]["native_schema"] is True
assert schema_result["meta"]["contract_selection_reason"] == "ollama_native_format_schema"
assert schema_result["meta"]["response_shape"] in {"flat_json", "flat_json_wrapped"}

for capabilities, reason in (
    ({"structured_output": {"supported": False}}, "model_catalogue_rejects_json_schema"),
    ({}, "structured_output_unknown"),
):
    fallback_result, fallback_calls = invoke(
        "openrouter", "<<TP_P1:สอง>>\n<<TP_P0:หนึ่ง>>", capabilities,
    )
    assert len(fallback_calls) == 1
    request = fallback_calls[0]
    assert request.response_schema is None
    assert "<<TP_Pn:translated text>>" not in request.system_text
    assert "Return only the JSON object" not in request.system_text
    assert len(request.user_parts) == 1
    marker_user = request.user_parts[0]
    assert "<<TP_Pn:translated text>>" in marker_user
    assert marker_user.count("OUTPUT — tp.translation.compact-records/1") == 1
    assert marker_user.endswith("SOURCE TEXT\n<<TP_P0:一>>\n<<TP_P1:二>>")
    assert fallback_result["meta"]["selected_contract"] == COMPACT_MARKERS
    assert fallback_result["meta"]["native_schema"] is False
    assert fallback_result["meta"]["contract_selection_reason"] == reason

malformed_calls = []
ollama = provider_registry.require("ollama")


def malformed_generate(request):
    malformed_calls.append(request)
    return result('{"P0":"หนึ่ง"')


with patch.object(ollama.adapter, "generate", side_effect=malformed_generate), patch(
    "backend.ai.provider_resolution.discovered_model_capabilities", return_value=(False, {}),
):
    try:
        _translate_once(SOURCE, "th", AiConfig(
            api_key="", provider="ollama", model="test-model",
            base_url=ollama.default_base_url, prompt_editable=STYLE,
            prompt_mode="replace", thinking="off",
        ))
    except ModelOutputContractError as exc:
        assert exc.code == "AI_OUTPUT_CONTRACT_MISMATCH"
    else:
        raise AssertionError("malformed schema response was accepted")
assert len(malformed_calls) == 1, "schema failure must not trigger a hidden marker retry"

print("API schema routing passed: prompt/payload selection, logs and one-request invariant.")
