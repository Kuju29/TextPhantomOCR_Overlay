"""Reason-specific repair instructions; saved user Style remains unchanged."""
from .instruction_packs import instruction_pack

def wrong_language_repair_instruction(target_instruction: str, reason: str = "", *, lang="en") -> str:
    return instruction_pack(lang)["repair"].format(target=target_instruction) if reason == "wrong_target_script" else ""
