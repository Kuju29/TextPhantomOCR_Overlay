from backend.ai.prompts.source_context import normalize_source_context
from backend.ai.prompts.context import normalize_page_context
from backend.ai.workload import normalize_workload
from backend.ai.capabilities import SCHEMA_OBJECT, COMPACT_MARKERS
"""Validate and normalize API translation requests."""

import base64, io

from backend.ai.translation.contracts import AiConfig
from backend.ai.rate_policy import is_local_target
from backend.application import ai_request
from backend.ai.credentials import request_api_key
from backend.ai.provider_resolution import normalize_model_capabilities
from backend.ai.reasoning_preference import normalize_reasoning_preference

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
    if "mode" in memory and memory["mode"] not in ("off", "terms", "full"):
        raise ValueError("Invalid story memory mode")
    if "styleExamples" in memory and not isinstance(memory["styleExamples"], bool):
        raise ValueError("styleExamples must be boolean")
    user_key = str(provider.get("apiKey") or "").strip()
    provider_id = str(provider.get("id") or "auto").strip() or "auto"
    base_url = str(provider.get("baseUrl") or "auto").strip() or "auto"
    prompt_mode = "replace"
    prompt = str(payload.get("prompt") or "").strip()
    planned_contract = provider.get("outputContract", "")
    if not isinstance(planned_contract, str) or planned_contract not in ("", SCHEMA_OBJECT, COMPACT_MARKERS):
        raise ValueError("Invalid planned translation output contract")
    from backend.ai.translation_paths.mode import mode, descriptor
    selected_mode = mode(payload.get("translationMode"))
    conversation = descriptor(payload.get("conversation"), context=payload.get("context"))
    if selected_mode == "conversation" and conversation.get("origins"):
        from backend.ai.translation_paths.origins import validate_source_order
        source_ids = [u.get("id") if isinstance(u, dict) else None for u in (payload.get("units") or [])]
        validate_source_order(conversation["origins"], source_ids)
    if isinstance(payload.get("repair"), dict) and payload["repair"].get("branch") == "repair":
        conversation["branch"] = "repair"
    config = AiConfig(
        translation_mode=selected_mode, conversation=conversation,
        api_key=request_api_key(provider_id, base_url, user_key),
        user_key=bool(user_key) and not is_local_target(provider_id, base_url), provider=provider_id,
        model=str(provider.get("model") or "auto").strip() or "auto", base_url=base_url,
        thinking=normalize_reasoning_preference(provider.get("thinking"), "off"),
        model_capabilities=normalize_model_capabilities(provider.get("modelCapabilities")),
        workload=normalize_workload(payload.get("workload")),
        output_contract=planned_contract,
        prompt_editable=prompt,
        prompt_mode=prompt_mode,
        glossary=memory.get("glossary") if isinstance(memory.get("glossary"), list) else [],
        characters=memory.get("characters") if isinstance(memory.get("characters"), list) else [],
        char_memory=bool(memory.get("enabled")) or bool(memory.get("characters")),
        memory_mode=memory.get("mode") if memory.get("mode") in ("off", "terms", "full") else None,
        style_examples=memory.get("styleExamples", True) is not False,
        series_state=str(memory.get("seriesState") or "").strip(),
        prev_context=(memory.get("previousContext")
                      if isinstance(memory.get("previousContext"), list) else []),
        source_lang=str(payload.get("sourceLang") or ""),
        source_context=normalize_source_context(payload.get("sourceContext"), payload.get("units"),
            wire_ids=([uid for origin in conversation["origins"] for uid in origin["unitIds"]]
                      if selected_mode == "conversation" and conversation.get("origins") else None)),
        page_context=normalize_page_context(payload.get("pageContext"), payload.get("units")),
        repair_reason=("wrong_target_script" if isinstance(payload.get("repair"), dict)
                       and payload["repair"].get("reason") == "wrong_target_script" else ""),
        repair_enabled=not ai_request.extension_owns_repair(payload),
    )
    if config.memory_mode is not None:
        if config.memory_mode == "off":
            config.glossary = []
        if config.memory_mode != "full":
            config.characters = []; config.series_state = ""; config.speakers = {}; config.prev_context = []
        config.char_memory = config.memory_mode == "full"
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
