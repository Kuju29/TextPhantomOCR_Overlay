import json
import sys
import types
from pathlib import Path

from backend.ai.provider_resolution import (
    effective_model_capabilities,
    normalize_model_capabilities,
)
# Keep this contract test independent of optional provider HTTP SDKs. The config
# boundary only needs local/cloud classification; provider composition is tested
# by the provider suites.
rate_policy = types.ModuleType("backend.ai.rate_policy")
rate_policy.is_local_target = lambda provider, base_url="": str(provider).startswith("local")
sys.modules.setdefault("backend.ai.rate_policy", rate_policy)
from backend.jobs.stages.config import build_ai_config
from backend.application.ai_translation.request_validation import build_config

fixture = json.loads((Path(__file__).parent / "fixtures/model-capabilities-vision.json").read_text())
assert normalize_model_capabilities(fixture["input"]) == fixture["normalized"]

client_true = {"vision": {"supported": True, "source": "verified-client"}}
server_false = {"vision": {"supported": False, "source": "live-server"}}
assert effective_model_capabilities(
    discovery_fresh=False, server=server_false, client=client_true
)["vision"]["supported"] is True
assert effective_model_capabilities(
    discovery_fresh=True, server=server_false, client=client_true
) == server_false
assert effective_model_capabilities(
    discovery_fresh=True, server={}, client=client_true
) == {}

config = build_ai_config({
    "ai": {
        "provider": "openrouter", "model": "fixture", "base_url": "auto",
        "api_key": "fixture-key", "prompt": "fixture prompt", "prompt_mode": "replace",
        "model_capabilities": fixture["input"],
    }
}, "lens_text", "ai")
assert config is not None
assert config.model_capabilities == fixture["normalized"]

direct_config = build_config({
    "provider": {
        "id": "openrouter", "model": "fixture", "baseUrl": "auto",
        "apiKey": "fixture-key", "modelCapabilities": fixture["input"],
    },
    "prompt": "fixture prompt", "prompt_mode": "replace",
})
assert direct_config.model_capabilities == fixture["normalized"]
print("Python page-image capability normalization, authority, and runs:API config passed.")
