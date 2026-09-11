"""Neutral value normalization shared by provider leaves."""

from collections.abc import Callable

from backend.ai.provider_contract import GenerationRequest, ModelListResult

def model_status(*, models=None, status: str, http_status: int = 0,
                 error: str = "") -> dict:
    return {"models": list(models or []), "status": status,
            "http_status": int(http_status or 0), "error": str(error or "")[:240]}

def contract_model_status(result: dict) -> ModelListResult:
    return ModelListResult(models=tuple(result["models"]), status=result["status"],
                           http_status=result["http_status"], error=result["error"],
                           capabilities=result.get("capabilities") or {},
                           candidates=result.get("candidates") or {})

def invoke_leaf_generate(request: GenerationRequest, generate: Callable):
    return generate(
        request.api_key, request.model, request.system_text, list(request.user_parts),
        system_sections=request.system_sections,
        image_b64=request.image_b64, image_mime=request.image_mime,
        response_schema=dict(request.response_schema or {}) or None,
        thinking=request.thinking, cancel_check=request.cancel_check,
        **({"workload": dict(request.workload), "model_capabilities": dict(request.model_capabilities)}
           if request.workload else {}),
    )

def resolve_alias(model: str, aliases: dict[str, str], default: str) -> str:
    selected = (model or "").strip()
    return aliases.get(selected.lower(), selected or default)

__all__ = ["contract_model_status", "invoke_leaf_generate", "model_status", "resolve_alias"]
