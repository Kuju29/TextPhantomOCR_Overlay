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
        "CONTEXT / ORDER: Use the given <<TP_Pn>> order as the "
        "bubble/panel reading order; never reorder markers. Use nearby previous/next markers to infer the scene, "
        "emotion, speaker relationship, repeated names and terminology.\n"
        "PRONOUN-DROP (very important): Thai naturally omits subjects and objects — the listener knows who is meant from "
        "context. Even when the source says I / you / he / she, DROP the pronoun. Do NOT use ผม / ฉัน / ข้า / หนู / นาย / "
        "เธอ / คุณ / เจ้า unless the line is meaningless without it. When a reference is truly needed, use the character's "
        "name, role or title (ท่านผู้กล้า, หัวหน้ากิลด์) instead of a pronoun. Example: 'I won't forgive you!' -> "
        "ไม่ยกโทษให้แน่!! (no pronoun at all).\n"
        "THIRD PERSON is DIFFERENT: Thai manga freely uses มัน (enemies, monsters, things, contempt), พวกมัน, "
        "หมอนั่น, เจ้านั่น, ไอ้หมอนี่, ยัยนั่น — use them to carry attitude instead of dropping everything: "
        "'He's coming!' (enemy) -> มันมาแล้ว!!, 'Don't underestimate him' -> อย่าดูถูกหมอนั่นเชียว. These describe the "
        "person being TALKED ABOUT, not the speaker, so they are always safe even when the speaker's gender is "
        "unknown.\n"
        # NOTE: the gendered-speech rule (ครับ/ค่ะ) is NOT part of this
        # user-editable style — build_system_text() appends it as a fixed
        # block chosen by ``has_image`` (vision may use gendered words,
        # text-only may not), so user prompt edits cannot break it.
        "CONVERSATION FLOW: Treat consecutive markers as one conversation. For each line decide: is it a REPLY to the "
        "previous line, the same speaker continuing, an inner thought, or narration — and translate it that way. A reply "
        "must connect naturally to the previous line's Thai (รับคำ, สวนกลับ, เออออ, ปัดตก), not stand alone like a fresh "
        "sentence.\n"
        "SHORT REPLIES / INTERJECTIONS (very important): yes / no / huh / eh / well / right / I see are FUNCTION words — "
        "translate what the word DOES in this exchange, never the dictionary word. A bare ใช่ / ไม่ fits only a direct "
        "fact-question; most of the time Thai says something else:\n"
        "  yes (casual agreement) -> อือ / เออ / อืม / ได้ / ใช่เลย ; yes (accepting an order/request) -> รับทราบ / ได้เลย / "
        "ตามนั้น ; Yes? (answering a call) -> ห๊ะ? / หืม? / ว่าไง?\n"
        "  no (refusing) -> ไม่เอา / ไม่มีทาง / ไม่หรอก / ไม่ล่ะ ; no (denying an assumption) -> เปล่า / เปล่านะ / เปล่าซะหน่อย ; "
        "no way! -> ไม่จริงน่า! / เป็นไปไม่ได้!\n"
        "  huh? / eh? -> ห๊ะ? / หา? / เอ๋? ; well... / um -> เอ่อ... / ก็... / อืม... ; I see / oh -> อ๋อ / งั้นเหรอ / อย่างนี้นี่เอง ; "
        "right / yeah -> นั่นสิ / ก็จริง / นั่นแหละ\n"
        "  Pick the ONE that fits the previous line and the speaker's mood — a wrong ใช่/ไม่ here reads as machine "
        "translation instantly.\n"
        "WORDPLAY / IDIOMS (very important): Never carry a source-language pun or idiom into Thai literally — a joke that "
        "only works in English/Japanese must NOT become a weird word-for-word Thai line. First extract the intent (ขำ, แซว, "
        "เหน็บ, มุกฝืด, เล่นเสียง), then write Thai that lands the same way: use a Thai pun if one comes naturally, "
        "otherwise a plain punchy line with the same feeling. Idioms translate by meaning, not by words. Examples:\n"
        "  Source: This quest is a piece of cake! -> Thai: เควสต์นี้ง่ายจะตาย! (idiom by meaning)\n"
        "  Source: You're un-BEAR-able! (bear pun) -> Thai: เหลือทนจริงๆเลยนะเจ้าหมีเนี่ย!! (keep the bear + the annoyance, drop the untranslatable pun)\n"
        "  Source: Long time no sea. (sea pun) -> Thai: ไม่เจอกันนานเลยนะ~ (no natural Thai pun -> plain natural line)\n"
        "  Never leave a pun translated word-for-word so it reads as nonsense in Thai.\n"
        "PARTICLES / TONE: Match the particle to the REGISTER and the EMOTION, not just politeness — a flat polite "
        "line for an angry character reads as machine translation instantly. Soft/neutral: นะ, สิ, ล่ะ, เถอะ, เลย, "
        "แล้ว, เหรอ, รึเปล่า, เนี่ย, นั่นแหละ. Rough/heated (fights, rivals, thugs, shouting, cursing — all "
        "gender-neutral, USE them): วะ, ว่ะ, โว้ย, เว้ย, ...ซะที, ...ชะมัด, โคตร..., บ้าเอ๊ย, ให้ตายสิ, เวรเอ๊ย, ไอ้เวรนี่. "
        "Keep each character's register (polite staff vs casual friends vs thugs vs inner thoughts) stable across "
        "the page.\n"
        "TERMINOLOGY (สถานที่ / ไอเทม / สกิล / ท่า / ฉายา) — decide per term which of Thai scanlators' two habits fits, "
        "then NEVER mix styles for that term again:\n"
        "  (a) ทับศัพท์ for established gaming/isekai loanwords every Thai manga reader already knows — do NOT translate "
        "these into odd Thai: เควสต์, กิลด์, ปาร์ตี้, ดันเจี้ยน, สกิล, เลเวล, ไอเทม, บอส, มอนสเตอร์, สเตตัส, มานา, คลาส, "
        "เมจ, ฮีลเลอร์, แทงค์, ดรอป, โซโล่. Keep Latin letters only for ranks/grades/stats: แรงค์ E, เกรด S, HP, MP. "
        "Otherwise NO raw English words left in a bubble.\n"
        "  (b) แปลเป็นไทยแนวแฟนตาซี for descriptive terms — words that SAY what the thing is must read as real Thai, not "
        "a forced transliteration: magic stone -> หินเวทมนตร์, magic power -> พลังเวท, adventurer -> นักผจญภัย, "
        "holy sword -> ดาบศักดิ์สิทธิ์, demon lord -> จอมมาร, hero -> ผู้กล้า, knight order -> อัศวิน, appraisal -> "
        "ตรวจสอบ/ประเมิน.\n"
        "  SKILL / TECHNIQUE NAMES (ท่า, เวท): if the source styles it as English/katakana, transliterate and keep it "
        "flashy (Fireball -> ไฟร์บอล, Excalibur -> เอ็กซ์คาลิเบอร์); if the name is built from meaning (kanji-style), "
        "translate into a COOL compact Thai name, not a literal gloss (火炎斬 -> ดาบเพลิงพิฆาต, ไม่ใช่ 'การฟันไฟเปลวเพลิง'). "
        "A shouted move name must still sound shoutable in Thai.\n"
        "  PLACES: Thai class word + name: เหมืองอาชิลล์, หอคอยบาเบล, เมืองออร์เซล, ป่าเอลเวน. If the place name is "
        "meaningful, translating it is fine when it sounds natural: ป่าต้องห้าม, หุบเขามรณะ.\n"
        "  ORGANIZATIONS: translate the class word, keep the proper part: สมาคมดันเจี้ยน (Dungeon Association), "
        "กิลด์นักผจญภัย (Adventurer's Guild), อัศวินหลวง.\n"
        "  TITLES / EPITHETS (ฉายา): translate for impact, not word-by-word: Sword Saint -> เทพดาบ/จอมดาบ, "
        "The Strongest -> ผู้แข็งแกร่งที่สุด, Calamity -> ตัวหายนะ.\n"
        "  Rule of thumb: would a Thai scanlation reader instantly recognize the transliteration? -> ทับศัพท์. Does the "
        "word describe what the thing IS? -> translate. In doubt, prefer the shorter, more natural-sounding option and "
        "keep it consistent for the whole request.\n"
        "VOICE: Make dialogue sound like Thai people would actually write it in manga. Use natural contractions and idioms, "
        "but do not add new facts. Keep shouting, surprise and hesitation: !!, !?, ..., เอ๊ะ, อ่า, หะ, โธ่, เดี๋ยวนะ.\n"
        "CONSISTENCY: Within the same request, keep every character name, place, skill, item, race, title and catchphrase "
        "translated the same way. Do not switch synonyms randomly across nearby panels. If unsure, keep a short readable "
        "Thai transliteration. Examples: Gaia=ไกอา, Cardinal=คาร์ดินัล, Mithril=มิธริล.\n"
        "LENGTH: Translate the full meaning, but keep it compact for bubbles. Prefer one natural Thai sentence over a literal "
        "word-for-word line. Do not over-explain, do not summarize away important details.\n"
        "FINAL POLISH: Before answering, reread your Thai lines in order as ONE conversation. Any line that sounds "
        "like translated text instead of something a Thai character would actually say — rewrite it. How it SOUNDS "
        "matters more than word-for-word fidelity, as long as the meaning survives.\n"
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


IMAGE_HINT: Final[str] = (
    "PAGE IMAGE: The manga page image is attached. It is CONTEXT — seeing the original text in the bubbles is "
    "NOT a reason to translate more literally. Every style rule (wordplay, short replies, pronoun-drop, natural "
    "punchy dialogue) applies at FULL strength in image mode; write the polished line, do not transcribe.\n"
    "READING ORDER: Manga reads RIGHT to LEFT, top to bottom — panels and bubbles inside each panel. The "
    "<<TP_Pn>> order comes from OCR and may NOT match the true reading order. Match each paragraph to its bubble "
    "in the image, reconstruct the real conversation flow visually (who speaks first, who replies), and translate "
    "each line so it fits that flow. BUT your OUTPUT must still keep every <<TP_Pn>> marker exactly in the given "
    "order — reorder your understanding, never the markers.\n"
    "SPEAKERS: identify each speaker's gender, age and appearance, who is talking to whom, facial expressions "
    "and mood, and whether a line is a reply, a shout or an inner thought. Let this guide pronouns, particles "
    "and tone. Do not describe the image; output only the translation."
)


# Thai gendered-speech rule — appended by build_system_text() as a FIXED
# block (like the marker contract), never part of the user-editable style,
# picked by ``has_image``. Rationale: from text alone the model cannot tell
# WHICH character speaks a bubble, so guessing ครับ/ค่ะ is usually wrong —
# gendered speech is banned outright for text-only requests. With the page
# image attached the model can SEE the speaker, so gendered particles are
# allowed (register rules still apply). Living outside the editable prompt
# means user prompt edits cannot accidentally break this behaviour.
TH_GENDER_RULE_TEXT_ONLY: Final[str] = (
    "GENDERED SPEECH — FORBIDDEN (text-only request): You see only the text, so you CANNOT know which character "
    "is speaking a given bubble or their gender. NEVER use gendered words: no ครับ / ค่ะ / คะ / นะคะ / ครับผม / ฮะ, "
    "no ผม / ดิฉัน / หนู. Even if the CHARACTER SHEET lists genders, do NOT add gendered particles in this request — "
    "you still cannot match bubbles to speakers. When the register is truly formal/service, stay polite the neutral "
    "way: ขอ... / เชิญ... / โปรด..., softening endings นะ / ด้วยนะ / เลยนะ / ล่ะ / เถอะ — e.g. "
    "ขอแสดงความยินดีกับการพิชิตบอสอีกครั้งนะ / ทางกิลด์ขอมอบบัตรแรงค์ D ให้นะ. A polite yes/reply is NOT automatically "
    "ครับ/ค่ะ either — render it neutrally: 'Yes, milord' -> รับทราบ / ได้เลยท่าน, 'Yes' (to an order) -> รับทราบ / ตามนั้น. "
    "Most manga dialogue is casual and needs no particle at all. This ban covers ONLY speaker-gender markers — "
    "rough gender-neutral speech (มัน, พวกมัน, หมอนั่น, วะ, ว่ะ, โว้ย, เว้ย) and full emotion are still required "
    "where the scene calls for them; do NOT flatten the dialogue."
)

TH_GENDER_RULE_WITH_IMAGE: Final[str] = (
    "GENDERED PARTICLES — two SEPARATE decisions, in this order:\n"
    "  (1) Does this line need a polite particle AT ALL? Only formal/service register does: receptionist to customer, "
    "servant to master, subordinate to lord, polite strangers. Casual talk between friends / party members, family, "
    "rivals, shouting, combat and inner thoughts take NO ครับ / ค่ะ — and that is MOST manga dialogue. When in doubt: "
    "no particle.\n"
    "  (2) Only if the register truly calls for one, pick ครับ vs ค่ะ/คะ from who is ACTUALLY speaking: match each "
    "bubble to its character in the attached page image, confirm with the CHARACTER SHEET. Knowing a character's "
    "gender is NOT a reason to add particles to casual lines. If the speaker is still unclear even with the image, "
    "stay polite without gender: ขอ... / เชิญ... / โปรด..., endings นะ / ด้วยนะ / เลยนะ / ล่ะ. A polite yes/reply may be a "
    "bare ครับ / ค่ะ on its own when the image clearly shows the speaker ('Yes, master' -> ค่ะ for a maid, ครับ for a "
    "butler)."
)


CHARACTER_MEMO_INSTRUCTION: Final[str] = (
    "After the LAST paragraph, append one final block that starts with <<TP_MEMO>> on its own line. "
    "In it list each named character who speaks or is addressed on this page, ONE per line, format:\n"
    "Name | gender: male/female/unknown | speech: how they talk in the target language "
    "(e.g. ข้า/เจ้า หยาบๆ, สุภาพ ค่ะ, ห้วนๆ) | note: role/relationship\n"
    "Only include what the text (and image, if attached) actually reveals; do not guess. "
    "Max 8 lines. If nothing is known, output <<TP_MEMO>> followed by the word none."
)


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


def build_character_block(
    characters: list[dict] | None, limit: int = 30, has_image: bool = False
) -> str:
    """Render the accumulated per-series character sheet for the prompt.

    ``characters`` is a list of ``{"name", "gender", "speech", "note"}`` dicts
    the client accumulated from earlier pages (via the ``<<TP_MEMO>>`` block).
    This is what lets the model keep pronouns / particles / register right for
    each character the way a human scanlator who has read earlier chapters
    would.  Returns ``""`` when there is nothing usable.
    """
    if not characters:
        return ""
    lines: list[str] = []
    for c in characters[-limit:]:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        bits = [name]
        for key in ("gender", "speech", "note"):
            val = str(c.get(key) or "").strip()
            if val:
                bits.append(f"{key}: {val}")
        lines.append("  - " + " | ".join(bits))
    if not lines:
        return ""
    if has_image:
        tail = (
            "\nUse it to keep each speaker's voice stable. The sheet only tells you WHICH form to use "
            "(ครับ vs ค่ะ, ผม vs ฉัน) when the line's register ALREADY calls for polite/gendered speech — "
            "it is NOT a reason to add ครับ/ค่ะ or pronouns to casual lines. Casual dialogue stays casual "
            "and particle-free even for characters whose gender is listed here."
        )
    else:
        tail = (
            "\nUse it for names, personality, speech style and register consistency ONLY. This request has "
            "no page image, so bubbles cannot be matched to speakers — do NOT use the listed genders to add "
            "ครับ/ค่ะ or gendered pronouns; gendered speech stays disabled for text-only requests."
        )
    return (
        "CHARACTER SHEET (accumulated from earlier pages of this series — treat as ground truth):\n"
        + "\n".join(lines)
        + tail
    )


def build_system_text(
    lang: str,
    prompt_override: str = "",
    is_retry: bool = False,
    glossary: list[dict] | None = None,
    characters: list[dict] | None = None,
    has_image: bool = False,
    want_memo: bool = True,
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
    # Thai gender rule is a FIXED block (applies even with a custom prompt):
    # vision -> gendered particles allowed (register rules still apply),
    # text-only -> strictly gender-neutral (speaker cannot be identified).
    gender_block = ""
    if _normalize_lang(lang) == "th":
        gender_block = TH_GENDER_RULE_WITH_IMAGE if has_image else TH_GENDER_RULE_TEXT_ONLY
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
    if want_memo:
        contract.append(CHARACTER_MEMO_INSTRUCTION)
    glossary_block = build_glossary_block(glossary)
    character_block = build_character_block(characters, has_image=has_image)
    image_block = IMAGE_HINT if has_image else ""
    parts = [
        SYSTEM_BASE.strip(),
        style,
        gender_block,
        image_block,
        character_block,
        glossary_block,
        "\n".join(contract),
    ]
    return "\n\n".join(p for p in parts if p)


def build_user_parts(original_text_full: str) -> list[str]:
    """Return the user-message blocks for a translation request.

    Only the source text is sent — no Lens MT reference — so input stays
    small and the model translates from the original.
    """
    return ["Source (translate this):\n" + str(original_text_full or "")]
