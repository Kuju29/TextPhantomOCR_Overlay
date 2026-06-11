"""Prompt templates and language-specific style hints for AI translation.

Two design choices that keep the prompt small (= faster, cheaper):

- We send only the *source* text — no Lens machine-translation reference
  block.  The model translates from the original, which gives a more natural
  result than "improve on the MT" and saves a large amount of input tokens.
- The system text is a few short sentences plus a per-language style block.
  Most rules are *positive* ("write natural manga dialogue") rather than
  exhaustive negative lists.
"""

from __future__ import annotations

from typing import Final

from backend.lens.languages import normalize as _normalize_lang


SYSTEM_BASE: Final[str] = (
    "You are a professional manga scanlation translator.\n"
    "Translate each paragraph into natural, in-character dialogue suitable for a speech bubble.\n"
    "Preserve meaning, tone, emotion and emphasis. Do not add information. Do not explain.\n"
    "Keep names, terms and SFX consistent."
)


LANG_STYLE: Final[dict[str, str]] = {
    # Thai — compact but strongly opinionated for manga scanlation.
    # Keep this block target-only so it does not bloat non-Thai calls.
    "th": (
        "Target language: Thai (ภาษาไทย)\n"
        "Write like a polished Thai manga scanlation, not like machine translation: natural spoken Thai, "
        "in-character, punchy, easy to fit in speech bubbles, and faithful to the source meaning.\n"
        "CONTEXT / ORDER: You see only text, not the page image. Use the given <<TP_Pn>> order as the "
        "bubble/panel reading order; never reorder markers. Use nearby previous/next markers to infer the scene, "
        "emotion, speaker relationship, repeated names and terminology.\n"
        "PRONOUN-DROP (very important): Thai naturally omits subjects and objects — the listener knows who is meant from "
        "context. Even when the source says I / you / he / she, DROP the pronoun. Do NOT use ผม / ฉัน / ข้า / หนู / นาย / "
        "เธอ / คุณ / เจ้า unless the line is meaningless without it. When a reference is truly needed, use the character's "
        "name, role or title (ท่านผู้กล้า, หัวหน้ากิลด์) instead of a pronoun. Example: 'I won't forgive you!' -> "
        "ไม่ยกโทษให้แน่!! (no pronoun at all).\n"
        "NO GENDERED PARTICLES: You cannot see the speaker, so you cannot know their gender. NEVER use ครับ / ค่ะ / คะ. "
        "Express politeness without gender instead: polite verbs ขอ... / เชิญ... / โปรด..., softening endings นะ / ด้วยนะ / "
        "เลยนะ / ล่ะ. A polite receptionist line stays polite without particles: ขอแสดงความยินดีกับการพิชิตบอสอีกครั้งนะ / "
        "ทางกิลด์ขอมอบบัตรแรงค์ D ให้นะ.\n"
        "PARTICLES / TONE: Carry emotion with gender-neutral endings only: นะ, สิ, ล่ะ, เถอะ, เลย, แล้ว, เหรอ, รึเปล่า, "
        "เนี่ย, นั่นแหละ. Keep each character's register (polite staff vs casual friends vs inner thoughts) stable across "
        "the page.\n"
        "TRANSLITERATION (ทับศัพท์): Game/fantasy terms and proper nouns usually read best transliterated, the way Thai "
        "scanlations do: เควสต์ (quest), กิลด์ (guild), แรงค์ B (rank B), ดันเจี้ยน, บอส, มอนสเตอร์, สกิล, ไอเทม, เลเวล, "
        "ปาร์ตี้, โซโล่, เมจ, ฮีลเลอร์. Keep Latin letters for ranks/grades (แรงค์ D, เกรด S). For named places combine a "
        "Thai class word + transliterated name: เหมืองอาชิลล์ (Achille Mine), หอคอยบาเบล. Translate into real Thai when a "
        "natural word exists and fits the world: อัศวิน, ผู้กล้า, จอมมาร, ดาบศักดิ์สิทธิ์, เหมือง. Choose per term — "
        "literal, transliterated, or light wordplay to match the character and the moment — then keep that choice "
        "consistent for the whole request.\n"
        "VOICE: Make dialogue sound like Thai people would actually write it in manga. Use natural contractions and idioms, "
        "but do not add new facts. Keep shouting, surprise and hesitation: !!, !?, ..., เอ๊ะ, อ่า, หะ, โธ่, เดี๋ยวนะ.\n"
        "CONSISTENCY: Within the same request, keep every character name, place, skill, item, race, title and catchphrase "
        "translated the same way. Do not switch synonyms randomly across nearby panels. If unsure, keep a short readable "
        "Thai transliteration. Examples: Gaia=ไกอา, Cardinal=คาร์ดินัล, Mithril=มิธริล.\n"
        "LENGTH: Translate the full meaning, but keep it compact for bubbles. Prefer one natural Thai sentence over a literal "
        "word-for-word line. Do not over-explain, do not summarize away important details.\n"
        "Style anchors from Thai manga scanlation examples; imitate the rhythm, not the exact text:\n"
        "  - ตั้งโล่ทั้งหมดกลับมาไม่ทันแน่!!\n"
        "  - จะทำเหมือนน้ำ...\n"
        "  - นี่คือมังกรที่แข็งแกร่งที่สุด แม้แต่เทพก็ยังกลืนกินได้ จงหวาดกลัวและหมอบกราบ\n"
        "  - ไอ้เวรนี่ น่ารำคาญไม่เปลี่ยนเลยจริงๆ!!\n"
        "  - อ่า!! คิดว่าจะยอมแพ้ง่ายๆหรือไง\n"
        "  - มอนสเตอร์ที่เคยเจอมาจนถึงตอนนี้เทียบไม่ได้เลยสักนิด...\n"
        "  - วางใจเถอะ วางแผนไว้หมดแล้ว\n"
        "  - เดี๋ยวนะ... ไอ้ที่บอกว่าให้หยุดเนี่ย อย่าบอกนะว่าให้หยุดสิ่งนั้นน่ะ?\n"
        "  - เท่านี้ก็สามารถรับงานแรงค์ B ได้ตั้งแต่เริ่มเลย!\n"
        "  - ขอรับเควสต์ที่ดันเจี้ยนเหมืองอาชิลล์\n"
        "  - ทางกิลด์ขอมอบบัตรแรงค์ D ให้นะ\n"
        "Mini conversion examples (note: no pronouns, no ครับ/ค่ะ):\n"
        "  Source: I won't make it in time! -> Thai: ไม่ทันแน่!!\n"
        "  Source: Are you really not going to change? -> Thai: ไม่คิดจะเปลี่ยนเลยจริงๆสินะ\n"
        "  Source: Please forgive us, brave hero. -> Thai: ขอร้องล่ะ ท่านผู้กล้า โปรดยกโทษให้ด้วยเถอะ\n"
        "  Source: So that monster was part of your plan? -> Thai: งั้นมอนสเตอร์ตัวนั้นก็อยู่ในแผนเหมือนกันสินะ?\n"
        "  Source: I'd like to take the quest at the Achille Mine dungeon. -> Thai: ขอรับเควสต์ที่ดันเจี้ยนเหมืองอาชิลล์\n"
        "  Source (receptionist): Congratulations on defeating the boss again! -> Thai: ขอแสดงความยินดีกับการพิชิตบอสอีกครั้งนะ"
    ),
    "en": (
        "Target language: English\n"
        "Write natural English manga dialogue: concise, conversational, with contractions where they fit.\n"
        "Match the character's voice; keep emotion and emphasis."
    ),
    "ja": (
        "Target language: Japanese\n"
        "Write natural Japanese manga dialogue: concise, spoken.\n"
        "Match 丁寧語/タメ口 to the speaker; keep emotion, emphasis and SFX natural."
    ),
    "zh": (
        "Target language: Chinese (中文)\n"
        "Write natural Chinese manga dialogue: spoken, in-character, concise.\n"
        "Match the speaker's register (formal / casual); keep emotion and emphasis."
    ),
    "ko": (
        "Target language: Korean (한국어)\n"
        "Write natural Korean manga dialogue: spoken, in-character, concise.\n"
        "Match the speech level (반말 / 존댓말) to the character and listener; keep emotion and emphasis."
    ),
    "id": (
        "Target language: Indonesian\n"
        "Write natural Indonesian manga dialogue: concise, conversational, easy to read in a speech bubble.\n"
        "Use everyday Indonesian unless the source clearly calls for a formal register."
    ),
    "default": (
        "Write natural manga dialogue in the target language: spoken, in-character, faithful to meaning and tone."
    ),
}


RESPONSE_CONTRACT_TEXT: Final[str] = (
    "Return ONLY the translated text (no JSON, no markdown, no commentary).\n"
    "Preserve paragraph order. Paragraphs are separated by a blank line.\n"
    "Use actual newlines for line breaks. Never include code fences or HTML tags."
)


# Older JSON contract kept around for callers that opt into it.
RESPONSE_CONTRACT_JSON: Final[str] = (
    'Return ONLY valid JSON (no markdown).  Output JSON has exactly one key: "aiTextFull".\n'
    '"aiTextFull" is a single JSON string. Use literal \\n and \\n\\n for line breaks; '
    "no raw newlines.  Preserve paragraph boundaries and order."
)


def lang_style(lang: str) -> str:
    """Return the style snippet for ``lang``, falling back to the default."""
    code = _normalize_lang(lang)
    return (LANG_STYLE.get(code) or LANG_STYLE["default"]).strip()


def build_glossary_block(glossary: list[dict] | None, limit: int = 40) -> str:
    """Render a short glossary / translation-memory block for the prompt.

    ``glossary`` is a list of ``{"src": ..., "tgt": ...}`` pairs collected from
    the user's recent translations (across multiple images in one session).
    Injecting them keeps terminology and names consistent from page to page —
    the same role a human scanlator's term sheet plays.

    Only the most recent ``limit`` unique source terms are kept so the prompt
    stays small.  Returns ``""`` when there is nothing usable.
    """
    if not glossary:
        return ""
    seen: set[str] = set()
    lines: list[str] = []
    for entry in reversed(glossary):  # most-recent first
        if not isinstance(entry, dict):
            continue
        src = str(entry.get("src") or "").strip()
        tgt = str(entry.get("tgt") or "").strip()
        if not src or not tgt or src in seen:
            continue
        seen.add(src)
        lines.append(f"  - {src} → {tgt}")
        if len(lines) >= limit:
            break
    if not lines:
        return ""
    lines.reverse()  # restore chronological order for readability
    return (
        "Translation memory (keep these consistent with earlier pages — "
        "use the SAME target wording for the SAME source term):\n"
        + "\n".join(lines)
    )


def build_system_text(
    lang: str,
    prompt_override: str = "",
    is_retry: bool = False,
    glossary: list[dict] | None = None,
) -> str:
    """Build the system prompt that gets prepended to every AI call.

    The contract section enforces the ``<<TP_Pn>>`` marker protocol used by
    :mod:`backend.ai.markers`.  When ``is_retry`` is True we add an extra
    line instructing the model to emit ALL markers.  ``glossary`` (optional)
    is a list of recent ``{"src","tgt"}`` pairs injected as a translation
    memory so multi-image batches stay consistent.

    The model only ever sees the source text (no machine-translation
    reference), which keeps input tokens small.
    """
    style = (prompt_override or "").strip() or lang_style(lang)
    contract: list[str] = [
        "Output ONLY the translated text (no JSON, no markdown, no extra commentary).",
        "Keep every paragraph marker like <<TP_P0>> exactly as it appears, in order.",
        "For each marker, output the marker followed by that paragraph's translated text.",
        "If the target is Thai, Japanese, Chinese or Korean, do NOT insert spaces between "
        "words of that script. A space is only OK between scripts (e.g. Thai + digits).",
    ]
    if is_retry:
        contract.append(
            "Retry: You MUST output ALL markers from the first to the last marker in the input."
        )
    glossary_block = build_glossary_block(glossary)
    parts = [SYSTEM_BASE.strip(), style, glossary_block, "\n".join(contract)]
    return "\n\n".join(p for p in parts if p)


def build_user_parts(original_text_full: str) -> list[str]:
    """Return the user-message blocks for a translation request.

    Only the source text is sent — no Lens MT reference — so input stays
    small and the model translates from the original.
    """
    return ["Source (translate this):\n" + str(original_text_full or "")]
