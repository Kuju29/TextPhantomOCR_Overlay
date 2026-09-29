"""In-process HTTP wire rehearsal for all 18 registered API providers.

Run: PYTHONPATH=/workspace/scratch/a3c278984acd/pydeps:api python scripts/test-provider-wire-audit-api.py

httpx.MockTransport receives real adapter HTTP requests and returns synthetic
provider responses. No key, account, model, runtime, DNS, or paid AI call is used.
This proves our serialization, dispatch, parsing, and rejection contracts; it
cannot prove a real vendor honors a cache or thinking request.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
os.environ["TP_AI_WIRE_TRACE"] = "0"
os.environ["TP_USAGE_RECEIPTS"] = "off"

import httpx

from backend.ai.provider_contract import GenerationRequest, ProbeRequest
from backend.ai.provider_registry import ProviderRegistry
from backend.ai.providers import compose_providers
from backend.ai.reasoning_preference import resolve_reasoning_preference
from backend.ai.workload import WorkloadBudgetError


SYSTEM = "WIRE_AUDIT_SYSTEM_UNIQUE"
FIRST_SOURCE = "<<I1_P0:OLD_SOURCE_UNIQUE>>"
FIRST_ANSWER = "<<I1_P0:แปลเก่า>>"
SECOND_SOURCE = "<<I2_P0:NEW_SOURCE_UNIQUE>>"
SECOND_ANSWER = "<<I2_P0:แปลใหม่>>"
IMAGE_DATA = "aGVsbG8="
ORIGINAL_CLIENT = httpx.Client


def check(ok: bool, detail: str) -> None:
    if not ok:
        raise AssertionError(detail)


class SyntheticUpstream:
    """Fail closed: any route we did not intentionally model raises immediately."""

    def __init__(self, provider: str, model: str):
        self.provider = provider
        self.model = model
        self.requests: list[dict] = []
        self.reasoning_frame = False
        self.kobold_context = 32768

    def client(self, *args, **kwargs):
        check("transport" not in kwargs, "a provider supplied an unexpected transport")
        return ORIGINAL_CLIENT(*args, **kwargs, transport=httpx.MockTransport(self.handle),
                               trust_env=False)

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET":
            self.requests.append({"method": "GET", "url": str(request.url)})
            if path.endswith("/models"):
                return httpx.Response(200, json={"data": [{"id": self.model,
                    "type": "chat", "context_length": 32768, "context_window": 32768,
                    "max_model_len": 32768, "max_output_tokens": 512,
                    "max_completion_tokens": 512, "meta": {"n_ctx": 32768},
                    "per_request_limits": {"completion_tokens": 512, "prompt_tokens": 16000}}]})
            if path.endswith("/models/user"):
                return httpx.Response(200, json={"data": [{"id": self.model,
                    "type": "chat", "context_length": 32768,
                    "architecture": {"input_modalities": ["text", "image"],
                                     "output_modalities": ["text"]},
                    "per_request_limits": {"completion_tokens": 512,
                                           "prompt_tokens": 16000}}]})
            if path.endswith("/props"):
                return httpx.Response(200, json={"default_generation_settings": {"n_ctx": 32768}})
            if path.endswith("/api/tags"):
                return httpx.Response(200, json={"models": [{"name": self.model}]})
            if path.endswith("/api/ps"):
                return httpx.Response(200, json={"models": [{"name": self.model,
                    "context_length": 4096}]})
            if path.endswith("/api/extra/true_max_context_length"):
                check(self.provider == "koboldcpp", "unexpected KoboldCpp metadata read")
                return httpx.Response(200, json={"value": self.kobold_context})
            raise AssertionError(f"{self.provider}: unexpected GET endpoint {path}")
        check(request.method == "POST", f"{self.provider}: unexpected method {request.method}")
        payload = json.loads(request.content)
        self.requests.append({"method": "POST", "url": str(request.url), "body": payload,
                              "headers": dict(request.headers)})
        if path.endswith("/api/show"):
            check(payload == {"model": self.model}, "Ollama must inspect exact selected model")
            return httpx.Response(200, json={"capabilities": ["completion", "vision"],
                "model_info": {"general.architecture": "llama",
                               "llama.context_length": 32768},
                "parameters": "num_ctx 4096"})
        current = FIRST_SOURCE if len([item for item in self.requests if item["method"] == "POST"]) == 1 else SECOND_SOURCE
        answer = FIRST_ANSWER if current == FIRST_SOURCE else SECOND_ANSWER
        cached = 0 if answer == FIRST_ANSWER else 11

        if path.endswith("/api/v1/chat"):
            check(self.provider == "lmstudio", "another provider reached LM Studio native")
            # Native stateful chat returns a private continuation ID; its next
            # request must use that ID instead of copying any previous text.
            def event(item):
                return "data: " + json.dumps(item, ensure_ascii=False) + "\n\n"
            body = "".join((event({"type": "chat.start", "model_instance_id": self.model}),
                event({"type": "message.delta", "content": answer}),
                event({"type": "chat.end", "result": {
                    "model_instance_id": self.model,
                    "response_id": "resp_fixture1" if cached == 0 else "resp_fixture2",
                    "output": [{"type": "message", "content": answer}],
                    "stats": {"input_tokens": 120, "total_output_tokens": 7,
                              "reasoning_output_tokens": 0}}})))
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=body)
        if path.endswith("/api/chat"):
            check(self.provider == "ollama", "another provider reached Ollama native")
            frames = []
            if self.reasoning_frame:
                frames.append({"message": {"thinking": "synthetic hidden thought"}, "done": False})
            frames += [{"message": {"content": answer}, "done": False},
                {"message": {"content": ""}, "done": True, "done_reason": "stop",
                 "prompt_eval_count": 120, "eval_count": 7, "total_count": 127,
                 "prompt_eval_cached_count": cached}]
            return httpx.Response(200, headers={"content-type": "application/x-ndjson"},
                                  text="\n".join(json.dumps(x, ensure_ascii=False) for x in frames) + "\n")
        if path.endswith(":generateContent"):
            check(self.provider == "gemini", "another provider reached Gemini native")
            return httpx.Response(200, json={"candidates": [{"finishReason": "STOP",
                "content": {"parts": [{"text": answer}]}}], "usageMetadata": {
                "promptTokenCount": 120, "candidatesTokenCount": 7,
                "totalTokenCount": 127, "cachedContentTokenCount": cached}})
        if path.endswith("/messages"):
            check(self.provider == "anthropic", "another provider reached Anthropic native")
            return httpx.Response(200, json={"content": [{"type": "text", "text": answer}],
                "stop_reason": "end_turn", "usage": {"input_tokens": 120-cached,
                    "cache_read_input_tokens": cached, "cache_creation_input_tokens": 0,
                    "output_tokens": 7}})
        if path.endswith("/chat/completions"):
            event = lambda item: "data: " + json.dumps(item, ensure_ascii=False) + "\n\n"
            frames = [event({"choices": [{"delta": {"content": answer}, "finish_reason": None}]}),
                event({"choices": [{"delta": {}, "finish_reason": "stop"}],
                       "usage": {"prompt_tokens": 120, "completion_tokens": 7,
                           "total_tokens": 127,
                           "prompt_tokens_details": {"cached_tokens": cached}}}),
                "data: [DONE]\n\n"]
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  text="".join(frames))
        raise AssertionError(f"{self.provider}: unexpected POST endpoint {path}")


def user_text(message: dict, provider: str) -> str:
    content = message.get("content", message.get("parts", message.get("input")))
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(item.get("text", item.get("content", ""))) for item in content
                        if isinstance(item, dict))
    raise AssertionError(f"{provider}: no user text in {message}")


def assert_wire(spec, first: dict, second: dict, r1, r2) -> None:
    name = spec.provider_id
    check((r1.text, r2.text) == (FIRST_ANSWER, SECOND_ANSWER), f"{name}: parsed text")
    check(all(r.terminal_completed is True for r in (r1, r2)), f"{name}: terminal")
    check(all((r.input_tokens, r.output_tokens, r.total_tokens) == (120, 7, 127)
              for r in (r1, r2)), f"{name}: provider usage")
    check(r2.cached_input_tokens == 11, f"{name}: simulated provider cache report") if name != "lmstudio" else \
        check(r2.cached_input_tokens is None, "LM Studio did not report a cache count")
    check("store" not in second or name == "lmstudio", f"{name}: unverified state persistence")
    check("previous_response_id" not in second or name == "lmstudio", f"{name}: invalid cursor")

    if name == "lmstudio":
        check(first["store"] is True and second["store"] is True, "LM native state requested")
        check(first["system_prompt"] == SYSTEM and "system_prompt" not in second,
              "LM native system must only be on the opening request")
        check(second.get("previous_response_id") == r1.provider_response_id == "resp_fixture1",
              "LM native continuation must carry real first response ID")
        check(SECOND_SOURCE in user_text(second, name) and FIRST_SOURCE not in str(second),
              "LM native continuation sends only new user source")
        check(second["input"][0]["data_url"] == "data:image/png;base64," + IMAGE_DATA,
              "LM native image payload")
        return
    if name == "gemini":
        check(first["systemInstruction"]["parts"][0]["text"] == SYSTEM and
              second["systemInstruction"]["parts"][0]["text"] == SYSTEM,
              "Gemini system prefix must remain in stateless requests")
        messages1, messages2 = first["contents"], second["contents"]
        image = messages2[-1]["parts"][0]["inline_data"]
        check(image == {"mime_type": "image/png", "data": IMAGE_DATA}, "Gemini inline image")
        check([x["role"] for x in messages2] == ["user", "model", "user"], "Gemini native roles")
    elif name == "anthropic":
        blocks1, blocks2 = first["system"], second["system"]
        flatten = lambda val: " ".join(x["text"] for x in val) if isinstance(val, list) else val
        check(flatten(blocks1) == flatten(blocks2) == SYSTEM, "Anthropic system")
        messages1, messages2 = first["messages"], second["messages"]
        check([x["role"] for x in messages2] == ["user", "assistant", "user"], "Anthropic native roles")
        check(messages2[-1]["content"][0]["source"]["data"] == IMAGE_DATA,
              "Anthropic native image")
    else:
        messages1, messages2 = first["messages"], second["messages"]
        check(messages1[0] == messages2[0] == {"role": "system", "content": SYSTEM},
              f"{name}: system prefix preserved")
        check([x["role"] for x in messages2] == ["system", "user", "assistant", "user"],
              f"{name}: OpenAI-compatible history roles")
        image_content = messages2[-1]["content"]
        if name == "ollama":
            check(messages2[-1]["images"] == [IMAGE_DATA], "Ollama native image")
        else:
            check(any(part.get("image_url", {}).get("url") == "data:image/png;base64," + IMAGE_DATA
                      for part in image_content),
                  f"{name}: OpenAI-compatible image")
    check(FIRST_SOURCE in user_text(messages1[-1], name), f"{name}: opening source")
    check(FIRST_SOURCE in user_text(messages2[-3], name), f"{name}: old source replay")
    check(FIRST_ANSWER in user_text(messages2[-2], name), f"{name}: old answer replay")
    check(SECOND_SOURCE in user_text(messages2[-1], name), f"{name}: only new text in current user")
    check(FIRST_SOURCE not in user_text(messages2[-1], name), f"{name}: repeated old text in current user")
    check(SECOND_SOURCE not in user_text(messages2[-3], name), f"{name}: new text in history")
    check(first != second and len(messages2) == len(messages1) + 2,
          f"{name}: Conversation replay adds exactly two history entries")


def main() -> None:
    specs = list(compose_providers(ProviderRegistry()))
    check(len(specs) == 18, f"expected 18 API providers, found {[s.provider_id for s in specs]}")
    for spec in specs:
        upstream = SyntheticUpstream(spec.provider_id, spec.default_model)
        cache = {"translationMode": "conversation", "thinkingRequested": "default"}
        base = GenerationRequest(provider=spec.provider_id, model=spec.default_model,
            api_key="IN_MEMORY_TEST_ONLY", base_url=spec.default_base_url,
            system_text=SYSTEM, user_parts=(FIRST_SOURCE,), expected_ids=("I1_P0",),
            unit_count=1, thinking="default", cache_context=cache)
        with patch.object(httpx, "Client", side_effect=upstream.client):
            r1 = spec.adapter.generate(base)
            r2 = spec.adapter.generate(replace(base, user_parts=(SECOND_SOURCE,),
                expected_ids=("I2_P0",), image_b64=IMAGE_DATA, image_mime="image/png",
                history_messages=() if spec.provider_id == "lmstudio" else (
                    {"role": "user", "text": FIRST_SOURCE},
                    {"role": "assistant", "text": FIRST_ANSWER}),
                previous_response_id=r1.provider_response_id or ""))
        posts = [entry for entry in upstream.requests if entry["method"] == "POST"]
        check(len(posts) == 2, f"{spec.provider_id}: expected two actual HTTP dispatches: {upstream.requests}")
        assert_wire(spec, posts[0]["body"], posts[1]["body"], r1, r2)
        check(all((v := p["body"].get("max_tokens", p["body"].get("max_completion_tokens",
              p["body"].get("max_output_tokens", p["body"].get("generationConfig", {}).get(
              "maxOutputTokens", p["body"].get("options", {}).get("num_predict"))))))
              and type(v) is int and 0 < v < 8192 for p in posts),
              f"{spec.provider_id}: output ceiling must be a positive workload allocation")
        print(f"PASS simulated HTTP {spec.provider_id}: two turns / image / usage / reported cache")
    print("PASS 18/18 API provider wires with synthetic HTTP responses (36 generation requests, 0 live calls)")

    # Numeric bounds are a request-time contract. Even when an upstream would
    # happily return text, impossible input must fail before a generation POST;
    # known smaller output limits must be sent without truncating prompt/history.
    bounds = 0
    for spec in sorted(specs, key=lambda item: item.provider_id == "anthropic"):
        if spec.provider_id in {"vllm", "llamacpp", "koboldcpp"}:
            # These leaves re-read the exact runtime allocation (KoboldCpp
            # from /api/extra, vLLM/llama.cpp from /models), replacing stale
            # caller-supplied bounds. Their GETs run in the two-turn matrix.
            continue
        upstream = SyntheticUpstream(spec.provider_id, spec.default_model)
        base = GenerationRequest(provider=spec.provider_id, model=spec.default_model,
            api_key="IN_MEMORY_TEST_ONLY", base_url=spec.default_base_url,
            system_text=SYSTEM, user_parts=(FIRST_SOURCE,), expected_ids=("I1_P0",),
            unit_count=1, thinking="default",
            cache_context={"translationMode": "conversation", "thinkingRequested": "default"})
        with patch.object(httpx, "Client", side_effect=upstream.client):
            try:
                spec.adapter.generate(replace(base, model_capabilities={"limits": {"maxInputTokens": 1}}))
            except WorkloadBudgetError as error:
                check(error.diagnostics.get("constraint") == "input_limit",
                      f"{spec.provider_id}: expected physical input guard")
            else:
                raise AssertionError(f"{spec.provider_id}: input limit ignored")
            check(not any(p["method"] == "POST" for p in upstream.requests),
                  f"{spec.provider_id}: impossible input caused a generation POST")
            result = spec.adapter.generate(replace(base,
                model_capabilities={"limits": {"maxOutputTokens": 512}}))
        posts = [entry for entry in upstream.requests if entry["method"] == "POST"]
        check(len(posts) == 1 and result.text == FIRST_ANSWER,
              f"{spec.provider_id}: bounded output generation")
        body = posts[0]["body"]
        native_limit = body.get("max_tokens", body.get("max_completion_tokens",
            body.get("max_output_tokens", body.get("generationConfig", {}).get(
            "maxOutputTokens", body.get("options", {}).get("num_predict")))))
        check(type(native_limit) is int and 0 < native_limit <= 512,
              f"{spec.provider_id}: maxOutputTokens=512 not honored: {native_limit}")
        bounds += 1
    check(bounds == 15, f"expected 15 fixed-metadata bounds cases, found {bounds}")
    print(f"PASS {bounds}/15 known account/model input and output limits at real HTTP boundary")

    kobold = next(spec for spec in specs if spec.provider_id == "koboldcpp")
    upstream = SyntheticUpstream("koboldcpp", kobold.default_model)
    upstream.kobold_context = 1024
    oversized = GenerationRequest(provider="koboldcpp", model=kobold.default_model,
        base_url=kobold.default_base_url, system_text=SYSTEM,
        user_parts=("<<I1_P0:" + "ก" * 1500 + ">>",), expected_ids=("I1_P0",),
        thinking="default", cache_context={"translationMode": "conversation",
                                           "thinkingRequested": "default"})
    with patch.object(httpx, "Client", side_effect=upstream.client):
        try:
            kobold.adapter.generate(oversized)
        except WorkloadBudgetError as error:
            check(error.diagnostics.get("constraint") == "context_window",
                  f"KoboldCpp runtime context rejected for wrong reason: {error.diagnostics}")
        else:
            raise AssertionError("KoboldCpp ignored exact running context=1024")
    check(any(r["url"].endswith("/api/extra/true_max_context_length") for r in upstream.requests),
          "KoboldCpp did not read current server context")
    check(not any(r["method"] == "POST" for r in upstream.requests),
          "KoboldCpp sent oversized work after metadata refusal")
    print("PASS KoboldCpp live-metadata GET → exact 1024 context refusal before generation POST")

    # Local OpenAI compatibility is a wire format, not proof of an Off switch.
    local = [spec for spec in specs if spec.local and spec.provider_id != "ollama"]
    for spec in local:
        upstream = SyntheticUpstream(spec.provider_id, spec.default_model)
        request = GenerationRequest(provider=spec.provider_id, model=spec.default_model,
            base_url=spec.default_base_url, system_text=SYSTEM,
            user_parts=(FIRST_SOURCE,), expected_ids=("I1_P0",),
            thinking="off", cache_context={"translationMode": "conversation",
                                           "thinkingRequested": "off"})
        with patch.object(httpx, "Client", side_effect=upstream.client):
            try:
                spec.adapter.generate(request)
            except Exception as error:
                check(getattr(error, "code", None) == "ai_local_thinking_unsupported",
                      f"{spec.provider_id}: unsupported Off failed ambiguously: {error}")
            else:
                raise AssertionError(f"{spec.provider_id}: unknown Off silently accepted")
        check(not any(p["method"] == "POST" for p in upstream.requests),
              f"{spec.provider_id}: unknown Off must never dispatch")
    print(f"PASS {len(local)}/8 OpenAI-compatible Local providers: Off without proof fails before POST")

    ollama = next(spec for spec in specs if spec.provider_id == "ollama")
    upstream = SyntheticUpstream("ollama", ollama.default_model)
    request = GenerationRequest(provider="ollama", model=ollama.default_model,
        base_url=ollama.default_base_url, system_text=SYSTEM,
        user_parts=(FIRST_SOURCE,), expected_ids=("I1_P0",), thinking="off",
        cache_context={"translationMode": "conversation", "thinkingRequested": "off"})
    with patch.object(httpx, "Client", side_effect=upstream.client):
        result = ollama.adapter.generate(request)
        upstream.reasoning_frame = True
        try:
            ollama.adapter.generate(request)
        except Exception as error:
            check(getattr(error, "code", None) == "ai_local_thinking_violated",
                  f"Ollama responded with thinking despite Off: {error}")
            check("synthetic hidden thought" not in str(error),
                  "private thinking text escaped in error")
        else:
            raise AssertionError("Ollama thinking despite Off was accepted")
        upstream.reasoning_frame = False
        minimum = ollama.adapter.generate(replace(request, thinking="default",
            cache_context={"translationMode": "conversation", "thinkingRequested": "minimum"}))
    posts = [entry for entry in upstream.requests if entry["method"] == "POST"]
    check(len(posts) == 3 and all(p["body"].get("think") is False for p in posts),
          "Ollama Off/Lowest native switch missing")
    check(result.thinking_applied == minimum.thinking_applied == "requested_off_unverified_metadata",
          "Ollama unknown metadata must remain explicitly unverified")
    print("PASS Ollama Off/Lowest sends native think:false and rejects observed thinking (synthetic server)")

    upstream = SyntheticUpstream("ollama", ollama.default_model)
    with patch.object(httpx, "Client", side_effect=upstream.client):
        probe = ollama.adapter.probe(ProbeRequest(model=ollama.default_model,
                                                  base_url=ollama.default_base_url))
        check(probe.ok, "synthetic Ollama native probe failed")
        check(not any(p["method"] == "POST" and p["url"].endswith("/api/chat")
                      for p in upstream.requests), "Ollama probe caused a generation")
        limits = probe.capabilities["limits"]
        check((limits["runtimeContextTokens"], limits["modelContextTokens"]) == (4096, 32768),
              f"Ollama mixed current allocation with maximum: {limits}")
        source = "<<I1_P0:" + "ก" * 5000 + ">>"
        long_request = replace(request, user_parts=(source,), thinking="default",
            cache_context={"translationMode": "conversation", "thinkingRequested": "default"},
            model_capabilities=dict(probe.capabilities))
        ollama.adapter.generate(long_request)
    long_posts = [p["body"] for p in upstream.requests if p["method"] == "POST" and
                  p["url"].endswith("/api/chat")]
    check(len(long_posts) == 1, "Ollama context growth must use one generation attempt")
    requested_ctx = long_posts[0]["options"].get("num_ctx")
    check(type(requested_ctx) is int and 4096 < requested_ctx <= 32768,
          f"Ollama current runtime allocation must grow inside exact model cap: {requested_ctx}")
    print("PASS Ollama native /api/tags + /api/show + /api/ps → dynamic num_ctx; no probe generation")

    for provider in ("openrouter", "deepseek", "groq", "together"):
        spec = next(s for s in specs if s.provider_id == provider)
        upstream = SyntheticUpstream(provider, spec.default_model)
        with patch.object(httpx, "Client", side_effect=upstream.client):
            catalogue = spec.adapter.list_models(api_key="IN_MEMORY_TEST_ONLY",
                base_url=spec.default_base_url)
            check(catalogue.status == "valid" and spec.default_model in catalogue.models,
                  f"{provider}: exact simulated account model missing")
            limits = catalogue.capabilities.get(spec.default_model, {}).get("limits", {})
            check(limits.get("maxOutputTokens") == 512,
                  f"{provider}: catalogue output ceiling not parsed: {limits}")
            spec.adapter.generate(GenerationRequest(provider=provider, model=spec.default_model,
                api_key="IN_MEMORY_TEST_ONLY", base_url=spec.default_base_url,
                system_text=SYSTEM, user_parts=(FIRST_SOURCE,), expected_ids=("I1_P0",),
                thinking="default", model_capabilities=dict(catalogue.capabilities[spec.default_model])))
        sends = [entry["body"] for entry in upstream.requests if entry["method"] == "POST"]
        ceiling = sends[0].get("max_tokens", sends[0].get("max_completion_tokens")) if sends else None
        check(len(sends) == 1 and type(ceiling) is int and ceiling <= 512,
              f"{provider}: wrong ceiling in real outgoing HTTP request: {ceiling}")
    print("PASS 4/4 account catalogue GET → provider-normalized output cap → generated HTTP POST")

    # The provider-neutral Off choice maps to different native request fields.
    # All capabilities below are synthetic; this checks the real leaf serializer
    # at HTTP dispatch, not whether a vendor currently offers that model.
    off_cases = (
        ("anthropic", "claude-sonnet-5", {"supported": True, "control": "levels",
            "mandatory": False, "supported_efforts": ["none", "low"]},
            lambda body: body.get("thinking") == {"type": "disabled"}),
        ("deepseek", "deepseek-v4-flash", {"supported": True, "control": "boolean",
            "mandatory": False, "supported_efforts": ["none", "on"]},
            lambda body: body.get("thinking") == {"type": "disabled"}),
        ("featherless", "Qwen/Qwen3-32B", {"supported": True, "control": "boolean",
            "mandatory": False, "supported_efforts": ["none", "on"]},
            lambda body: body.get("chat_template_kwargs") == {"enable_thinking": False}),
        ("gemini", "gemini-2.5-flash", {"supported": True, "control": "levels",
            "mandatory": False, "supported_efforts": ["none", "low"]},
            lambda body: body.get("generationConfig", {}).get("thinkingConfig") == {"thinkingBudget": 0}),
        ("groq", "qwen/qwen3.8-27b", {"supported": True, "control": "levels",
            "mandatory": False, "supported_efforts": ["none", "low"]},
            lambda body: body.get("reasoning_effort") == "none"),
        ("huggingface", "fixture-model", {"supported": True, "control": "levels",
            "mandatory": False, "supported_efforts": ["none"]},
            lambda body: body.get("reasoning_effort") == "none"),
        ("openai", "gpt-5.6-luna", {"supported": True, "control": "levels",
            "mandatory": False, "supported_efforts": ["none", "low"]},
            lambda body: body.get("reasoning_effort") == "none"),
        ("openrouter", "openai/o4-mini", {"supported": True, "control": "levels",
            "mandatory": False, "can_disable": True, "supported_efforts": ["none", "low"]},
            lambda body: body.get("reasoning", {}).get("effort") == "none"),
        ("together", "Qwen/Qwen3.5-9B", {"supported": True, "control": "boolean",
            "mandatory": False, "supported_efforts": ["none", "on"]},
            lambda body: body.get("reasoning") == {"enabled": False}),
    )
    for provider, model, reasoning, correct in off_cases:
        spec = next(s for s in specs if s.provider_id == provider)
        upstream = SyntheticUpstream(provider, model)
        with patch.object(httpx, "Client", side_effect=upstream.client):
            spec.adapter.generate(GenerationRequest(provider=provider, model=model,
                api_key="IN_MEMORY_TEST_ONLY", base_url=spec.default_base_url,
                system_text=SYSTEM, user_parts=(FIRST_SOURCE,), expected_ids=("I1_P0",),
                thinking="off", model_capabilities={"reasoning": reasoning},
                cache_context={"thinkingRequested": "off", "reasoningCapabilityVerified": True}))
        posts = [item for item in upstream.requests if item["method"] == "POST"]
        check(len(posts) == 1 and correct(posts[0]["body"]),
              f"{provider}: verified Off mapped incorrectly to native HTTP body")
    print("PASS 9/9 Cloud-native Thinking Off controls in actual serialized HTTP bodies")

    lowest_cases = (
        ("openrouter", "openai/o4-mini", {"supported": True, "mandatory": False,
            "control": "levels", "supported_efforts": ["none", "low"]}, "off",
            lambda body: body.get("reasoning", {}).get("effort") == "none"),
        ("groq", "openai/gpt-oss-20b", {"supported": True, "mandatory": True,
            "control": "levels", "supported_efforts": ["low", "medium", "high"]}, "low",
            lambda body: body.get("reasoning_effort") == "low"),
        ("gemini", "gemini-3.6-flash", {"supported": True, "mandatory": True,
            "control": "levels", "supported_efforts": ["minimal", "low", "medium", "high"]},
            "minimal", lambda body: body.get("generationConfig", {}).get("thinkingConfig") ==
                             {"thinkingLevel": "minimal"}),
    )
    for provider, model, reasoning, selected, correct in lowest_cases:
        spec = next(s for s in specs if s.provider_id == provider)
        upstream = SyntheticUpstream(provider, model)
        check(resolve_reasoning_preference("minimum", reasoning) == selected,
              f"{provider}: Lowest resolver did not select exact lowest option")
        with patch.object(httpx, "Client", side_effect=upstream.client):
            spec.adapter.generate(GenerationRequest(provider=provider, model=model,
                api_key="IN_MEMORY_TEST_ONLY", base_url=spec.default_base_url,
                system_text=SYSTEM, user_parts=(FIRST_SOURCE,), expected_ids=("I1_P0",),
                thinking=selected, model_capabilities={"reasoning": reasoning},
                cache_context={"thinkingRequested": "minimum", "reasoningCapabilityVerified": True}))
        posts = [item for item in upstream.requests if item["method"] == "POST"]
        check(len(posts) == 1 and correct(posts[0]["body"]),
              f"{provider}: Lowest did not reach native HTTP as verified option")
    print("PASS 3/3 Cloud Lowest resolver → optional Off or mandatory low/minimal on HTTP")


if __name__ == "__main__":
    main()
