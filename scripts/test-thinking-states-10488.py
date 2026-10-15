"""10488 AI think states: one classification for every provider; no live requests.

The shared fixture (scripts/fixtures/thinking-states-10488.json) is also run by
scripts/test-thinking-states-10488.mjs against the extension mirror. Here it
checks the Python classification, feeds each raw provider input through that
provider's real normalizer, and drives `_translate_once_impl` for the API
behaviour: none/default send no reasoning field (provider default, saved
preference kept, visible in the trace), loading never dispatches.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai import markers  # noqa: E402
from backend.ai.clients.base import ChatResult  # noqa: E402
from backend.ai.cloud_reasoning import CloudReasoningPreferenceUnavailable  # noqa: E402
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeResponse  # noqa: E402
from backend.ai.provider_registry import provider_registry  # noqa: E402
from backend.ai.provider_resolution import (  # noqa: E402
    forget_model_capabilities, normalize_model_capabilities, remember_model_capabilities,
    selected_model_listed,
)
from backend.ai.providers import (  # noqa: E402
    cloud_anthropic, cloud_deepseek, cloud_featherless, cloud_gemini, cloud_groq,
    cloud_openai, cloud_openrouter, cloud_paid, cloud_together, local_ollama,
)
from backend.ai.providers.anthropic_reasoning import _reasoning_capability as anthropic_native  # noqa: E402
from backend.ai.providers.openai_reasoning import reasoning_capability as openai_native  # noqa: E402
from backend.ai.login.login_profiles import capabilities as login_capabilities  # noqa: E402
from backend.ai.login.login_provider_claude import website_thinking as claude_web_thinking  # noqa: E402
from backend.ai.thinking_state import (  # noqa: E402
    THINKING_STATES, classify_thinking_state, sends_provider_default, thinking_control_options,
)
from backend.ai.translation import invocation  # noqa: E402
from backend.ai.translation.contracts import AiConfig  # noqa: E402
from backend.ai.translation.invocation import _translate_once_impl  # noqa: E402

FIXTURE = json.loads((ROOT / "scripts/fixtures/thinking-states-10488.json").read_text("utf-8"))
VECTORS = FIXTURE["vectors"]
checks = 0


def check(condition, message):
    global checks
    assert condition, message
    checks += 1


# ------------------------------------------------------------ classification
check(tuple(FIXTURE["states"]) == THINKING_STATES, "fixture and module share the four states")
for vector in VECTORS:
    state = classify_thinking_state(vector["record"], fresh=vector["fresh"])
    check(state == vector["state"], f"{vector['id']}: state {state} != {vector['state']}")
    options = list(thinking_control_options(vector["record"]))
    check(options == vector["options"], f"{vector['id']}: options {options} != {vector['options']}")
    check(sends_provider_default(state) == (state in {"none", "default"}), vector["id"])

# Coverage: every registry provider, Paid and Login has the required cases.
REQUIRED = {"levels", "toggle", "mandatory", "no_reasoning", "silent", "missing"}
OPENAI_COMPATIBLE_LOCAL = {"llamacpp", "vllm", "koboldcpp", "jan", "gpt4all", "textgen", "llamafile"}
families: dict[str, set[str]] = {}
for vector in VECTORS:
    family = "local-openai-compatible" if vector["provider"] in OPENAI_COMPATIBLE_LOCAL else vector["provider"]
    families.setdefault(family, set()).add("missing" if vector["case"] == "stale" else vector["case"])
registry = {spec.provider_id for spec in provider_registry}
check(len(registry) == 18, f"registry has the 18 manual providers: {sorted(registry)}")
for provider in registry | {"paid", "login"}:
    family = "local-openai-compatible" if provider in OPENAI_COMPATIBLE_LOCAL else provider
    check(REQUIRED <= families.get(family, set()),
          f"{provider}: missing cases {sorted(REQUIRED - families.get(family, set()))}")
    if provider in OPENAI_COMPATIBLE_LOCAL:
        check(any(v["provider"] == provider and v["case"] == "silent" for v in VECTORS),
              f"{provider}: its own silent (no published control) vector")


# --------------------------------------------------- provider normalizers feed it
class FakeResponse:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.is_success = True
        self.headers = {}

    def json(self):
        return self._payload


class FakeClient:
    payload: dict = {}

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, *args, **kwargs):
        return FakeResponse(FakeClient.payload)


def gemini_catalogue(source):
    row = {"name": "models/" + source["model"], "supportedGenerationMethods": ["generateContent"]}
    if "thinking" in source:
        row["thinking"] = source["thinking"]
    FakeClient.payload = {"models": [row]}
    with patch.object(cloud_gemini.httpx, "Client", FakeClient):
        listed = cloud_gemini.models_status("fixture-key")
    assert source["model"] in listed["models"], (source, listed)
    return (listed["capabilities"].get(source["model"]) or {}).get("reasoning", {})


def raw_reasoning(source):
    kind = source["kind"]
    if kind == "openrouter_catalogue":
        return cloud_openrouter.normalize_capabilities(source["item"]).get("reasoning", {})
    if kind == "openai_native":
        return openai_native(source["model"])
    if kind == "anthropic_native":
        return anthropic_native(source["model"])
    if kind == "anthropic_catalogue":
        return anthropic_native(source["row"]["id"]) or cloud_anthropic._catalogue_no_thinking(source["row"])
    if kind == "gemini_catalogue":
        return gemini_catalogue(source)
    if kind == "deepseek_catalogue":
        return cloud_deepseek._catalogue_capabilities(source["item"]).get("reasoning", {})
    if kind == "groq_native":
        return cloud_groq._reasoning_capability(source["model"])
    if kind == "together_native":
        return cloud_together._reasoning_capability(source["model"])
    if kind == "featherless_native":
        return cloud_featherless._reasoning_capability(source["model"])
    if kind == "ollama_show":
        return local_ollama._native_thinking_capability(source.get("thinking"))
    if kind == "paid_center":
        return source["model_capabilities"].get("reasoning", {})
    if kind == "login_meta":
        return login_capabilities(source["meta"]).get("reasoning", {})
    if kind == "claude_web":  # claude.ai chat picker `thinking` (10492)
        return claude_web_thinking(source["thinking"])[0] or {}
    raise AssertionError("unknown source kind " + kind)


for vector in VECTORS:
    if "source" not in vector:
        continue
    raw = raw_reasoning(vector["source"])
    normalized = normalize_model_capabilities({"reasoning": raw}).get("reasoning", {})
    check(normalized == vector["record"], f"{vector['id']}: normalizer gave {normalized}")
    # The API classifies native maps un-normalized; both forms must agree.
    check(classify_thinking_state(raw, fresh=True) == vector["state"], f"{vector['id']}: raw form")


# ------------------------------------------------------------- API behaviour
def ai_config(provider, model, thinking, **extra):
    return AiConfig(api_key="fixture-key-10488", provider=provider, model=model, thinking=thinking,
                    prompt_mode="replace", prompt_editable="Translate.", **extra)


def dispatch(provider, model, thinking, record, *, fresh=True, base_url=""):
    caps = {} if record is None else {"reasoning": record}
    with patch("backend.ai.provider_resolution.discovered_model_capabilities",
               return_value=(fresh, caps if fresh else {})), \
         patch("backend.ai.provider_resolution.refresh_cloud_model_capabilities",
               return_value=(fresh, caps if fresh else {})), \
         patch("backend.ai.providers.huggingface_details.refresh", return_value={}), \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch("backend.ai.accounting.generate_with_receipt",
               return_value=ChatResult("translated", model)) as generation, \
         patch.object(invocation, "decode_result",
                      side_effect=lambda **values: {**values, "meta": {"prompt_audit": {}}}), \
         patch.object(invocation.trace_preview, "note") as notes:
        try:
            result = _translate_once_impl(markers.apply(["source"]), "th",
                                          ai_config(provider, model, thinking, base_url=base_url))
        except (CloudReasoningPreferenceUnavailable, Exception) as error:  # noqa: BLE001
            assert generation.call_count == 0, (provider, model, thinking)
            return None, error, None
    traces = [c.args[1] for c in notes.call_args_list if c.args[0] == "AI diagnostic reasoning policy resolved"]
    return generation.call_args.args[1], result, traces[0]


if provider_registry.get("paid") is None:
    provider_registry.register(cloud_paid.SPEC)

CLOUD = ("openrouter", "openai", "anthropic", "gemini", "deepseek", "groq", "together",
         "featherless", "huggingface", "paid")
for provider in CLOUD:
    model = "vendor/model:groq" if provider == "huggingface" else "future-model-10488"
    for record, expected in (({}, "default"), ({"supported": True, "control": "provider"}, "default"),
                             ({"supported": False}, "none")):
        for saved in ("off", "minimum", "low", "on", "max"):
            request, result, trace = dispatch(provider, model, saved, record)
            check(request is not None, f"{provider} {saved} {record}: dispatched, no 409 ({result})")
            check(request.thinking == "default", f"{provider}: provider default selected")
            context = request.cache_context
            check(context["thinkingRequested"] == saved
                  and context["thinkingProviderDefault"] is True and context["thinkingState"] == expected,
                  f"{provider}: saved preference kept beside the provider-default request")
            check(result["thinking_applied"] == ("not_applicable_non_reasoning_model" if expected == "none"
                                                 else "provider_default"),
                  f"{provider}: usage reports that no control was sent")
            check(trace["thinkingState"] == expected and trace["effectivePolicy"] == "provider_default",
                  f"{provider}: trace shows the state")
    # Missing / stale record: explicit error, nothing dispatched.
    for saved in ("off", "minimum", "low", "on"):
        request, error, _ = dispatch(provider, model, saved, None, fresh=False)
        check(request is None and isinstance(error, CloudReasoningPreferenceUnavailable),
              f"{provider} {saved}: loading must not dispatch ({error!r})")
        check(error.requestDispatched is False and error.providerAttempts == 0, provider)

# A controllable record keeps its exact control (no regression to default).
request, result, trace = dispatch("openrouter", "vendor/reasoner", "low",
                                  {"supported": True, "mandatory": True, "control": "levels",
                                   "supported_efforts": ["low", "high"]})
check(request.thinking == "low" and request.cache_context["thinkingProviderDefault"] is False
      and trace["thinkingState"] == "controllable", "controllable keeps the selected level")
request, result, trace = dispatch("openrouter", "vendor/reasoner", "minimum",
                                  {"supported": True, "mandatory": False, "control": "levels",
                                   "supported_efforts": ["none", "low"]})
check(request.thinking == "off", "Lowest resolves to the lowest proven control (Off)")

# Native documented maps are their own fresh record even on a cold catalogue.
request, _, trace = dispatch("openai", "gpt-4o", "high", None, fresh=False)
check(request is not None and request.thinking == "default" and trace["thinkingState"] == "none",
      "a documented non-reasoning OpenAI model needs no catalogue round trip")
request, _, _ = dispatch("openai", "gpt-5.2", "low", None, fresh=False)
check(request is not None and request.thinking == "low", "a documented OpenAI level is controllable")

# Wire: provider default sends no reasoning/thinking field.
for record in ({"supported": True, "control": "provider", "default_enabled": True, "supports_max_tokens": True},
               {"supported": False}, {}):
    payload = cloud_openrouter.prepare_payload(GenerationRequest(
        provider="openrouter", model="vendor/x", thinking="default", system_text="s", user_parts=("u",),
        model_capabilities={"reasoning": record},
        cache_context={"thinkingRequested": "default", "thinkingProviderDefault": True}))
    check("reasoning" not in payload, f"OpenRouter provider default sends no reasoning field: {payload.get('reasoning')}")
payload = cloud_openai.prepare_payload(GenerationRequest(
    provider="openai", model="gpt-7-preview", thinking="default", system_text="s", user_parts=("u",),
    model_capabilities={}))
check("reasoning_effort" not in payload and "reasoning" not in payload, "OpenAI provider default sends no effort")


class Stop(Exception):
    pass


captured = []


def capture(client, url, outgoing, headers):
    captured.append(dict(outgoing))
    raise Stop()


for flag, expected_thinking in ((True, None), (False, "low")):
    captured.clear()
    with patch.object(cloud_paid, "center_base_url", return_value="https://center.example"), \
         patch.object(cloud_paid, "center_origin", return_value="https://center.example"), \
         patch("backend.ai.paid_protocol.require_protocol"), \
         patch("backend.ai.paid_protocol.stream_supported", return_value=False), \
         patch.object(cloud_paid, "_post_center", side_effect=capture):
        try:
            cloud_paid.ADAPTER.generate(GenerationRequest(
                provider="paid", model="vendor/x", api_key="tp-session", thinking="default" if flag else "low",
                system_text="s", user_parts=("u",), model_capabilities={},
                cache_context={"operationId": "op-10488", "thinkingRequested": "low",
                               "thinkingProviderDefault": flag}))
        except Stop:
            pass
    check(len(captured) == 1, "Paid reached the Center boundary once")
    check(captured[0].get("thinking") == expected_thinking and "reasoning" not in captured[0],
          f"Paid Center payload thinking={captured[0].get('thinking')!r}")

# A model absent from a fresh account catalogue has no record: loading.
router = provider_registry.require("openrouter")
forget_model_capabilities("openrouter", router.default_base_url, "fixture-key-10488")
remember_model_capabilities("openrouter", router.default_base_url, "fixture-key-10488",
                            {"vendor/listed": {}}, models=("vendor/listed",))
check(selected_model_listed("openrouter", router.default_base_url, "vendor/listed", "fixture-key-10488") is True,
      "a silent catalogue entry is a record")
check(selected_model_listed("openrouter", router.default_base_url, "vendor/gone", "fixture-key-10488") is False,
      "an absent model has no record")
with patch.object(invocation, "assert_ai_base_url_allowed"), \
     patch("backend.ai.accounting.generate_with_receipt") as generation:
    try:
        _translate_once_impl(markers.apply(["source"]), "th", ai_config("openrouter", "vendor/gone", "minimum"))
    except CloudReasoningPreferenceUnavailable:
        pass
    else:
        raise AssertionError("a model absent from the account catalogue dispatched")
check(generation.call_count == 0, "absent model: nothing dispatched")
with patch.object(invocation, "assert_ai_base_url_allowed"), \
     patch("backend.ai.accounting.generate_with_receipt",
           return_value=ChatResult("translated", "vendor/listed")) as generation, \
     patch.object(invocation, "decode_result", return_value={"meta": {"prompt_audit": {}}}):
    _translate_once_impl(markers.apply(["source"]), "th", ai_config("openrouter", "vendor/listed", "high"))
check(generation.call_args.args[1].thinking == "default", "a silent listed model is provider default")

# Hugging Face `model:provider` route ids inherit only the base listing.
hf = provider_registry.require("huggingface")
forget_model_capabilities("huggingface", hf.default_base_url, "hf-key")
remember_model_capabilities("huggingface", hf.default_base_url, "hf-key",
                            {"vendor/base": {"vision": {"supported": False}}}, models=("vendor/base",))
check(selected_model_listed("huggingface", hf.default_base_url, "vendor/base:groq", "hf-key") is True,
      "HF route id is a record of its listed base")
check(selected_model_listed("huggingface", hf.default_base_url, "vendor/other:groq", "hf-key") is False,
      "HF route id of an unlisted base has no record")

# A failed catalogue refresh is the existing explicit error (owner's old bug).
forget_model_capabilities("openrouter", router.default_base_url, "cold-key")
for listed_result in (ModelListResult(status="unreachable"), RuntimeError("slow catalogue")):
    with patch.object(router.adapter, "list_models",
                      **({"side_effect": listed_result} if isinstance(listed_result, Exception)
                         else {"return_value": listed_result})), \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch("backend.ai.accounting.generate_with_receipt") as generation:
        try:
            _translate_once_impl(markers.apply(["source"]), "th", AiConfig(
                api_key="cold-key", provider="openrouter", model="vendor/reasoner", thinking="low",
                prompt_mode="replace", prompt_editable="Translate.",
                model_capabilities={"reasoning": {"supported": True, "control": "provider"}}))
        except CloudReasoningPreferenceUnavailable as error:
            check(error.code == "ai_thinking_mode_unavailable", "explicit error code")
        else:
            raise AssertionError("dispatched although the catalogue lookup failed")
    check(generation.call_count == 0, "failed refresh: nothing dispatched")

# Ollama: /api/show without thinking.values is provider default (no `think`).
ollama = provider_registry.require("ollama")
for show, saved, expected_state, expected_thinking in (
    ({"vision": {"supported": False}}, "off", "default", "default"),
    ({"reasoning": local_ollama._native_thinking_capability({"values": [False]})}, "on", "none", "default"),
    ({"reasoning": local_ollama._native_thinking_capability({"values": [False, True]})}, "minimum",
     "controllable", "off"),
):
    with patch.object(ollama.adapter, "probe", return_value=ProbeResponse(True, 200, capabilities=show)), \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch("backend.ai.accounting.generate_with_receipt",
               return_value=ChatResult("translated", "qwen3")) as generation, \
         patch.object(invocation, "decode_result", return_value={"meta": {"prompt_audit": {}}}):
        _translate_once_impl(markers.apply(["source"]), "th", AiConfig(
            api_key="", provider="ollama", model="qwen3", thinking=saved,
            base_url="http://localhost:11434", prompt_mode="replace", prompt_editable="Translate."))
    request = generation.call_args.args[1]
    check(request.thinking == expected_thinking and request.cache_context["thinkingState"] == expected_state,
          f"Ollama {expected_state}: {request.thinking}")
    if expected_state != "controllable":
        with patch.object(local_ollama, "generate", return_value=ChatResult("t", "qwen3")) as wire:
            local_ollama.ADAPTER.generate(request)
        check(wire.call_args.kwargs["thinking"] == "default", "Ollama sends no think field")
with patch.object(ollama.adapter, "probe", return_value=ProbeResponse(False, 0, "unreachable")), \
     patch.object(invocation, "assert_ai_base_url_allowed"), \
     patch("backend.ai.accounting.generate_with_receipt") as generation:
    try:
        _translate_once_impl(markers.apply(["source"]), "th", AiConfig(
            api_key="", provider="ollama", model="qwen3", thinking="off",
            base_url="http://localhost:11434", prompt_mode="replace", prompt_editable="Translate."))
    except Exception as error:  # noqa: BLE001
        check(getattr(error, "code", "") == "ai_local_thinking_unsupported", "Ollama loading error")
    else:
        raise AssertionError("Ollama dispatched without current /api/show")
check(generation.call_count == 0, "Ollama loading: nothing dispatched")

# OpenAI-compatible Local runtimes without a probe read their model list when
# cold; an unreachable runtime is loading, a listed silent model is default.
jan = provider_registry.require("jan")
for listed_result, dispatched in ((ModelListResult(status="unreachable"), False),
                                  (ModelListResult(models=("local-model",), status="valid"), True)):
    forget_model_capabilities("jan", "http://localhost:1337/v1", "")
    with patch.object(jan.adapter, "list_models", return_value=listed_result), \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch("backend.ai.accounting.generate_with_receipt",
               return_value=ChatResult("translated", "local-model")) as generation, \
         patch.object(invocation, "decode_result", return_value={"meta": {"prompt_audit": {}}}):
        try:
            _translate_once_impl(markers.apply(["source"]), "th", AiConfig(
                api_key="", provider="jan", model="local-model", thinking="on",
                base_url="http://localhost:1337/v1", prompt_mode="replace", prompt_editable="Translate."))
        except Exception as error:  # noqa: BLE001
            check(not dispatched and getattr(error, "code", "") == "ai_local_thinking_unsupported",
                  f"Jan loading error: {error!r}")
    check(generation.call_count == (1 if dispatched else 0), "Jan dispatch count")
    if dispatched:
        check(generation.call_args.args[1].thinking == "default", "Jan provider default")

print(f"PASS 10488 thinking states: {len(VECTORS)} shared vectors, {checks} checks "
      "(18 registry providers + Paid + Login; none/default send provider default; loading never dispatches)")
