"""Native account model metadata, never API price tables."""
from . import login_native as native
from .login_provider_registry import LoginError

def capabilities(meta):
    caps = {"structured_output": {"supported": False}}
    modalities = meta.get("supportedInputModalities")
    if not isinstance(modalities, list) and type(meta.get("supportsImages")) is bool:
        modalities = ["text", "image"] if meta["supportsImages"] else ["text"]
    if isinstance(modalities, list):
        caps["vision"] = {"supported": "image" in [str(x).lower() for x in modalities], "source": "login_channel_metadata"}
    limits = {}
    for source, dest in (("context_length", "contextTokens"), ("inputTokenLimit", "maxInputTokens"), ("max_completion_tokens", "maxOutputTokens"), ("outputTokenLimit", "maxOutputTokens")):
        n = meta.get(source)
        if type(n) is int and n > 0:
            limits[dest] = n
    if limits:
        caps["limits"] = limits
    thinking = meta.get("thinking")
    if "thinking" not in meta and meta.get("supportsThinking") is False:
        thinking = None
        meta = {**meta, "thinking": None}
    if isinstance(thinking, dict):
        levels = thinking.get("levels")
        off = thinking.get("zero_allowed") is True or (isinstance(levels, list) and "none" in levels)
        if isinstance(levels, list) and levels:
            caps["reasoning"] = {"supported": True, "control": "levels", "mandatory": not off, "can_disable": off,
                "supported_efforts": list(dict.fromkeys((["none"] if off else []) + levels))}
        elif type(thinking.get("min")) is int and type(thinking.get("max")) is int and 0 <= thinking["min"] <= thinking["max"]:
            caps["reasoning"] = {"supported": True, "control": "levels", "mandatory": not off, "can_disable": off,
                "supported_efforts": (["none"] if off else [])+["minimal", "max"]}
    elif "thinking" in meta and thinking is None:
        caps["reasoning"] = {"supported": False}
    return caps

def model_list(session):
    rows = native.models(session)
    if not isinstance(rows, list) or len(rows) > 1000:
        raise LoginError("login_provider_contract", "AI Login model catalogue is invalid", 503)
    return rows

def public_models(rows):
    return [{key: value for key, value in row.items() if not key.startswith("_")} for row in rows]

def native_model(identifier, name, meta):
    import re
    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", identifier):
        return None
    outputs = meta.get("supportedOutputModalities")
    if isinstance(outputs, list):
        if "text" not in [str(x).lower() for x in outputs]:
            return None
    elif any(x in identifier.lower() for x in ("image", "embedding", "audio", "tts", "whisper", "sora")):
        return None
    return {"id": identifier, "name": str(name or identifier)[:160], "model_capabilities": capabilities(meta), "_metadata": meta}
