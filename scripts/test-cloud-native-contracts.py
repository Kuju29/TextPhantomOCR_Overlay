"""Mock four official Cloud boundaries without credentials or paid requests.

The fixtures exercise provider-specific metadata, vision/history serialization,
thinking control, and cache hints/usage independently of vendor availability.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai import content_stream, wire_trace
from backend.ai.clients.base import ChatResult
from backend.ai import resolve as resolve_service
from backend.ai.cloud_reasoning import (CloudReasoningPreferenceUnavailable,
                                       ensure_cloud_reasoning_preflight)
from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_contract import GenerationRequest, ProbeRequest, SystemPromptSection
from backend.ai.provider_resolution import (discovered_model_capabilities,
                                            effective_model_capabilities,
                                            remember_model_capabilities)
from backend.ai.providers import cloud_anthropic, cloud_deepseek, cloud_gemini, cloud_openai
from backend.ai.reasoning_preference import resolve_reasoning_preference
from backend.ai.transports import native_stream


catalogue = {
    "data": [
        {"id": "deepseek-flash", "input_modalities": ["text", "image"],
         "context_window": 1048576, "max_output_tokens": 393216,
         "effort": {"supported_levels": ["low", "high", "max"], "default_level": "high"}},
        {"id": "deepseek-v4-pro", "input_modalities": ["text"],
         "effort": {"supported_levels": ["low", "high", "max"], "default_level": "high"}},
        {"id": "future-model", "input_modalities": ["text", "image"]},
    ],
}
calls = []


class FakeClient:
    def __init__(self, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def get(self, url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(200, json=catalogue, request=httpx.Request("GET", url))


with patch.object(cloud_deepseek.httpx, "Client", FakeClient):
    listed = cloud_deepseek.ADAPTER.list_models(
        api_key="private-test-key", base_url=cloud_deepseek.DEFAULT_BASE_URL)
assert len(calls) == 1 and calls[0][0].endswith("/models")
assert listed.models == ("deepseek-flash", "deepseek-v4-pro", "future-model")
assert cloud_deepseek.DEFAULT_MODEL == "deepseek-v4-flash"
assert cloud_deepseek.resolve_model("deepseek-v4-flash") == "deepseek-v4-flash"
assert cloud_deepseek.resolve_model("another-custom-model") == "another-custom-model"
ensure_provider_registry()
with patch.object(cloud_deepseek.httpx, "Client", FakeClient):
    retired_default = resolve_service.resolve({
        "provider": "deepseek", "api_key": "private-test-key",
        "model": cloud_deepseek.DEFAULT_MODEL, "lang": "th",
    })
    selected_current = resolve_service.resolve({
        "provider": "deepseek", "api_key": "private-test-key",
        "model": "deepseek-flash", "lang": "th",
    })
assert retired_default["ok"] is False and retired_default["error"] == "model_unavailable"
assert retired_default["model"] == cloud_deepseek.DEFAULT_MODEL
assert retired_default["model_remapped"] is False
assert selected_current["ok"] is True and selected_current["model"] == "deepseek-flash"
flash = listed.capabilities["deepseek-flash"]
assert flash["reasoning"]["supported_efforts"] == ["none", "low", "high", "max"]
assert flash["reasoning"]["default_effort"] == "high"
assert flash["vision"]["supported"] is True
assert flash["limits"]["maxOutputTokens"] == 393216
assert flash["limits"]["contextTokens"] == 1048576
assert listed.capabilities["deepseek-v4-pro"]["vision"]["supported"] is False
assert "reasoning" not in listed.capabilities["future-model"], "no name-only guessing"
selection = resolve_reasoning_preference("minimum", flash["reasoning"])
assert selection == "off"
ensure_cloud_reasoning_preflight("deepseek", "deepseek-flash", "minimum", selection,
                                 flash["reasoning"], capability_verified=True)
ensure_cloud_reasoning_preflight("deepseek", "deepseek-flash", "off", "off",
                                 flash["reasoning"], capability_verified=True)
try:
    ensure_cloud_reasoning_preflight("deepseek", "deepseek-v4-flash", "off", "off",
                                     {}, capability_verified=False)
except CloudReasoningPreferenceUnavailable as error:
    assert error.requestDispatched is False
else:
    raise AssertionError("a legacy model omitted by /models must not be credited with fresh evidence")

probe_payloads = []


def fake_probe(request, **kwargs):
    probe_payloads.append(kwargs.get("payload_extra"))
    from backend.ai.provider_contract import ProbeResponse
    return ProbeResponse(True, 200)


with patch.object(cloud_deepseek, "openai_chat_probe", side_effect=fake_probe):
    cloud_deepseek.ADAPTER.probe(ProbeRequest(
        model="deepseek-flash", api_key="test", base_url=cloud_deepseek.DEFAULT_BASE_URL,
        model_capabilities=flash))
assert probe_payloads == [{"max_tokens": 128, "thinking": {"type": "disabled"}}]

history = ({"role": "user", "text": "<<I1_P0:旧文>>"},
           {"role": "assistant", "text": "<<I1_P0:คำเก่า>>"})


def request(provider, model, cap, thinking="off", image=""):
    return GenerationRequest(
        provider=provider, model=model, base_url="https://example.invalid/v1",
        api_key="fake", system_text="SYSTEM_FIXED", user_parts=("<<I2_P0:新文>>",),
        expected_ids=("I2_P0",), unit_count=1, image_b64=image,
        image_mime="image/png", history_messages=history, model_capabilities=cap,
        thinking=thinking)


payloads = []
observed_thinking = [0]


def fake_generation(**kwargs):
    payloads.append(kwargs["payload"])
    return ChatResult("<<I2_P0:ใหม่>>", kwargs["model"],
                      thinking_tokens=observed_thinking[0])


with patch.object(cloud_deepseek, "execute_deepseek_chat", side_effect=fake_generation):
    off = cloud_deepseek.ADAPTER.generate(request("deepseek", "deepseek-flash", flash, image="ZGF0YQ=="))
    low = cloud_deepseek.ADAPTER.generate(request("deepseek", "deepseek-flash", flash, "low"))
    unknown = cloud_deepseek.ADAPTER.generate(request("deepseek", "future-model", {}, "default"))
assert off.thinking_applied == "requested_off_observed_zero_reasoning"
assert payloads[0]["thinking"] == {"type": "disabled"}
assert "reasoning_effort" not in payloads[0] and "temperature" not in payloads[0]
assert payloads[1]["thinking"] == {"type": "enabled"} and payloads[1]["reasoning_effort"] == "low"
assert payloads[0]["max_tokens"] < payloads[1]["max_tokens"], "Off needs no hidden thinking reserve"
assert "thinking" not in payloads[2], "future model without evidence uses provider default"
assert [m["role"] for m in payloads[0]["messages"]] == ["system", "user", "assistant", "user"]
assert payloads[0]["messages"][-1]["content"][-1]["image_url"]["url"] == "data:image/png;base64,ZGF0YQ=="
assert "store" not in payloads[0] and "previous_response_id" not in payloads[0]
with patch.object(cloud_deepseek, "execute_deepseek_chat", side_effect=fake_generation):
    observed_thinking[0] = 17
    off_ignored = cloud_deepseek.ADAPTER.generate(request("deepseek", "deepseek-flash", flash))
    observed_thinking[0] = None
    off_unverified = cloud_deepseek.ADAPTER.generate(request("deepseek", "deepseek-flash", flash))
assert off_ignored.thinking_applied == "provider_ignored_off"
assert off_unverified.thinking_applied == "requested_off_unverified_effect"

# Gemini 2.5 Pro and Lite use different documented numeric minimum budgets.
assert cloud_gemini._thinking_state("gemini-2.5-pro", "low")[1] == {"thinkingBudget": 128}
assert cloud_gemini._thinking_state("gemini-2.5-flash-lite", "low")[1] == {"thinkingBudget": 512}
assert cloud_gemini._thinking_state("gemini-2.5-flash", "off")[1] == {"thinkingBudget": 0}
assert cloud_gemini._thinking_state("gemini-3.6-flash", "minimal")[1] == {"thinkingLevel": "minimal"}
assert cloud_gemini._thinking_state("gemini-3.6-flash", "off")[1] is None
for undocumented in ("gemini-2.5-flash-future", "gemini-2.5-flash-lite-future",
                     "gemini-3.1-pro-future"):
    assert cloud_gemini._reasoning_capability(undocumented) == {}
    assert cloud_gemini._thinking_state(undocumented, "off")[1] is None
    with patch.object(cloud_gemini, "_post_once") as uninvoked:
        try:
            ensure_cloud_reasoning_preflight("gemini", undocumented, "off", "off", {},
                                             capability_verified=False)
        except CloudReasoningPreferenceUnavailable as error:
            assert error.requestDispatched is False
        else:
            raise AssertionError(f"undocumented {undocumented} must reject Off before wire")
        uninvoked.assert_not_called()

gemini_catalogue = ["gemini-2.5-flash", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-future-image"]


class GeminiModelsClient(FakeClient):
    def get(self, url, **kwargs):
        return httpx.Response(200, json={"models": [
            {"name": f"models/{name}", "supportedGenerationMethods": ["generateContent"]}
            for name in gemini_catalogue
        ]}, request=httpx.Request("GET", url))


with patch.object(cloud_gemini.httpx, "Client", GeminiModelsClient):
    gemini_listed = cloud_gemini.models_status("AIza-fixture")
assert gemini_listed["capabilities"]["gemini-2.5-flash"]["vision"]["supported"] is True
assert gemini_listed["capabilities"]["gemini-3.6-flash"]["vision"]["supported"] is True
assert gemini_listed["capabilities"]["gemini-3.8-flash"]["vision"]["supported"] is True
assert "vision" not in gemini_listed["capabilities"].get("gemini-future-image", {})
assert "gemini-2.5-pro" not in gemini_listed["capabilities"], "not account-listed"
remember_model_capabilities("gemini", "", "AIza-fixture", gemini_listed["capabilities"],
                            models=gemini_listed["models"])
for selected, expected_support in (("gemini-2.5-flash", True),
                                   ("gemini-future-image", False)):
    fresh, server = discovered_model_capabilities("gemini", "", selected, "AIza-fixture")
    assert fresh
    image_cap = effective_model_capabilities(discovery_fresh=fresh, server=server,
        client={"vision": {"supported": True}}).get("vision", {})
    assert (image_cap.get("supported") is True) == expected_support, "same gate as invocation"

gemini_payloads = []


def gemini_response(thoughts, thought_part=False):
    parts = ([{"thought": True, "text": "internal work"}] if thought_part else []) + [
        {"text": "<<I2_P0:ใหม่>>"}]
    usage = {"promptTokenCount": 12, "candidatesTokenCount": 5}
    if thoughts is not None:
        usage["thoughtsTokenCount"] = thoughts
    return httpx.Response(200, json={"candidates": [{"finishReason": "STOP",
        "content": {"parts": parts}}], "usageMetadata": usage},
        request=httpx.Request("POST", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"))


for reported, thought_part, expected in (
    (0, False, "requested_off_observed_zero_reasoning"),
    (17, False, "provider_ignored_off"),
    (None, False, "requested_off_unverified_effect"),
    (None, True, "provider_ignored_off"),
):
    with patch.object(cloud_gemini, "_post_once", side_effect=lambda _k, _m, p, _c: (
        gemini_payloads.append(p) or gemini_response(reported, thought_part))), \
         patch.object(cloud_gemini.content_stream, "active", return_value=False):
        gemini_result = cloud_gemini.generate(
            "AIza-fixture", "gemini-2.5-flash", "SYSTEM_FIXED", ["<<I2_P0:新文>>"],
            image_b64="ZGF0YQ==", image_mime="image/png",
            history_messages=history, thinking="off")
    assert gemini_result.thinking_applied == expected
    assert gemini_payloads[-1]["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}
    assert [item["role"] for item in gemini_payloads[-1]["contents"]] == ["user", "model", "user"]
    assert gemini_payloads[-1]["contents"][-1]["parts"][0]["inline_data"]["mime_type"] == "image/png"

# OpenAI Chat Completions accepts roles/history and image data URLs, but its
# response identifier does not provide a continuation contract on this API.
openai_payload = cloud_openai.prepare_payload(request("openai", "gpt-5.6-luna", {
    "reasoning": {"supported": True, "control": "levels", "supported_efforts": ["none", "low"]},
}, image="ZGF0YQ=="))
assert openai_payload["reasoning_effort"] == "none"
assert [m["role"] for m in openai_payload["messages"]] == ["system", "user", "assistant", "user"]
assert openai_payload["messages"][-1]["content"][0]["image_url"]["url"] == "data:image/png;base64,ZGF0YQ=="
assert "store" not in openai_payload and "previous_response_id" not in openai_payload

openai_models = ["gpt-5.6-luna", "gpt-4o", "o3-mini", "gpt-future-vision", "ft:gpt-4o:custom"]
with patch.object(cloud_openai.httpx, "get", return_value=httpx.Response(
    200, json={"data": [{"id": name} for name in openai_models]},
    request=httpx.Request("GET", "https://api.openai.com/v1/models"))):
    openai_listed = cloud_openai.ADAPTER.list_models(
        api_key="private-test-key", base_url=cloud_openai.DEFAULT_BASE_URL)
assert openai_listed.capabilities["gpt-5.6-luna"]["vision"]["supported"] is True
assert openai_listed.capabilities["gpt-4o"]["vision"]["supported"] is True
assert "vision" not in openai_listed.capabilities.get("o3-mini", {})
assert "vision" not in openai_listed.capabilities.get("gpt-future-vision", {})
assert "vision" not in openai_listed.capabilities.get("ft:gpt-4o:custom", {})

for reported, reasoning_seen, expected in ((0, False, "requested_off_observed_zero_reasoning"),
                                           (17, False, "provider_ignored_off"),
                                           (None, False, "requested_off_unverified_effect"),
                                           (None, True, "provider_ignored_off")):
    with patch.object(cloud_openai, "execute_openai_cloud_chat", return_value=ChatResult(
        "<<I2_P0:ใหม่>>", "gpt-5.6-luna", thinking_tokens=reported,
        reasoning_observed=reasoning_seen)):
        openai_result = cloud_openai.ADAPTER.generate(request(
            "openai", "gpt-5.6-luna", {"reasoning": {"supported": True,
                "control": "levels", "supported_efforts": ["none", "low"]}}))
    assert openai_result.thinking_applied == expected

# Anthropic's existing native automatic cache marks the growing messages but
# still carries them. A cache hint alone is not evidence that a read hit.
sections = (SystemPromptSection("identity", "SYSTEM_FIXED", cacheable=True),)
anthropic_payloads = []


def anthropic_post(*args, **kwargs):
    anthropic_payloads.append(kwargs["json"])
    return httpx.Response(200, json={
        "id": "msg-fixture", "stop_reason": "end_turn",
        "content": [{"type": "text", "text": "<<I2_P0:ใหม่>>"}],
        "usage": {"input_tokens": 13, "output_tokens": 5,
                  "cache_read_input_tokens": 11, "cache_creation_input_tokens": 2},
    }, request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))


with patch.object(cloud_anthropic, "post_json", side_effect=anthropic_post), \
     patch.object(cloud_anthropic.content_stream, "active", return_value=False):
    anth_result = cloud_anthropic.generate(
        "fixture", "claude-sonnet-4-6", "SYSTEM_FIXED", ["<<I2_P0:新文>>"],
        system_sections=sections, image_b64="ZGF0YQ==", image_mime="image/png",
        history_messages=history, conversation_mode=True, thinking="off")
assert [m["role"] for m in anthropic_payloads[0]["messages"]] == ["user", "assistant", "user"]
assert anthropic_payloads[0]["messages"][-1]["content"][0]["source"]["media_type"] == "image/png"
assert anthropic_payloads[0]["cache_control"] == {"type": "ephemeral"}
assert anthropic_payloads[0]["system"][0]["cache_control"] == {"type": "ephemeral"}
assert anthropic_payloads[0]["thinking"] == {"type": "disabled"}
assert anth_result.cached_input_tokens == 11


class AnthropicModelsClient(FakeClient):
    def get(self, url, **kwargs):
        return httpx.Response(200, json={"data": [
            {"id": name} for name in ("claude-sonnet-5", "claude-opus-5-5",
                                   "claude-haiku-4-5-20251001", "claude-future-vision",
                                   "claude-opus-5-6")
        ]}, request=httpx.Request("GET", url))


with patch.object(cloud_anthropic.httpx, "Client", AnthropicModelsClient):
    anth_listed = cloud_anthropic.models_status("sk-ant-fixture")
assert anth_listed["capabilities"]["claude-sonnet-5"]["vision"]["supported"] is True
assert anth_listed["capabilities"]["claude-haiku-4-5-20251001"]["vision"]["supported"] is True
assert "vision" not in anth_listed["capabilities"].get("claude-future-vision", {})
assert "vision" not in anth_listed["capabilities"].get("claude-opus-5-6", {}), "future variant"
assert anth_listed["capabilities"]["claude-opus-5-5"]["reasoning"]["mandatory"] is True
assert "none" not in anth_listed["capabilities"]["claude-opus-5-5"]["reasoning"]["supported_efforts"]
assert cloud_anthropic._reasoning_capability("claude-opus-5-5-20260922")["mandatory"] is True
for future in ("claude-opus-5-6", "claude-sonnet-5-1"):
    assert cloud_anthropic._reasoning_capability(future) == {}, future
    with patch.object(cloud_anthropic, "post_json") as uninvoked:
        try:
            ensure_cloud_reasoning_preflight("anthropic", future, "off", "off", {},
                                             capability_verified=False)
        except CloudReasoningPreferenceUnavailable as error:
            assert error.requestDispatched is False
        else:
            raise AssertionError(f"unknown future Anthropic {future} must reject Off before wire")
        uninvoked.assert_not_called()
assert anth_result.thinking_applied == "requested_off_unverified_effect"


def anth_thoughts(*args, **kwargs):
    body = anthropic_post(*args, **kwargs).json()
    body["content"].insert(0, {"type": "thinking", "thinking": "reasoned despite Off"})
    return httpx.Response(200, json=body, request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))


with patch.object(cloud_anthropic, "post_json", side_effect=anth_thoughts), \
     patch.object(cloud_anthropic.content_stream, "active", return_value=False):
    anth_ignored = cloud_anthropic.generate(
        "fixture", "claude-sonnet-4-6", "SYSTEM_FIXED", ["<<I2_P0:新文>>"],
        thinking="off")
assert anth_ignored.thinking_applied == "provider_ignored_off"


class FakeNativeResponse:
    status_code = 200
    is_success = True

    def __init__(self, url, frames):
        self.request = httpx.Request("POST", url)
        self.frames = frames

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def iter_lines(self):
        for frame in self.frames:
            yield "data: " + json.dumps(frame, ensure_ascii=False)
            yield ""


class FakeNativeClient:
    frames = ()

    def __init__(self, **_kwargs):
        pass

    def stream(self, method, url, **_kwargs):
        assert method == "POST"
        return FakeNativeResponse(url, self.frames)

    def close(self):
        pass


gemini_private = "PRIVATE_GEMINI_THOUGHT_DO_NOT_STORE"
anthropic_private = "PRIVATE_ANTHROPIC_THOUGHT_DO_NOT_STORE"
visible_translation = "<<I2_P0:คำแปล>>"
gemini_native_body = {
    "candidates": [{"finishReason": "STOP", "content": {"parts": [
        {"thought": True, "text": gemini_private}, {"text": visible_translation},
    ]}}],
    "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 4, "thoughtsTokenCount": 3},
}
gemini_private_parts = (gemini_private[:len(gemini_private) // 2],
                        gemini_private[len(gemini_private) // 2:])
gemini_frames = (
    {"candidates": [{"content": {"parts": [
        {"thought": True, "text": gemini_private_parts[0]},
    ]}}]},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": [
        {"thought": True, "text": gemini_private_parts[1]},
        {"text": visible_translation},
    ]}}], "usageMetadata": gemini_native_body["usageMetadata"]},
)
anthropic_native_body = {
    "id": "msg_fixture", "type": "message", "model": "claude-sonnet-4-6",
    "content": [{"type": "thinking", "thinking": anthropic_private},
                {"type": "text", "text": visible_translation}],
    "stop_reason": "end_turn", "usage": {"input_tokens": 12, "output_tokens": 4},
}
anthropic_private_parts = (anthropic_private[:len(anthropic_private) // 2],
                           anthropic_private[len(anthropic_private) // 2:])
anthropic_frames = (
    {"type": "message_start", "message": {
        "id": "msg_fixture", "type": "message", "model": "claude-sonnet-4-6",
        "content": [], "usage": {"input_tokens": 12},
    }},
    {"type": "content_block_start", "index": 0,
     "content_block": {"type": "thinking", "thinking": ""}},
    {"type": "content_block_delta", "index": 0,
     "delta": {"type": "thinking_delta", "thinking": anthropic_private_parts[0]}},
    {"type": "content_block_delta", "index": 0,
     "delta": {"type": "thinking_delta", "thinking": anthropic_private_parts[1]}},
    {"type": "content_block_start", "index": 1,
     "content_block": {"type": "text", "text": ""}},
    {"type": "content_block_delta", "index": 1,
     "delta": {"type": "text_delta", "text": visible_translation}},
    {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
     "usage": {"output_tokens": 4}},
    {"type": "message_stop"},
)


def generate_with_private_thought(provider):
    if provider == "gemini":
        return cloud_gemini.generate(
            "AIza-fixture", "gemini-2.5-flash", "SYSTEM_FIXED",
            ["<<I2_P0:原文>>"], thinking="off",
        )
    return cloud_anthropic.generate(
        "sk-ant-fixture", "claude-sonnet-4-6", "SYSTEM_FIXED",
        ["<<I2_P0:原文>>"], thinking="off",
    )


# Native JSON and SSE may contain provider-private thought parts. Preserve
# decoded visible text and usage, but never persist raw reasoning in wire trace.
for provider, private, body, frames in (
    ("gemini", gemini_private, gemini_native_body, gemini_frames),
    ("anthropic", anthropic_private, anthropic_native_body, anthropic_frames),
):
    for streamed in (False, True):
        with tempfile.TemporaryDirectory(prefix=f"tp-{provider}-private-trace-") as temp, \
             patch.dict(os.environ, TP_AI_WIRE_TRACE="1", TP_AI_WIRE_TRACE_DIR=temp):
            token = wire_trace.begin({"traceId": f"private-{provider}",
                                      "operationId": "native-stream" if streamed else "native-json"})
            folder = wire_trace.active_folder()
            visible_deltas = []
            try:
                if streamed:
                    FakeNativeClient.frames = frames
                    with patch.object(native_stream.httpx, "Client", FakeNativeClient), \
                         content_stream.scope(visible_deltas.append):
                        result = generate_with_private_thought(provider)
                else:
                    response = httpx.Response(200, json=body,
                        request=httpx.Request("POST", "https://provider.invalid/native"))
                    if provider == "gemini":
                        with patch.object(cloud_gemini, "_post_once", return_value=response):
                            result = generate_with_private_thought(provider)
                    else:
                        with patch.object(cloud_anthropic, "post_json", return_value=response):
                            result = generate_with_private_thought(provider)
            finally:
                wire_trace.end(token)
            assert result.text == visible_translation
            assert result.thinking_applied == "provider_ignored_off"
            if streamed:
                assert "".join(visible_deltas) == visible_translation
            assert folder is not None
            assert (folder / "05_provider_response.assembled.txt").read_text("utf-8") == visible_translation
            raw = (folder / "05_provider_response.raw").read_text("utf-8")
            assert private not in raw and "omitted" in raw
            stream_file = folder / "response-stream.sse"
            private_parts = (private, private[:len(private) // 2], private[len(private) // 2:])
            assert not stream_file.exists() or all(
                part not in stream_file.read_text("utf-8") for part in private_parts)
            assert all(part not in file.read_text("utf-8")
                       for file in folder.iterdir() if file.is_file()
                       for part in private_parts), (provider, streamed)

print("PASS 4 Cloud native providers: metadata, Thinking, images, history, cache usage, and private native trace")
