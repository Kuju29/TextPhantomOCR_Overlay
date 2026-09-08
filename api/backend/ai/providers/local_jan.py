from backend.ai.provider_contract import ProviderSpec
from backend.ai.providers.local_openai_runtime import LocalOpenAIChatAdapter, LocalOpenAIChatPolicy

DEFAULT_MODEL = "local-model"
DEFAULT_BASE_URL = "http://localhost:1337/v1"
ALIASES = ("jan.ai",)
MODEL_ALIASES = {}
KEY_PREFIXES = ()

POLICY = LocalOpenAIChatPolicy(
    provider_id="jan", aliases=ALIASES,
    default_model=DEFAULT_MODEL, default_base_url=DEFAULT_BASE_URL,
    model_aliases=MODEL_ALIASES, key_prefixes=KEY_PREFIXES,
    auth_optional=False, thinking_field=None,
    temperature=None, output_token_ceiling=8192,
    append_path="/v1", completion_path="/chat/completions",
    discovery_path="/models", strip_paths=("/chat/completions",),
    model_allow_prefixes=(), model_deny_prefixes=(),
)
ADAPTER = LocalOpenAIChatAdapter(POLICY)
SPEC = ProviderSpec(POLICY.provider_id, "openai_chat_completions",
                    POLICY.default_model, POLICY.default_base_url,
                    aliases=POLICY.aliases, model_aliases=POLICY.model_aliases,
                    key_prefixes=POLICY.key_prefixes, local=True, adapter=ADAPTER)

normalize_base_url = ADAPTER.normalize_base_url
normalize_model = ADAPTER.normalize_model
prepare_payload = ADAPTER.prepare_payload

__all__ = ["ADAPTER", "ALIASES", "DEFAULT_BASE_URL", "DEFAULT_MODEL",
           "KEY_PREFIXES", "MODEL_ALIASES", "POLICY", "SPEC",
           "normalize_base_url", "normalize_model", "prepare_payload"]
