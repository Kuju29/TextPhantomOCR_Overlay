from .login_provider_contract import LoginError
from . import login_provider_chatgpt, login_provider_claude, login_provider_gemini, login_provider_deepseek, login_provider_openrouter, login_provider_huggingface
from .login_provider_contract import LoginProvider
PROVIDERS = {module.PROVIDER.id: module.PROVIDER for module in (
    login_provider_chatgpt, login_provider_claude, login_provider_gemini, login_provider_deepseek, login_provider_openrouter, login_provider_huggingface)}
for key, label in (("groq", "Groq"), ("together", "Together"), ("featherless", "Featherless")):
    PROVIDERS["login_"+key] = LoginProvider("login_"+key, label, "api_key", "", "", 0, "", supported=False, unavailable_reason="api_key_required")

# ChatGPT and Claude Login translation is enabled for real-account testing;
# their labels stay "not supported yet" until live translation is proven. No
# browser integrity, proof or challenge token is generated or replayed; if a
# website requires browser preparation, translation stops before any message.
TRANSLATION_UNDER_IMPROVEMENT = frozenset()
TRANSLATION_TESTING = frozenset()

def translation_supported(identifier):
    return get_provider(identifier).supported and identifier not in TRANSLATION_UNDER_IMPROVEMENT

def require_translation_supported(identifier):
    if not translation_supported(identifier):
        raise LoginError('login_translation_unsupported',
            'This provider Login is not supported for translation yet and is under improvement. Sign-in may still verify your account. Choose Gemini or DeepSeek Login, or the provider official API mode.', 409)

def get_provider(identifier):
    if identifier not in PROVIDERS:
        raise LoginError("login_provider_unknown", "Login provider is unavailable", 404)
    return PROVIDERS[identifier]
