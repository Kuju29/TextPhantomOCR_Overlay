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

# Hidden reasoning shares the completion ceiling with the visible answer.
# A reasoning cap keeps at least ANSWER_FLOOR_TOKENS and two thirds of the
# completion for the translated lines, never exceeds REASONING_CAP_MAX_TOKENS
# (the 4096-token reasoning reserve below is the most the estimate ever adds;
# half of it is ample for translation), and never goes below the smallest
# budget providers accept for an enabled thinking mode.
REASONING_CAP_MIN_TOKENS = 256
REASONING_CAP_MAX_TOKENS = 2048
REASONING_CAP_SHARE_DIVISOR = 3
ANSWER_FLOOR_TOKENS = 768
REASONING_RESERVE_MAX_TOKENS = 4096


def reasoning_reserve(units: int, prompt_chars: int) -> int:
    """Completion tokens the estimate adds for hidden reasoning."""
    return min(REASONING_RESERVE_MAX_TOKENS, 768 + max(1, int(units)) * 128 + int(int(prompt_chars) * 0.04))


def reasoning_token_cap(completion_budget: int) -> int:
    """Bound for a provider's reasoning-budget field, derived from the same
    completion budget output_token_budget produced (answer + reasoning
    reserve). Used only where the provider has a real token-budget control."""
    total = int(completion_budget)
    return max(REASONING_CAP_MIN_TOKENS,
               min(REASONING_CAP_MAX_TOKENS, total // REASONING_CAP_SHARE_DIVISOR, total - ANSWER_FLOOR_TOKENS))

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
    hidden = reasoning_reserve(units, prompt_chars) if reasoning else 0
    return max(1024, min(int(ceiling), answer_reserve + hidden))

__all__ = ["ANSWER_FLOOR_TOKENS", "DEFAULT_GENERATION", "GenerationDefaults", "REASONING_CAP_MAX_TOKENS",
           "REASONING_CAP_MIN_TOKENS", "output_token_budget", "reasoning_reserve", "reasoning_token_cap"]
