"""Prompt templates and language-specific style hints for AI translation.

Design choices:

- ONE editable prompt per language.  Everything about HOW to translate —
  including the gender policy — lives in the language style block the user
  can see and edit.  Only the mechanical marker contract and the image note
  stay fixed.
- The production Thai policy is short and principle-based.  Translation
  examples live in the offline regression corpus instead of every request, so
  they measure quality without anchoring the model to fixed wording.
- We send only the *source* text — no Lens machine-translation reference.
  The model translates from the original, which reads more natural and
  saves input tokens.
- Gender is EVIDENCE-based, never guessed: the accumulated CHARACTER SHEET
  (cache) and explicit text evidence are proof; the page image alone is only
  a hint, because manga art is ambiguous and models guess it wrong.
"""

from __future__ import annotations

import hashlib
from typing import Final

from backend.lens.languages import normalize as _normalize_lang


SYSTEM_BASE: Final[str] = (
    "You are a professional manga scanlation translator.\n"
    "Translate each paragraph into natural, in-character dialogue suitable for a speech bubble.\n"
    "Preserve meaning, tone, emotion and emphasis. Do not add information. Do not explain.\n"
    "Keep names, terms and SFX consistent."
)


LANG_STYLE: Final[dict[str, str]] = {
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


# Compact production policy. Real examples belong in the regression corpus,
# where they measure quality without anchoring requests to fixed phrasings.
THAI_STYLE_COMPACT: Final[str] = """Target language: Thai (ภาษาไทย)
Act as an experienced Thai manga editor, not a literal converter and not a creative co-writer. Read every source unit on the page before drafting. The finished page must be fluent, compact Thai while preserving the same story, speaker intent and emotional force as the source. Never explain the translation and never invent an event, motive, relationship or visual detail.

PRIORITY — meaning before decoration
1. Preserve the semantic core first: who does what to whom, names, ranks, numbers, objects, time, cause and effect, conditions, negation, comparison, certainty and information status. Preserve whether a claim is fact, guess, wish, warning, command, permission, promise, ability, obligation, inevitability or determination. A smooth line with altered scope or modal force is wrong.
2. Preserve the speech act and its strength. An answer, interruption, refusal, tease, threat, concession, accusation, request or hesitation must do the same job in the conversation. Do not turn a neutral statement into a jab, a possibility into certainty, concern into panic, or simple approval into emotional relief.
3. Use the least marked natural Thai wording that carries all of that meaning. Natural Thai does not mean adding more attitude. Do not add a connector, intensifier, secrecy, inevitability, completion, contrast, affection or hostility merely to make a line colourful. Words with those functions belong only when the source, neighbouring lines or trusted series context supplies that function. Naturalness must come from the main wording and Thai word order, not from a sentence-final tail.
4. Translate the thought, not the source word order. Move or omit an obvious subject, choose an active or passive shape that sounds natural, and join or split clauses mentally when Thai requires it. Before output, check that a reader translating the Thai meaning back would recover the same proposition and force, even though the syntax differs.

THAI EDITING POLICY
5. Prefer direct everyday Thai over abstract or roundabout emotional wording. Distinguish a positive result from relief after worry, reassurance from having a dependable ally, excitement about an experience, suspense while awaiting an uncertain result, and nervous tension. Do not substitute one emotion for another because the words are vaguely related. Do not add an inward or hidden nuance unless it is actually present.
6. Keep modality economical and exact. Plain obligation should remain plain obligation. Necessity caused by having no choice, personal resolve, confident prediction and an outcome that holds regardless of circumstances are different meanings; do not decorate one with the marker of another. Remove redundant Thai padding when the main verb already carries the force.
7. Write spoken dialogue with a natural Thai rhythm, but match the scene rather than forcing slang. Casual speech may be clipped; formal speech may be controlled; anger may be blunt; comedy may be playful. An idiom, pun or culturally natural joke may replace the source mechanism only when it creates the same effect, preserves the facts and suits the character. Never explain a joke. Never add profanity or exaggerated intensity just to make dialogue lively.
8. Thai normally omits person-pronouns when speaker and listener are already clear. Do not mechanically add ฉัน, ผม, เรา, คุณ, นาย, เธอ, เขา, ข้า or เจ้า. Keep a pronoun only when contrast, possession, clarity, status or established character voice genuinely needs it. Do not delete a pronoun if doing so changes the actor, makes a contrast disappear or leaves broken Thai. Prefer a known name, title or relationship when that is how the scene identifies someone.
9. Never guess gender. Use ครับ, ค่ะ, คะ, gendered self-reference or gender-dependent address only when explicit source evidence or the CHARACTER SHEET identifies the speaker and the relationship/register calls for it. Gender evidence is permission, not a requirement to mark every sentence. A page image can clarify action, mood and speaker flow, but appearance alone is not proof of gender.
10. Default to NO sentence-final particle. Source politeness forms do not map one-for-one to Thai ครับ / ค่ะ / คะ or a neutral filler. Preserve respect via vocabulary, titles, indirectness and sentence shape. Add a tail only for necessary softening, insistence, challenge, impatience or appeal; never just because the source has one. Treat แหละนะ, เชียวนะ, ด้วยนะ and เปล่าเนี่ย as optional composite fillers: never invent or repeat them. Use one only when source or context requires its function; semantic fidelity outranks this anti-filler default. Add ได้เลย only when the source explicitly accepts, agrees or requires that speech act. Do not stack tails, and do not repeat the same optional tail in adjacent bubbles. More than one optional tail per six to eight units usually means over-writing; exceed that only for distinct necessary functions.

CONTEXT, VOICE AND TERMS
11. Treat all source units as one scene. Read nearby lines to resolve ellipsis, omitted subjects, replies and callbacks. Keep each known character's register stable, but adapt to the current listener and situation. Unknown speakers must not inherit another character's voice.
12. CHARACTER SHEET and SERIES MEMORY are evidence, not scripts. Use them for established names, roles, relationships, temperament and facts, never as sentence templates. Current explicit source evidence outranks a memory inference.
13. Use glossary wording consistently for proper names, places, ranks, factions, skills and recurring items. Do not treat ordinary verbs, adjectives, interjections, particles or whole sentences as fixed glossary entries; choose those from the current context. Preserve meaningful honorifics and titles when they carry relationship or status, but do not attach a generic title to every name.
14. If consecutive source fragments form one unfinished sentence, reconstruct the complete thought before translating. A vertical bubble group represents one utterance that Lens split into columns: translate the whole grouped utterance once in natural Thai order, never column by column and never duplicate shared words. Furigana and OCR annotation noise removed upstream must not be restored.

TEXT TYPE AND COMPRESSION
15. Identify the text type. Dialogue should sound spoken; narration clear and compact without conversational tails; inner thought intimate or fragmentary; exposition dense but complete; shouting short and forceful; SFX a brief natural Thai sound when useful.
16. Preserve deliberate repetition, stammering, interruption, trailing uncertainty and emphasis when they characterize the moment. Remove accidental OCR duplication, stray readings and broken fragments only when they are clearly noise. Do not silently repair an unknown name into a familiar word.
17. Fit speech bubbles by using the fewest natural words that preserve the complete meaning. Cut duplicated subjects, mechanical possessives and source-language scaffolding before cutting plot facts. Do not create manual line breaks or space Thai words apart; layout and wrapping belong to the renderer.

FINAL SELF-CHECK
18. Re-read the page as one scene, then silently audit every line ending. Delete ครับ, ค่ะ, คะ, นะ, ล่ะ, สิ, เลย, หรอก and เถอะ whenever removal preserves intent, relationship and register. Remove the composite fillers when optional, but retain one if removal changes an explicit speech act or meaning. Delete ได้เลย unless the source explicitly accepts, agrees or requires that speech act. Rewrite adjacent repeated tails through the main wording instead of swapping one filler for another. Check for missing facts, invented implications, wrong emotion, inflated certainty, unnecessary pronouns, guessed gender and inconsistent terms. Simplify translated or over-written phrasing. Keep every source unit distinct; reconstruct reading flow only in your understanding."""


# A human-readable policy revision plus a content hash travel through the reset
# and translation endpoints.  The hash is SHA-256 over UTF-8 bytes so browser
# and Python callers can compare it without ever logging the prompt itself.
PROMPT_POLICY_VERSION: Final[dict[str, str]] = {
    "th": "th-2026.08.10.1",
}


# Fixed block appended only when the page image is attached. Kept OUT of the
# editable style so prompt edits cannot break the marker protocol, and kept
# SHORT so it does not dilute the style rules on small models.
IMAGE_HINT: Final[str] = (
    "PAGE IMAGE: the page is attached as CONTEXT. Use it for who speaks to whom, expressions, mood and panel "
    "flow — then still write the polished line the style rules demand. Seeing the source text in the bubbles is "
    "NOT a reason to translate literally; never transcribe.\n"
    "READING FLOW: infer the reading direction from the layout itself (Japanese manga usually flows "
    "right-to-left, webtoons/manhwa left-to-right). The source-unit order comes from OCR and may not match "
    "what you see — reconstruct the conversation visually while keeping each unit's translation attached "
    "to that unit.\n"
    "GENDER CAUTION: manga art is ambiguous — treat the image as a HINT for gender, never proof. Gendered "
    "speech still requires the CHARACTER SHEET or explicit text evidence (the gender rule)."
)


CHARACTER_MEMO_INSTRUCTION: Final[str] = (
    "In the JSON memo field, list each named character who speaks or is addressed on this page, "
    "ONE per line, format:\n"
    "Name | gender: male/female/unknown | speech: their VOICE — tone, personality and vocabulary register "
    "(e.g. blunt / arrogant / cheerful / childish / archaic-formal wording / street-rough / cold). Describe HOW "
    "they SOUND. Do NOT record pronoun or polite-particle habits (ข้า/เจ้า, ครับ/ค่ะ) — those are decided per line "
    "by rules 8-10 and must never be pinned by the sheet | note: role/relationship\n"
    "gender: write male/female ONLY with explicit evidence — the text calls them he/she/หนุ่ม/สาว, a gendered "
    "title (my lord, milady, 'big bro'), gendered self-speech in the SOURCE, or something truly unmistakable in "
    "the attached image. Hair/face/clothes are NOT evidence. When unsure write unknown — a wrong guess poisons "
    "every later page of this series. If this page proves an earlier sheet entry wrong, output the corrected "
    "line. Max 8 lines. If nothing is known, use an empty memo string."
)


# Browser-direct translation still uses the historical marker protocol and
# explicitly asks for no memo. Keep this instruction isolated from the JSON
# contract so the server's structured prompt can never receive both formats.
LEGACY_CHARACTER_MEMO_INSTRUCTION: Final[str] = (
    "After the LAST paragraph, append <<TP_MEMO>> on its own line, followed by character observations "
    "using the same Name | gender | speech | note line format. Use none when nothing is known."
)


RESPONSE_CONTRACT_TEXT: Final[str] = (
    'Return ONLY one JSON object: {"translations":[{"id":"P0","text":"..."}],"memo":""}.\n'
    "Return one translation entry per source unit in exact input order. Never include markdown or commentary."
)


# Older JSON contract kept around for callers that opt into it.
RESPONSE_CONTRACT_JSON: Final[str] = (
    RESPONSE_CONTRACT_TEXT
)


def lang_style(lang: str) -> str:
    """Return the style snippet for ``lang``, falling back to the default."""
    code = _normalize_lang(lang)
    if code == "th":
        return THAI_STYLE_COMPACT.strip()
    return (LANG_STYLE.get(code) or LANG_STYLE["default"]).strip()


def _select_style(lang: str, prompt_override: str = "") -> tuple[str, str]:
    """Return the effective editable style and a safe source label.

    This is the single decision used by both prompt composition and runtime
    metadata. Keeping it in one place prevents an audit hash from describing a
    different prompt than the one sent to the provider.
    """
    built_in = lang_style(lang)
    override = (prompt_override or "").strip()
    if not override:
        return built_in, "built_in"
    if override.lower().startswith("target language"):
        source = "saved_default" if override == built_in else "saved_custom"
        return override, source
    return (
        built_in
        + "\n\nSERIES NOTES (from the user — follow these even when they conflict with a rule above):\n"
        + override,
        "built_in_plus_series_notes",
    )


def prompt_metadata(lang: str, prompt_override: str = "") -> dict[str, str | int]:
    """Describe the effective editable style without exposing its contents."""
    code = _normalize_lang(lang)
    style, source = _select_style(code, prompt_override)
    digest = hashlib.sha256(style.encode("utf-8")).hexdigest()
    version = PROMPT_POLICY_VERSION.get(code, f"{code}-style-1")
    if source == "saved_custom":
        version = "custom"
    elif source == "built_in_plus_series_notes":
        version = version + "+notes"
    return {
        "promptVersion": version,
        "promptHash": digest,
        "promptChars": len(style),
        "promptSource": source,
    }


def build_glossary_block(glossary: list[dict] | None, limit: int = 40) -> str:
    """Render a short glossary / translation-memory block for the prompt.

    ``glossary`` is a list of ``{"src": ..., "tgt": ...}`` pairs collected from
    the user's recent translations (across multiple images in one session).
    Injecting them keeps NAMES and recurring TERMS consistent from page to
    page — the same role a human scanlator's term sheet plays.

    Accuracy guards:
    - very short sources (< 3 chars) are skipped: they are almost always
      interjections/particles ("Ha", "eh", "!?") whose best translation
      depends on the scene — pinning them makes later pages stiff;
    - only the most recent ``limit`` unique source terms are kept so the
      prompt stays small.

    Returns ``""`` when there is nothing usable.
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
        if len(src) < 3:  # interjection/particle — context beats memory
            continue
        seen.add(src)
        lines.append(f"  - {src} → {tgt}")
        if len(lines) >= limit:
            break
    if not lines:
        return ""
    lines.reverse()  # restore chronological order for readability
    return (
        "TRANSLATION MEMORY (names, places, skills, items from earlier pages — use the SAME target wording "
        "for the SAME source term). This binds recurring names/terms only; everyday words and interjections "
        "are always free to follow the scene:\n"
        + "\n".join(lines)
    )


def looks_like_term(src: str, tgt: str, min_len: int = 3) -> bool:
    """Heuristic: is ``src => tgt`` a reusable TERM (name/place/skill/item)?

    Guards the glossary and the brief's TERMS block against full sentences and
    interjections, which poison later pages when pinned.  ``min_len`` is 2 for
    brief-authored terms (CJK names are often exactly 2 chars) and 3 for
    memo-harvested pairs.
    """
    s, t = (src or "").strip(), (tgt or "").strip()
    if not s or not t or len(s) < min_len:
        return False
    if len(s) > 40 or len(t) > 60:
        return False
    if "\n" in s or "\n" in t:
        return False
    # Sentence punctuation (interior) = a sentence, not a term.
    if any(ch in s for ch in "。.!?！？…,、"):
        return False
    if len(s.split()) > 5:
        return False
    return True


# ⛔ NOTE: build_series_block / build_speaker_block / build_prev_context_block
# ยัง ACTIVE ในโค้ด (ถูกเรียกจาก build_system_split) แต่ปัจจุบันได้ค่า "ว่าง" เสมอ
# เพราะข้อมูลต้นทาง (bible/speakers/prev_context) มาจาก chapter-brief flow ที่
# dormant อยู่ — บล็อกพวกนี้จึงไม่ปรากฏใน prompt จริงตอนนี้
def build_series_block(series_state: str) -> str:
    """Render the frozen series bible (STORY SO FAR) block, or ``""``."""
    state = (series_state or "").strip()
    if not state:
        return ""
    return (
        "STORY SO FAR (series bible from reading the whole chapter — background truth for tone, "
        "relationships and scene; NEVER restate or translate it in the output):\n" + state
    )


def build_speaker_block(speakers: dict | None) -> str:
    """Render this page's marker->speaker map (from the chapter brief).

    ``speakers`` maps paragraph indices to character names, e.g.
    ``{"0": "Rey", "2": "Marnie"}``.  Unknown markers are simply absent.
    Returns ``""`` when there is nothing usable.
    """
    if not isinstance(speakers, dict) or not speakers:
        return ""
    lines: list[str] = []
    for idx in sorted(speakers, key=lambda k: int(k) if str(k).isdigit() else 0):
        name = str(speakers[idx] or "").strip()
        if name:
            lines.append(f"  <<TP_P{idx}>> = {name}")
        if len(lines) >= 50:
            break
    if not lines:
        return ""
    return (
        "SPEAKER MAP (decided from the WHOLE chapter — trust it over per-line guessing; give each "
        "line the voice its speaker has in the character sheet):\n" + "\n".join(lines)
    )


def build_prev_context_block(prev_context: list | None, limit: int = 6) -> str:
    """Render the previous page's SOURCE tail for cross-page flow (R4).

    ``prev_context`` is ``[{"src": ..., "who": ...?}, ...]`` in reading order —
    source text only (from OCR), so parallel translation never waits on another
    page's result.  Returns ``""`` when there is nothing usable.
    """
    if not isinstance(prev_context, list) or not prev_context:
        return ""
    lines: list[str] = []
    for entry in prev_context[-limit:]:
        if not isinstance(entry, dict):
            continue
        src = str(entry.get("src") or "").strip().replace("\n", " ")
        if not src:
            continue
        who = str(entry.get("who") or "").strip()
        lines.append(f"  [{who}] {src}"[:200] if who else f"  {src}"[:200])
    if not lines:
        return ""
    return (
        "PREVIOUS PAGE (source text tail, context only — the conversation may continue from here; "
        "do NOT translate or output these lines):\n" + "\n".join(lines)
    )


def build_character_block(
    characters: list[dict] | None, limit: int = 30, has_image: bool = False
) -> str:
    """Render the accumulated per-series character sheet for the prompt.

    ``characters`` is a list of ``{"name", "gender", "speech", "note"}`` dicts
    the client accumulated from earlier pages (via the ``<<TP_MEMO>>`` block).
    The sheet is the AUTHORITY for gender: gendered speech is only allowed for
    characters listed here with a known gender (style rule 3), which is what
    lets long-running series get ครับ/ค่ะ right without guessing.
    Returns ``""`` when there is nothing usable.
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
    return (
        "CHARACTER SHEET (accumulated from earlier pages of this series — treat as ground truth):\n"
        + "\n".join(lines)
        + "\nThis sheet is the ONLY proof of a character's gender (plus explicit text evidence). But a known "
        "gender is just PERMISSION, never a requirement: keep using gender markers (ครับ/ค่ะ, ผม/ดิฉัน) as "
        "little as possible even for listed characters — reach for one only when the line's register clearly "
        "calls for polite/formal speech, and stay gender-neutral otherwise. Anyone not listed — or listed as "
        "unknown — is always gender-neutral. Casual lines stay casual and particle-free; use the speech/note "
        "fields to keep each character's voice stable, not to add politeness."
    )


def build_system_text(
    lang: str,
    prompt_override: str = "",
    is_retry: bool = False,
    glossary: list[dict] | None = None,
    characters: list[dict] | None = None,
    has_image: bool = False,
    want_memo: bool = True,
    series_state: str = "",
    speakers: dict | None = None,
    prev_context: list | None = None,
    structured_output: bool = False,
) -> str:
    """Build the system prompt that gets prepended to every AI call.

    Composition (in order): SYSTEM_BASE, the single editable language style
    (or the user's override), IMAGE_HINT when a page image is attached, the
    character sheet, the translation memory, then the fixed marker contract.
    The contract enforces the ``<<TP_Pn>>`` protocol used by
    :mod:`backend.ai.markers`; when ``is_retry`` is True an extra line demands
    ALL markers.  The model only ever sees the source text (no MT reference),
    which keeps input tokens small.

    This is a thin wrapper over :func:`build_system_split`; joining its two
    halves reproduces the exact string this function has always returned, so
    non-caching callers are unaffected.
    """
    static_text, dynamic_text = build_system_split(
        lang,
        prompt_override,
        is_retry=is_retry,
        glossary=glossary,
        characters=characters,
        has_image=has_image,
        want_memo=want_memo,
        series_state=series_state,
        speakers=speakers,
        prev_context=prev_context,
        structured_output=structured_output,
    )
    return "\n\n".join(p for p in (static_text, dynamic_text) if p)


def build_system_split(
    lang: str,
    prompt_override: str = "",
    is_retry: bool = False,
    glossary: list[dict] | None = None,
    characters: list[dict] | None = None,
    has_image: bool = False,
    want_memo: bool = True,
    series_state: str = "",
    speakers: dict | None = None,
    prev_context: list | None = None,
    structured_output: bool = False,
) -> tuple[str, str]:
    """Split the system prompt into a cacheable prefix and a per-page suffix.

    ``static`` = SYSTEM_BASE + the editable language style. It is byte-identical
    for every page of a given ``(lang, model)`` and is by far the largest block
    (the worked examples live in the style), so it is the part worth caching on
    the provider side: Anthropic marks it with ``cache_control``; Gemini and
    OpenAI-compatible providers cache it implicitly because it is the common
    prefix of every request.

    ``dynamic`` = IMAGE_HINT + character sheet + glossary + marker contract,
    all of which change from page to page.

    Joining static and dynamic with a blank line (dropping empties) reproduces
    exactly what :func:`build_system_text` returns, preserving block order
    (base, style, image, character, glossary, contract).
    """
    # R9 — the user's edited prompt must actually take effect. Metadata uses
    # this same selector, so its hash proves the exact effective style.
    style, _source = _select_style(lang, prompt_override)
    static_text = "\n\n".join(p for p in (SYSTEM_BASE.strip(), style) if p)

    if structured_output:
        contract = [
            "OUTPUT CONTRACT (this is the only output-format instruction): Return ONLY one JSON object "
            'with exactly this shape: {"translations":[{"id":"P0","text":"complete translation"}],"memo":""}.',
            "For every input <<TP_Pn>>, return exactly one translations entry whose id is Pn and whose text "
            "is that unit's complete translation. Keep entries in exact input order.",
            "Never omit, duplicate, combine, renumber or reorder an entry. Never put two units in one text.",
            'If one unit genuinely cannot be translated, still return its entry with "text": "" — an empty '
            "string is the only permitted way to signal failure. Never drop the entry, never copy the source "
            "text into it, and never write a note, an apology or a placeholder there.",
            "Do not return markdown, commentary, paragraph markers or keys not present in the schema.",
            "If the target is Thai, Japanese, Chinese or Korean, do NOT insert spaces between "
            "words of that script. A space is only OK between scripts (e.g. Thai + digits).",
        ]
        if want_memo:
            contract.append(
                "Put character-memory observations only in the required memo string using the "
                "line format below; use an empty string when there are none."
            )
            contract.append(CHARACTER_MEMO_INSTRUCTION)
        else:
            contract.append("Character memory is disabled: return memo as an empty string.")
    else:
        contract = [
            "Output ONLY the translated text (no JSON, no markdown, no extra commentary).",
            "Keep every paragraph marker like <<TP_P0>> exactly as it appears, in order.",
            "For each marker, output the marker followed by that paragraph's translated text.",
            "You MUST return every marker from the first through the last exactly once; never omit, "
            "combine, renumber or reorder a marker, even for punctuation or very short text.",
            "If the target is Thai, Japanese, Chinese or Korean, do NOT insert spaces between "
            "words of that script. A space is only OK between scripts (e.g. Thai + digits).",
        ]
        if want_memo:
            contract.append(LEGACY_CHARACTER_MEMO_INSTRUCTION)
    glossary_block = build_glossary_block(glossary)
    character_block = build_character_block(characters, has_image=has_image)
    image_block = IMAGE_HINT if has_image else ""
    series_block = build_series_block(series_state)
    speaker_block = build_speaker_block(speakers)
    prev_block = build_prev_context_block(prev_context)
    dynamic_text = "\n\n".join(
        p
        for p in (
            image_block,
            series_block,
            character_block,
            glossary_block,
            speaker_block,
            prev_block,
            "\n".join(contract),
        )
        if p
    )
    return static_text, dynamic_text


def build_user_parts(original_text_full: str) -> list[str]:
    """Return the user-message blocks for a translation request.

    Only the source text is sent — no Lens MT reference — so input stays
    small and the model translates from the original.
    """
    return ["Source (translate this):\n" + str(original_text_full or "")]
