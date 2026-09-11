"""Actual generation-boundary contract matrix for all 19 API providers."""

from __future__ import annotations

import sys
import types
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

# Keep this committed boundary test runnable in the extension-only build
# environment, where API deployment dependencies are intentionally absent.
try:
    import httpx  # noqa: F401
except ModuleNotFoundError:
    class _RequestError(Exception):
        pass
    class _HTTPStatusError(_RequestError):
        pass
    httpx_stub = types.ModuleType("httpx")
    httpx_stub.RequestError = _RequestError
    httpx_stub.HTTPStatusError = _HTTPStatusError
    httpx_stub.Response = object
    httpx_stub.Client = object
    httpx_stub.Timeout = lambda **kwargs: kwargs
    httpx_stub.get = lambda *args, **kwargs: None
    sys.modules["httpx"] = httpx_stub

from backend.ai import markers, prompts
from backend.ai.errors import ModelOutputContractError
from backend.ai.provider_contract import GenerationRequest, ProbeRequest
from backend.ai.provider_registry import ProviderRegistry
from backend.ai.providers import cloud_anthropic, cloud_gemini, compose_providers
from backend.ai.transports import openai_chat
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.result_decode import _require_authoritative_terminal, decode_result


SOURCE = "<<TP_P0:  OCR source  >>\n<<TP_P1:second>>\n<<TP_P2:third>>"
STYLE, _STYLE_SOURCE = prompts.select_style(
    "th", prompts.lang_style("th"), "replace",
)
assert len(STYLE) > 2500 and "CHARACTER SHEET and SERIES MEMORY" in STYLE
assert "Never move, merge, duplicate or discard meaning across IDs" in STYLE
assert "Silently check meaning" not in STYLE and "MICRO-EXAMPLES" not in STYLE
OCR_OUTPUT_RULE = "Correct missing, extra or misread characters only when the supplied text makes the intended reading unambiguous"
assert prompts.prompt_metadata("th", prompts.lang_style("th"), "replace")["promptVersion"] == "th-natural-8"
assert prompts.prompt_metadata("en", prompts.lang_style("en"), "replace")["promptVersion"] == "en-natural-6"
assert prompts.prompt_metadata("ja", prompts.lang_style("ja"), "replace")["promptVersion"] == "ja-natural-6"
ANSWER = "<<TP_P0:คำแปล>>"
USAGE = (23, 7, 30)
CLOUD_FIELDS = {
    "anthropic": {"max_tokens"},
    "deepseek": {"temperature", "max_tokens"},
    "featherless": {"max_tokens"},
    "gemini": {"maxOutputTokens", "responseMimeType"},
    "groq": {"temperature", "max_completion_tokens"},
    "huggingface": {"temperature", "max_tokens"},
    "openai": {"max_completion_tokens"},
    "openrouter": {"temperature", "max_tokens"},
    "together": {"temperature", "max_tokens"},
}


class Response:
    status_code = 200
    is_success = True

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body

    def raise_for_status(self):
        return None


class BoundaryClient:
    """Non-stream HTTP boundary used by OpenAI-compatible and Ollama adapters."""

    calls: list[dict] = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, url, **kwargs):
        self.calls.append({"url": str(url), **kwargs})
        if str(url).endswith("/api/chat"):
            return Response({
                "message": {"content": ANSWER}, "done": True,
                "done_reason": "stop", "prompt_eval_count": USAGE[0],
                "eval_count": USAGE[1], "total_count": USAGE[2],
            })
        return Response({
            "choices": [{"finish_reason": "stop", "message": {"content": ANSWER}}],
            "usage": {
                "prompt_tokens": USAGE[0], "completion_tokens": USAGE[1],
                "total_tokens": USAGE[2],
            },
        })


class StreamResponse(Response):
    def __init__(self, lines):
        super().__init__({})
        self._lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def iter_lines(self):
        yield from self._lines

    def close(self):
        return None


class OllamaStreamClient:
    _textphantom_streaming = True
    calls: list[dict] = []
    suffix = ""
    terminal = True

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def stream(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": str(url), **kwargs})
        lines = [f'{{"message":{{"content":"{ANSWER}"}},"done":false}}']
        if self.suffix:
            lines.append(f'{{"message":{{"content":"{self.suffix}"}},"done":false}}')
        if self.terminal:
            lines.append(
                '{"message":{"content":""},"done":true,"done_reason":"stop",'
                f'"prompt_eval_count":{USAGE[0]},"eval_count":{USAGE[1]},"total_count":{USAGE[2]}}}'
            )
        return StreamResponse(lines)


class OpenAIStreamClient:
    _textphantom_streaming = True
    calls: list[dict] = []
    terminal = True

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def stream(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": str(url), **kwargs})
        lines = [f'data: {{"choices":[{{"delta":{{"content":"{ANSWER}"}},"finish_reason":null}}]}}']
        if self.terminal:
            lines.extend([
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
                f'"usage":{{"prompt_tokens":{USAGE[0]},"completion_tokens":{USAGE[1]},"total_tokens":{USAGE[2]}}}}}',
                "data: [DONE]",
            ])
        return StreamResponse(lines)


def system_and_user(payload: dict, protocol: str) -> tuple[list[str], str]:
    if protocol == "gemini_generate_content":
        system = [part["text"] for part in payload["systemInstruction"]["parts"]]
        return system, payload["contents"][0]["parts"][0]["text"]
    if protocol == "anthropic_messages":
        blocks = payload["system"]
        system = [block["text"] for block in blocks] if isinstance(blocks, list) else [blocks]
        return system, payload["messages"][0]["content"]
    messages = payload["messages"]
    return [messages[0]["content"]], messages[1]["content"]


def assert_pipeline_terminal_failure(result, provider: str, base_url: str) -> None:
    try:
        decode_result(
            result=result, ids=["P0"], provider=provider, base_url=base_url,
            used_model=result.used_model, target_lang="th",
            ai=AiConfig(api_key="", provider=provider, base_url=base_url),
            context_frozen=False, selected_wire_contract="plain_records_v1",
            want_memo=False, image_b64="", thinking_selected="off",
            thinking_applied="unverified", system_text="system",
            user_parts=["<<TP_P0:source>>"], capture_request=False,
            is_retry=False,
        )
    except ModelOutputContractError as exc:
        assert exc.code == "AI_OUTPUT_CONTRACT_MISMATCH"
        assert exc.structural_details["validatorSubtype"] == "missing_provider_terminal"
    else:
        raise AssertionError(f"{provider} marker-complete EOF was accepted")


def main() -> None:
    sections = prompts.build_system_sections(
        "th", STYLE, prompt_mode="replace", structured_output=False,
    )
    request_ids = ("P0", "P1", "P2")
    sections = prompts.append_request_output_section(sections, request_ids)
    system_text = prompts.join_system_sections(sections)
    exact_request = prompts.exact_request_output_contract(request_ids)
    fragments = (
        STYLE,
        prompts.SYSTEM_BASE.strip(),
        OCR_OUTPUT_RULE,
        "Target language: Thai (ภาษาไทย).",
        "INPUT — tp.translation.compact-records/1",
        exact_request,
    )
    assert [section.name for section in sections] == ["final_system"]
    assert system_text.endswith(STYLE)
    assert system_text.index(exact_request) < system_text.index(STYLE)
    fixture = prompts.canonical_boundary_fixture(
        "th", STYLE, request_ids, SOURCE,
        prompt_mode="replace", structured_output=False,
    )
    assert fixture["system"] == system_text
    assert fixture["user"] == SOURCE
    assert fixture["compositionOrder"] == [
        "mandatory_system", "request_output_contract", "runtime_context", "selected_style",
    ]
    assert len(fixture["systemSha256"]) == len(fixture["userSha256"]) == 64
    registry = list(compose_providers(ProviderRegistry()))
    assert len(registry) == 19, [spec.provider_id for spec in registry]
    rows = []

    for spec in registry:
        request = GenerationRequest(
            provider=spec.provider_id,
            model=spec.default_model,
            api_key="matrix-key",
            base_url=spec.default_base_url,
            system_text=system_text,
            system_sections=sections,
            user_parts=(SOURCE,),
            thinking="off",
            expected_ids=request_ids,
            unit_count=len(request_ids),
        )
        captured: list[dict] = []

        def gemini_post(_key, _model, payload, _cancel=None):
            captured.append(payload)
            return Response({
                "candidates": [{"finishReason": "STOP", "content": {
                    "parts": [{"text": ANSWER}],
                }}],
                "usageMetadata": {
                    "promptTokenCount": USAGE[0], "candidatesTokenCount": USAGE[1],
                    "totalTokenCount": USAGE[2],
                },
            })

        def anthropic_post(_url, **kwargs):
            captured.append(kwargs["json"])
            return Response({
                "content": [{"type": "text", "text": ANSWER}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": USAGE[0], "output_tokens": USAGE[1],
                          "total_tokens": USAGE[2]},
            })

        BoundaryClient.calls = []
        with ExitStack() as stack:
            stack.enter_context(patch.object(openai_chat.httpx, "Client", BoundaryClient))
            if spec.protocol == "gemini_generate_content":
                stack.enter_context(patch.object(cloud_gemini, "_post_once", side_effect=gemini_post))
            elif spec.protocol == "anthropic_messages":
                stack.enter_context(patch.object(cloud_anthropic, "post_json", side_effect=anthropic_post))
            result = spec.adapter.generate(request)

        if spec.protocol not in {"gemini_generate_content", "anthropic_messages"}:
            captured.extend(call["json"] for call in BoundaryClient.calls)
        assert len(captured) == 1, f"{spec.provider_id}: expected one dispatch, got {len(captured)}"
        payload = captured[0]
        system_blocks, user_text = system_and_user(payload, spec.protocol)
        assert len(system_blocks) == 1, f"{spec.provider_id}: system must be one native content block"
        joined = "\n\n".join(system_blocks)
        assert joined == system_text, f"{spec.provider_id}: provider system bytes differ from canonical system"
        assert user_text == SOURCE, f"{spec.provider_id}: source was trimmed or transformed"
        for fragment in fragments:
            assert joined.count(fragment) == 1, f"{spec.provider_id}: section count != 1: {fragment[:30]}"
            assert fragment not in user_text, f"{spec.provider_id}: system instruction leaked into source"
        assert (result.input_tokens, result.output_tokens, result.total_tokens) == USAGE, (
            spec.provider_id, result
        )

        if spec.local and spec.provider_id != "ollama":
            assert "temperature" not in payload, f"{spec.provider_id}: guessed temperature sent"
            assert "think" not in payload, f"{spec.provider_id}: guessed thinking control sent"
            assert "max_tokens" in payload
        elif spec.provider_id == "ollama":
            assert "think" not in payload, "unknown Ollama capability must omit think"
            assert "num_predict" in payload["options"]
            assert "temperature" not in payload["options"]
        elif spec.protocol == "openai_chat_completions":
            optional = {key for key in ("temperature", "max_tokens", "max_completion_tokens", "reasoning") if key in payload}
            assert optional == CLOUD_FIELDS[spec.provider_id], (spec.provider_id, optional)
        elif spec.protocol == "gemini_generate_content":
            config = payload["generationConfig"]
            optional = {key for key in ("temperature", "maxOutputTokens", "responseMimeType", "thinkingConfig") if key in config}
            assert optional == CLOUD_FIELDS[spec.provider_id], (spec.provider_id, optional)
            assert config["responseMimeType"] == "text/plain"
            assert result.thinking_applied == "provider_default_levels", (
                "Gemini 3 uses levels; boolean Off must not fabricate a full-disable wire option"
            )
        elif spec.protocol == "anthropic_messages":
            optional = {key for key in ("temperature", "max_tokens", "thinking") if key in payload}
            assert optional == CLOUD_FIELDS[spec.provider_id], (spec.provider_id, optional)
        rows.append((spec.provider_id, spec.protocol, "PASS"))

    print("API provider actual-boundary matrix: 19/19 PASS")
    for provider, protocol, status in rows:
        print(f"  {provider:14} {protocol:28} {status}")
    print("Custom Local API: N/A (extension-only contract)")

    ollama = next(spec for spec in registry if spec.provider_id == "ollama")
    base_ollama_request = GenerationRequest(
        provider="ollama", model=ollama.default_model,
        base_url=ollama.default_base_url, system_text=system_text,
        system_sections=sections, user_parts=(SOURCE,), thinking="off",
        expected_ids=request_ids, unit_count=len(request_ids),
    )
    capability_cases = (
        ({"reasoning": {"supported": None, "control": "unknown"}}, "off", None),
        ({"reasoning": {"supported": False, "control": "none"}}, "off", None),
        ({"reasoning": {"supported": True, "control": "levels"}}, "on", None),
        ({"reasoning": {"supported": True, "control": "boolean"}}, "off", False),
        ({"reasoning": {"supported": True, "control": "toggle"}}, "on", True),
    )
    for capabilities, selected, expected in capability_cases:
        BoundaryClient.calls = []
        candidate = replace(base_ollama_request, thinking=selected,
                            model_capabilities=capabilities)
        with patch.object(openai_chat.httpx, "Client", BoundaryClient):
            ollama.adapter.generate(candidate)
        body = BoundaryClient.calls[0]["json"]
        if expected is None:
            assert "think" not in body, (capabilities, body)
        else:
            assert body.get("think") is expected, (capabilities, body)

    BoundaryClient.calls = []
    with patch("backend.ai.providers.local_ollama.httpx.Client", BoundaryClient):
        probe = ollama.adapter.probe(ProbeRequest(
            model=ollama.default_model, base_url=ollama.default_base_url,
        ))
    assert probe.ok
    assert "think" not in BoundaryClient.calls[0]["json"], (
        "unknown Ollama probe capability must omit think", BoundaryClient.calls[0]["json"])
    mandatory = {"reasoning": {"supported": True, "mandatory": True, "control": "levels"}}
    try:
        ollama.adapter.generate(replace(base_ollama_request, model_capabilities=mandatory))
    except RuntimeError as exc:
        assert "local_ai_thinking_required" in str(exc)
    else:
        raise AssertionError("mandatory-thinking Ollama model accepted Thinking Off")
    mandatory_probe = ollama.adapter.probe(ProbeRequest(
        model=ollama.default_model, base_url=ollama.default_base_url,
        model_capabilities=mandatory,
    ))
    assert not mandatory_probe.ok and mandatory_probe.status == "local_ai_thinking_required"
    print("Ollama thinking boundary: unknown/unsupported/levels omit; verified boolean off/on PASS")

    # Regression: marker completion is latency evidence, not permission to
    # freeze the body. A later suffix must reach decode but cannot invalidate
    # independently complete expected records.
    one_sections = prompts.append_request_output_section(
        prompts.build_system_sections(
            "th", STYLE, prompt_mode="replace", structured_output=False,
        ), ("P0",),
    )
    one_system_text = prompts.join_system_sections(one_sections)
    request = GenerationRequest(
        provider="ollama", model=ollama.default_model,
        base_url=ollama.default_base_url, system_text=one_system_text,
        system_sections=one_sections, user_parts=("<<TP_P0:  OCR source  >>",), thinking="off",
        expected_ids=("P0",), unit_count=1,
    )
    for suffix, should_fail in (("", False), (" trailing", False)):
        OllamaStreamClient.calls = []
        OllamaStreamClient.suffix = suffix
        OllamaStreamClient.terminal = True
        with patch.object(openai_chat.httpx, "Client", OllamaStreamClient):
            result = ollama.adapter.generate(request)
        assert len(OllamaStreamClient.calls) == 1
        assert (result.input_tokens, result.output_tokens, result.total_tokens) == USAGE
        assert result.finish_reason == "stop"
        if should_fail:
            assert result.text == ANSWER + suffix
            try:
                markers.decode_translation_response(
                    result.text, ["P0"], require_complete=True,
                    allow_complete_without_end=True,
                )
            except ModelOutputContractError as exc:
                assert exc.code == "AI_OUTPUT_CONTRACT_MISMATCH"
            else:
                raise AssertionError("Ollama suffix was not rejected by strict decode")
        else:
            assert result.text == ANSWER + suffix
            decoded = markers.decode_translation_response(
                result.text, ["P0"], require_complete=True,
                allow_complete_without_end=True,
            )
            assert not decoded.missing_ids
    print("Ollama terminal accumulation regression: clean+usage PASS; later suffix ignored PASS")

    # Complete records followed by bare EOF are not provider completion.
    OllamaStreamClient.calls = []
    OllamaStreamClient.suffix = ""
    OllamaStreamClient.terminal = False
    with patch.object(openai_chat.httpx, "Client", OllamaStreamClient):
        eof_result = ollama.adapter.generate(request)
    assert eof_result.text == ANSWER and eof_result.terminal_completed is False
    assert_pipeline_terminal_failure(
        eof_result, "ollama", ollama.default_base_url,
    )

    openai = next(spec for spec in registry if spec.provider_id == "openai")
    openai_request = GenerationRequest(
        provider="openai", model=openai.default_model, api_key="matrix-key",
        base_url=openai.default_base_url, system_text=one_system_text,
        system_sections=one_sections, user_parts=("<<TP_P0:  OCR source  >>",),
        thinking="off", expected_ids=("P0",), unit_count=1,
    )
    for terminal in (True, False):
        OpenAIStreamClient.calls = []
        OpenAIStreamClient.terminal = terminal
        with patch.object(openai_chat.httpx, "Client", OpenAIStreamClient):
            stream_result = openai.adapter.generate(openai_request)
        assert len(OpenAIStreamClient.calls) == 1
        assert stream_result.text == ANSWER
        assert stream_result.terminal_completed is terminal
        if terminal:
            assert (stream_result.input_tokens, stream_result.output_tokens,
                    stream_result.total_tokens) == USAGE
            assert stream_result.finish_reason == "stop"
            _require_authoritative_terminal(stream_result)
        else:
            assert_pipeline_terminal_failure(
                stream_result, "openai", openai.default_base_url,
            )
    print("API SSE authoritative-terminal regression: Ollama/OpenAI EOF typed-fail PASS")


if __name__ == "__main__":
    main()
