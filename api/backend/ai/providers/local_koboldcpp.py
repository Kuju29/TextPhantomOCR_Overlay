from dataclasses import replace

import httpx

from backend.ai.provider_contract import ProviderSpec
from backend.ai.providers.local_openai_runtime import LocalOpenAIChatAdapter, LocalOpenAIChatPolicy

DEFAULT_MODEL = "local-model"
DEFAULT_BASE_URL = "http://localhost:5001/v1"
ALIASES = ("kobold", "koboldai")
MODEL_ALIASES = {}
KEY_PREFIXES = ()

POLICY = LocalOpenAIChatPolicy(
    provider_id="koboldcpp", aliases=ALIASES,
    default_model=DEFAULT_MODEL, default_base_url=DEFAULT_BASE_URL,
    model_aliases=MODEL_ALIASES, key_prefixes=KEY_PREFIXES,
    auth_optional=False, thinking_field=None,
    temperature=None, output_token_ceiling=8192,
    append_path="/v1", completion_path="/chat/completions",
    discovery_path="/models", strip_paths=("/chat/completions",),
    model_allow_prefixes=(), model_deny_prefixes=(),
    runtime_context_probe=True,
)
class KoboldCppAdapter(LocalOpenAIChatAdapter):
    def list_models(self, *, api_key: str, base_url: str):
        listed = super().list_models(api_key=api_key, base_url=base_url)
        # This KoboldCpp endpoint describes the loaded server, not a named
        # model. Attribute it only when /v1/models has one exact model row.
        if listed.status != "valid" or len(listed.models) != 1:
            return listed
        root = self.normalize_base_url(base_url)
        if not root.lower().endswith("/v1"):
            return listed
        try:
            with httpx.Client(timeout=3.0) as client:
                response = client.get(root[:-3] + "/api/extra/true_max_context_length")
            data = response.json() if response.is_success else None
        except (httpx.RequestError, ValueError, TypeError, AttributeError):
            return listed
        value = data.get("value") if isinstance(data, dict) else None
        if type(value) is not int or not 0 < value <= 100_000_000:
            return listed
        model = listed.models[0]
        capabilities = {**listed.capabilities,
                        model: {**listed.capabilities.get(model, {}),
                                "limits": {"contextTokens": value,
                                           "runtimeContextTokens": value,
                                           "source": "koboldcpp-api-extra-true-max-context-length",
                                           "scope": "runtime"}}}
        return replace(listed, capabilities=capabilities)


ADAPTER = KoboldCppAdapter(POLICY)
SPEC = ProviderSpec(POLICY.provider_id, "openai_chat_completions",
                    POLICY.default_model, POLICY.default_base_url,
                    aliases=POLICY.aliases, model_aliases=POLICY.model_aliases,
                    key_prefixes=POLICY.key_prefixes, local=True, conversation_transport="message_replay", adapter=ADAPTER)

normalize_base_url = ADAPTER.normalize_base_url
normalize_model = ADAPTER.normalize_model
prepare_payload = ADAPTER.prepare_payload

__all__ = ["ADAPTER", "ALIASES", "DEFAULT_BASE_URL", "DEFAULT_MODEL",
           "KEY_PREFIXES", "MODEL_ALIASES", "POLICY", "SPEC",
           "normalize_base_url", "normalize_model", "prepare_payload"]
