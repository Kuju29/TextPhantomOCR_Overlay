from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
providers = {
    "cloud_openrouter.py": ("openrouter_chat", "execute_openrouter_chat"),
    "cloud_huggingface.py": ("huggingface_chat", "execute_huggingface_chat"),
    "cloud_openai.py": ("openai_cloud_chat", "execute_openai_cloud_chat"),
    "cloud_deepseek.py": ("deepseek_chat", "execute_deepseek_chat"),
}
for name, (module, function) in providers.items():
    text = (ROOT / "api/backend/ai/providers" / name).read_text(encoding="utf-8")
    assert f"backend.ai.transports.{module} import {function}" in text, (name, module)
    assert f"{function}(" in text, (name, function)

core = (ROOT / "api/backend/ai/transports/openai_compat/core.py").read_text(encoding="utf-8").lower()
for vendor in ("openrouter", "huggingface", "deepseek"):
    assert vendor not in core, f"shared OpenAI-compatible wire core must not own {vendor} policy"

compat = (ROOT / "api/backend/ai/transports/openai_chat.py").read_text(encoding="utf-8")
assert "Compatibility entry point" in compat
assert "execute_openai_compatible_request" in compat
print("PASS provider-specific transport seams are isolated from the shared OpenAI-compatible wire core")
