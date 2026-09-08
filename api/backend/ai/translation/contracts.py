"""Translation invocation data contracts."""

from dataclasses import dataclass, field
from typing import Any, TypedDict

@dataclass
class AiConfig:
    api_key: str
    user_key: bool = False
    model: str = "auto"
    provider: str = "auto"
    base_url: str = "auto"
    prompt_editable: str = ""
    prompt_mode: str | None = None
    glossary: list = field(default_factory=list)
    characters: list = field(default_factory=list)
    char_memory: bool = False
    send_image: bool | str = False
    image_b64: str = ""
    image_mime: str = "image/jpeg"
    thinking: str = "off"
    model_capabilities: dict = field(default_factory=dict)
    workload: dict = field(default_factory=dict)
    output_contract: str = ""
    # A page owns exactly one provider generation.  Incomplete attributable
    # output is surfaced as a partial result; production never spends a second
    # hidden request trying to repair it.
    repair_reason: str = ""
    repair_enabled: bool = False
    series_state: str = ""
    speakers: dict = field(default_factory=dict)
    prev_context: list = field(default_factory=list)
    context_frozen: bool = False

class AiResult(TypedDict):
    aiTextFull: str
    meta: dict[str, Any]
