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
from backend.ai.request_diagnostics import request_diagnostics
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


def invoke(provider: str, answer: str, capabilities: dict | None = None, *, source_context=None, conversation=None):
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
        source_lang="ja",
        source_context=source_context or [],
        translation_mode="conversation" if conversation else "independent",
        conversation=conversation or {},
    )
    with patch.object(spec.adapter, "generate", side_effect=generate), patch(
        "backend.ai.provider_resolution.discovered_model_capabilities",
        return_value=(False, {}),
    ), patch("backend.ai.wire_trace.write_json") as write_json:
        translated = _translate_once(SOURCE, "th", ai)
    contract = next(call.args[1]["contract"] for call in write_json.call_args_list
                    if call.args[0] == "03_wire_units.json")
    meta = translated["meta"]
    assert contract["requested"] == contract["selected"] == meta["selectedOutputContract"]
    assert contract["plannedOutputContract"] == meta["plannedOutputContract"]
    assert contract["parserId"] == meta["parserId"]
    assert contract["decodedResponseShape"] is None  # Nothing decoded at request boundary.
    assert meta["decodedResponseShape"] == meta["response_shape"]
    assert contract["formatSwitch"] is meta["formatSwitch"] is False
    diagnostic = request_diagnostics(meta)
    for key in ("plannedOutputContract", "selectedOutputContract", "selectionReason",
                "decodedResponseShape", "parserId", "formatSwitch"):
        assert diagnostic[key] == meta[key], key
    return translated, captured


schema_result, schema_calls = invoke("ollama", '{"P1":"สอง","P0":"หนึ่ง"}')
assert len(schema_calls) == 1, "one image must use one provider generation"
schema_request = schema_calls[0]
assert schema_request.response_schema is not None
assert list(schema_request.response_schema["required"]) == ["P0", "P1"]
assert schema_request.response_schema["additionalProperties"] is False
assert "<<TP_" not in schema_request.system_text
assert "คุณคือนักแปลและบรรณาธิการมังงะและมังฮวา" in schema_request.system_text
assert "ตอบเฉพาะวัตถุ JSON ตาม schema ที่ให้" not in schema_request.system_text
assert len(schema_request.user_parts) == 1
schema_user = schema_request.user_parts[0]
assert schema_user.count("ตอบเฉพาะวัตถุ JSON ตาม schema ที่ให้") == 1
assert schema_user.count("โดยมีคีย์ตรงตาม") == 1
assert schema_user.count("\nสไตล์การแปล\n") == 0
assert schema_request.system_text.count("\nสไตล์การแปล\n") == 1
assert schema_user.count(STYLE) == 0
assert schema_request.system_text.count(STYLE) == 1
assert schema_user.endswith("ข้อความต้นฉบับ\nP0:一\nP1:二")
assert schema_result["meta"]["selected_contract"] == SCHEMA_OBJECT
assert schema_result["meta"]["native_schema"] is True
assert schema_result["meta"]["parserId"] == "schema_object"
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
    assert "<<TP_Pn:คำแปล>>" not in request.system_text
    assert "Return only the JSON object" not in request.system_text
    assert len(request.user_parts) == 1
    marker_user = request.user_parts[0]
    assert "<<TP_Pn:คำแปล>>" in marker_user
    assert marker_user.count("รูปแบบคำตอบ — tp.translation.compact-records/1") == 1
    assert marker_user.endswith("ข้อความต้นฉบับ\n<<TP_P0:一>>\n<<TP_P1:二>>")
    assert fallback_result["meta"]["selected_contract"] == COMPACT_MARKERS
    assert fallback_result["meta"]["native_schema"] is False
    assert fallback_result["meta"]["plannedOutputContract"] == COMPACT_MARKERS
    assert fallback_result["meta"]["parserId"] == "compact_records"
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
        details = exc.structural_details
        assert details["plannedOutputContract"] == details["selectedOutputContract"] == SCHEMA_OBJECT
        assert details["expectedContract"] == SCHEMA_OBJECT
        assert details["parserId"] == "schema_object"
        assert details["decodedResponseShape"] == exc.response_shape
        assert details["formatSwitch"] is False
    else:
        raise AssertionError("malformed schema response was accepted")
assert len(malformed_calls) == 1, "schema failure must not trigger a hidden marker retry"

print("API schema routing passed: prompt/payload selection, logs and one-request invariant.")


# Exercise the actual API invocation, not just a standalone prompt builder.
for provider, answer in (("ollama", '{"P0":"หนึ่ง","P1":"สอง"}'),
                         ("openrouter", "<<TP_P0:หนึ่ง>><<TP_P1:สอง>>")):
    _, calls = invoke(provider, answer, source_context=[
        {"targetIds": ["P0"], "origin": "initial_request", "units": [{"id": "g9", "text": "First page context"}]},
        {"targetIds": ["P1"], "origin": "initial_request", "units": [{"id": "g9", "text": "Different page context"}]},
    ])
    assert len(calls) == 1, "source context must not introduce additional provider calls"
    wire = calls[0].user_parts[0]
    assert '"appliesTo":["P0"]' in wire and '"appliesTo":["P1"]' in wire
    assert wire.count("First page context") == 1 and wire.count("Different page context") == 1
    assert "ต้นฉบับที่เก็บจากคำขอก่อน — อ่านเท่านั้น" in wire
    assert "source-context" not in calls[0].expected_ids
    assert tuple(calls[0].expected_ids) == ("P0", "P1")
print("PASS 2 actual API generation boundary captures: source-only context retained per target scope; one call; unchanged expected IDs (mock adapter).")

# Conversation must report its forced marker grammar even on schema-capable Ollama.
from backend.ai.translation_paths.mode import descriptor
conversation = descriptor({'documentId':'format-diagnostics', 'pageId':'page-1', 'pageIndex':0},
                          context={'tp_tab_session':'format-test-owner'})
conversation['origins'] = [{'pageId':'page-1','pageIndex':0,'pageOrder':1,
                            'unitIds':['I1_P0','I1_P1'],'originalIds':['P0','P1']}]
translated, calls = invoke('ollama', '<<I1_P0:หนึ่ง>>\n<<I1_P1:สอง>>', conversation=conversation)
assert calls[0].response_schema is None
assert translated['meta']['plannedOutputContract'] == 'tp.translation.compact-records/1'
assert translated['meta']['selectionReason'] == 'conversation_marker_contract'
assert translated['meta']['parserId'] == 'compact_records'
print('PASS Conversation marker provenance on schema-capable Ollama; no contract switch.')
