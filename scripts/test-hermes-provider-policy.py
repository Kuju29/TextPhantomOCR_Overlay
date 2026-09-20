#!/usr/bin/env python3
"""Offline provider-policy audit for all named TextPhantom AI providers.

This is a policy/boundary test, not a claim that third-party provider behavior is
identical. It verifies the Hermes-inspired invariants TextPhantom intentionally
adopts without making live requests.
"""
from __future__ import annotations

import ipaddress
import sys
from dataclasses import replace
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai.provider_contract import GenerationRequest
from backend.ai.provider_registry import ProviderRegistry
from backend.ai.providers import (
    compose_providers,
    cloud_openrouter,
    cloud_huggingface,
    cloud_groq,
    cloud_together,
    cloud_featherless,
    local_gpt4all,
    local_jan,
    local_koboldcpp,
    local_llamacpp,
    local_llamafile,
    local_lmstudio,
    local_localai,
    local_textgen,
    local_vllm,
)
from backend.ai.providers.openai_provider_runtime import build_payload

EXPECTED_CLOUD = {
    "anthropic", "deepseek", "featherless", "gemini", "groq",
    "huggingface", "openai", "openrouter", "together",
}
EXPECTED_LOCAL = {
    "gpt4all", "jan", "koboldcpp", "llamacpp", "llamafile",
    "lmstudio", "localai", "ollama", "textgen", "vllm",
}

registry = list(compose_providers(ProviderRegistry()))
cloud = {spec.provider_id for spec in registry if not spec.local}
local = {spec.provider_id for spec in registry if spec.local}
assert cloud == EXPECTED_CLOUD, cloud
assert local == EXPECTED_LOCAL, local
assert len(registry) == 19
assert all(spec.adapter is not None for spec in registry)

# OpenRouter routing belongs only to the official OpenRouter endpoint.
base_request = GenerationRequest(
    provider="openrouter", model="openai/o4-mini", api_key="fixture",
    base_url=cloud_openrouter.DEFAULT_BASE_URL, system_text="STYLE",
    user_parts=("<<TP_P0:hello>>",), expected_ids=("P0",), unit_count=1,
    thinking="off", model_capabilities={"reasoning": {"supported": False}},
    workload={"version": 1, "predictedOutput": 256, "completionAvailable": 4096},
)
or_payload = cloud_openrouter._apply_official_routing(
    cloud_openrouter.prepare_payload(base_request), cloud_openrouter.DEFAULT_BASE_URL
)
assert or_payload.get("provider", {}).get("sort") == "throughput"
assert or_payload["provider"].get("allow_fallbacks") is True
assert or_payload["provider"].get("require_parameters") is True
custom_payload = cloud_openrouter._apply_official_routing(
    {"model": "x", "messages": []}, "https://example.invalid/v1"
)
assert "provider" not in custom_payload

# Direct providers do not inherit OpenRouter routing policy.
for module in (cloud_groq, cloud_together, cloud_featherless):
    req = replace(base_request, provider=module.PROVIDER_ID,
                  model=module.DEFAULT_MODEL, base_url=module.DEFAULT_BASE_URL)
    payload = build_payload(req, req.model, module.POLICY)
    assert "provider" not in payload, (module.PROVIDER_ID, payload)

# HF automatic routing must stay automatic even if a previous turn/capability
# mentions one upstream. Only a user-selected suffix is sticky.
hf_req = replace(base_request, provider="huggingface",
    model="deepseek-ai/DeepSeek-V4-Flash-0731",
    base_url=cloud_huggingface.DEFAULT_BASE_URL,
    cache_context={"translationMode":"conversation", "hfInferenceProvider":"scaleway"},
    model_capabilities={"routing":{"preferred_provider":"scaleway"}})
assert cloud_huggingface._effective_conversation_model(hf_req) == (
    "deepseek-ai/DeepSeek-V4-Flash-0731", "")
explicit = replace(hf_req, model="deepseek-ai/DeepSeek-V4-Flash-0731:novita")
assert cloud_huggingface._effective_conversation_model(explicit) == (
    "deepseek-ai/DeepSeek-V4-Flash-0731:novita", "novita")

# Named local OpenAI-compatible runtimes follow the safe custom-endpoint rule:
# loopback defaults, no cloud routing, no guessed reasoning/sampling controls.
local_modules = (
    local_gpt4all, local_jan, local_koboldcpp, local_llamacpp,
    local_llamafile, local_lmstudio, local_localai, local_textgen, local_vllm,
)
for module in local_modules:
    policy = module.POLICY
    host = urlsplit(policy.default_base_url).hostname or ""
    assert host in {"localhost", "127.0.0.1", "::1"} or ipaddress.ip_address(host).is_private
    assert policy.thinking_field is None, policy.provider_id
    assert policy.temperature is None, policy.provider_id
    req = replace(base_request, provider=policy.provider_id,
                  model=policy.default_model, base_url=policy.default_base_url,
                  api_key="", model_capabilities={})
    payload = module.ADAPTER.prepare_payload(req)
    assert "provider" not in payload, policy.provider_id
    assert not any(key in payload for key in ("reasoning", "reasoning_effort", "thinking")), (
        policy.provider_id, payload)

# Static performance-telemetry boundary: streamed cloud/OpenAI-compatible and
# local transports expose first-content timing; Gemini/Anthropic deliberately
# use total provider time because their current TextPhantom path is non-streaming.
core = (ROOT / "api/backend/ai/transports/openai_compat/core.py").read_text(encoding="utf-8")
local_runtime = (ROOT / "src/shared/ai/providers/local-transport-runtime.js").read_text(encoding="utf-8")
learning = (ROOT / "src/shared/ai/workload/learning.js").read_text(encoding="utf-8")
assert "first_content_ms" in core and "firstContentMs" in local_runtime
assert "slowTotalMsWhenFirstContentUnknown" in learning

print("Hermes-inspired provider policy audit: 19/19 named providers PASS")
