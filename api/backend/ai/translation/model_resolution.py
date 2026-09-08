"""Generation model resolution policy."""

from backend.ai.provider_resolution import resolve_model

def resolve_generation_model(provider: str, requested_model: str) -> str:
    requested = (requested_model or "").strip()
    if not requested or requested.lower() == "auto":
        return resolve_model(provider, "auto")
    return requested
