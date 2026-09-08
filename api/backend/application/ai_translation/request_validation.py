from backend.ai.workload import normalize_workload
from backend.ai.capabilities import SCHEMA_OBJECT, COMPACT_MARKERS
"""Validate and normalize API translation requests."""

import base64, io

from backend.ai.translation.contracts import AiConfig
from backend.ai.rate_policy import is_local_target
from backend.application import ai_request
from backend.config import settings
from backend.ai.provider_resolution import normalize_model_capabilities

# Abuse guard matches the Lens document paragraph bound, not a batching policy.
# Short units may exceed the historical 200-row cap under a character target.
MAX_UNITS = 2000
MAX_UNIT_CHARS = 4000
MAX_TOTAL_CHARS = 60000
MAX_IMAGE_BYTES = 12 * 1024 * 1024

def validate(payload: dict) -> tuple[list[dict], str, AiConfig]:
    units = ai_request.validate_units(
        payload.get("units"), max_units=MAX_UNITS,
        max_unit_chars=MAX_UNIT_CHARS, max_total_chars=MAX_TOTAL_CHARS,
    )
    target_lang = str(payload.get("targetLang") or "").strip()
    if not target_lang:
        raise ValueError("targetLang is required")
    return units, target_lang, build_config(payload)

def build_config(payload: dict) -> AiConfig:
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    memory = payload.get("memory") if isinstance(payload.get("memory"), dict) else {}
    user_key = str(provider.get("apiKey") or "").strip()
    provider_id = str(provider.get("id") or "auto").strip() or "auto"
    base_url = str(provider.get("baseUrl") or "auto").strip() or "auto"
    prompt_mode = str(payload.get("prompt_mode") or "").strip().lower()
    if prompt_mode != "replace":
        raise ValueError("prompt_mode must be exactly 'replace'")
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("AI_PROMPT_REQUIRED: AI Style is empty; Reload the built-in prompt and save it")
    planned_contract = provider.get("outputContract", "")
    if not isinstance(planned_contract, str) or planned_contract not in ("", SCHEMA_OBJECT, COMPACT_MARKERS):
        raise ValueError("Invalid planned translation output contract")
    config = AiConfig(
        api_key="" if is_local_target(provider_id, base_url) else (user_key or settings.ai_api_key),
        user_key=bool(user_key), provider=provider_id,
        model=str(provider.get("model") or "auto").strip() or "auto", base_url=base_url,
        thinking=str(provider.get("thinking") or "off").strip().lower() or "off",
        model_capabilities=normalize_model_capabilities(provider.get("modelCapabilities")),
        workload=normalize_workload(payload.get("workload")),
        output_contract=planned_contract,
        prompt_editable=prompt,
        prompt_mode=prompt_mode,
        glossary=memory.get("glossary") if isinstance(memory.get("glossary"), list) else [],
        characters=memory.get("characters") if isinstance(memory.get("characters"), list) else [],
        char_memory=bool(memory.get("enabled")) or bool(memory.get("characters")),
        series_state=str(memory.get("seriesState") or "").strip(),
        prev_context=(memory.get("previousContext")
                      if isinstance(memory.get("previousContext"), list) else []),
        repair_reason=("wrong_target_script" if isinstance(payload.get("repair"), dict)
                       and payload["repair"].get("reason") == "wrong_target_script" else ""),
        repair_enabled=not ai_request.extension_owns_repair(payload),
    )
    data_uri = str((payload.get("image") or {}).get("dataUri") or "").strip()
    if data_uri:
        config.image_b64 = _normalized_image(data_uri)
        config.image_mime = "image/jpeg"
    return config

def _normalized_image(data_uri: str) -> str:
    try:
        header, encoded = data_uri.split(",", 1)
        if not header.startswith("data:image/") or ";base64" not in header:
            raise ValueError("image must be a base64 image data URI")
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > MAX_IMAGE_BYTES:
            raise ValueError("page image is too large")
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as src:
            rgba = src.convert("RGBA")
            white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            src = Image.alpha_composite(white, rgba).convert("RGB")
            src.thumbnail((1280, 1280))
            out = io.BytesIO()
            src.save(out, format="JPEG", quality=68, optimize=True)
        return base64.b64encode(out.getvalue()).decode("ascii")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"invalid page image: {exc}") from exc
