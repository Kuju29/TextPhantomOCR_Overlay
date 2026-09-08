"""Provider-neutral generation defaults.

This module intentionally contains no provider or model names.  Wire-level
options belong to the adapter that owns that provider contract.
"""

from __future__ import annotations

from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class GenerationDefaults:
    """Common fallback limits used when an adapter has no stricter setting."""

    temperature: float = 0.7
    max_output_tokens: int = 8192
    timeout_sec: float = 120.0

    def __post_init__(self) -> None:
        if not 0.0 <= self.temperature <= 2.0:
            raise ValueError("temperature must be between 0 and 2")
        if self.max_output_tokens <= 0:
            raise ValueError("max_output_tokens must be positive")
        if self.timeout_sec <= 0:
            raise ValueError("timeout_sec must be positive")

DEFAULT_GENERATION = GenerationDefaults()

def output_token_budget(
    user_parts: tuple[str, ...] | list[str],
    system_text: str = "",
    *,
    reasoning: bool = False,
    unit_count: int | None = None,
    ceiling: int = DEFAULT_GENERATION.max_output_tokens,
) -> int:
    """Return the existing provider-neutral multilingual output estimate."""

    chars = sum(len(str(part or "")) for part in user_parts)
    prompt_chars = len(str(system_text or ""))
    units = max(
        1,
        int(unit_count or len([part for part in user_parts if str(part or "").strip()])),
    )
    answer_reserve = int(chars * 2.2) + units * 112 + 384
    reasoning_reserve = (
        min(4096, 768 + units * 128 + int(prompt_chars * 0.04))
        if reasoning
        else 0
    )
    return max(1024, min(int(ceiling), answer_reserve + reasoning_reserve))

__all__ = ["DEFAULT_GENERATION", "GenerationDefaults", "output_token_budget"]
