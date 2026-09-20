from __future__ import annotations

import hashlib
from .source_context import build_source_context_block
from .instruction_packs import instruction_pack
from .localization import TRANSLATOR_IDENTITY_BASE, TASK_GUIDANCE, build_style_examples

from backend.lens.languages import normalize as _normalize_lang
from backend.ai.provider_contract import SystemPromptSection
from .context import build_page_context_block, build_character_block, build_glossary_block, build_prev_context_block, build_series_block, build_speaker_block
from .languages import target_language_priority
from .styles import CANONICAL_PROMPT_CONTRACT_VERSION, CHARACTER_MEMO_INSTRUCTION, IMAGE_HINT, OCR_SEMANTIC_GUIDANCE, SERIES_NOTES_HEADING, SYSTEM_BASE, lang_style, select_style

STYLE_PRIORITY = (
    "Use the Style prompt below to determine the target language and translation principles, "
    "including meaning, wording, tone and character voice. Apply it to every source unit. "
    "The rules here govern source handling and the input/output contract; Style prompt does not override them."
)
SOURCE_INPUT_CONTRACT = (
    "INPUT — tp.translation.compact-records/1\n"
    "Each source record is <<TP_Pn:source text>>."
)
SCHEMA_SOURCE_INPUT_CONTRACT = (
    "INPUT — tp.translation.schema-object/1\n"
    "Each source record is Pn:source text."
)
# Browser contract metadata retains this legacy label until its independent
# direct-local contract is revised. API provider messages do not use it.


def build_translator_identity_system(style: str, lang: str = "en") -> str:
    selected = str(style or "").strip()
    if not selected:
        raise ValueError("AI translation style is empty")
    pack = instruction_pack(lang)
    # The selected style has one owner: this stable System block.
    return pack["identity"] + "\n\n" + pack["styleHeading"] + "\n" + selected
MARKER_OUTPUT_CONTRACT = "\n".join((
    "OUTPUT — tp.translation.compact-records/1",
    "Return every supplied ID exactly once as <<TP_Pn:translated text>>. Keep both << and >> delimiters; the payload after ':' must be a non-empty translation. Record order is irrelevant because results are matched by ID.",
    "Do not add, omit, merge, split or rename records. Do not insert manual line breaks inside a payload.",
    "Return only the records, with no JSON, markdown, commentary or explanations.",
))

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
    prompt_mode: str = "replace",
) -> str:
    """Build the system prompt that gets prepended to every AI call.

    Composition (in order): mandatory policy, target/input/output contract,
    optional per-page context, then the single selected editable style.
    The contract enforces the ``<<TP_Pn>>`` protocol used by
    :mod:`backend.ai.markers`. Repair calls pass ``is_retry`` for call-chain
    metadata, but already contain only the missing IDs and therefore use the
    same prompt contract. The model only ever sees the source text (no MT
    reference), which keeps input tokens small.

    This is a thin wrapper over :func:`build_system_split`; joining its two
    conceptual halves produces the sole provider-visible system content.
    """
    style_text, mandatory_text = build_system_split(
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
        prompt_mode=prompt_mode,
    )
    return "\n\n".join(p for p in (mandatory_text, style_text) if p)

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
    prompt_mode: str = "replace",
) -> tuple[str, str]:
    """Split final system content into stable style and mandatory/runtime rules.

    ``static`` is the selected editable language style. It is embedded once in
    final system content and is never sent independently.

    ``dynamic`` contains the mandatory translation/target/OCR/output contract
    and optional per-page context.

    Joining static and dynamic with a blank line (dropping empties) reproduces
    exactly what :func:`build_system_text` returns, preserving block order
    (base, style, image, character, glossary, contract).
    """
    # ``is_retry`` is retained as part of the prompt-builder contract.  Repair
    # calls already contain only the missing source IDs, so the normal output
    # contract applies unchanged; accepting the flag keeps build_system_text
    # and direct invocation callers aligned without introducing a second
    # repair-only prompt contract.
    _ = is_retry

    # R9 — the user's edited prompt must actually take effect. Metadata uses
    # this same selector, so its hash proves the exact effective style.
    style, _source = select_style(lang, prompt_override, prompt_mode)
    # Semantic order is deliberate: editable style first, then fixed system and
    # OCR rules, one full target-language instruction, output contract, and
    # finally per-page context. The provider-visible source is the user message.
    static_text = style

    if structured_output:
        contract = [
            STYLE_PRIORITY,
            SYSTEM_BASE.strip(),
            SCHEMA_SOURCE_INPUT_CONTRACT,
        ]
    else:
        contract = [
            STYLE_PRIORITY,
            SYSTEM_BASE.strip(),
            SOURCE_INPUT_CONTRACT,
        ]
        # The line protocol deliberately has no memo/output suffix. Character
        # memory remains input context; legacy memo responses stay decode-only.
    glossary_block = build_glossary_block(glossary)
    character_block = build_character_block(characters, has_image=has_image)
    image_block = IMAGE_HINT if has_image else ""
    series_block = build_series_block(series_state)
    speaker_block = build_speaker_block(speakers)
    prev_block = build_prev_context_block(prev_context)
    dynamic_text = "\n\n".join(
        p
        for p in (
            "\n".join(contract),
            image_block,
            series_block,
            character_block,
            glossary_block,
            speaker_block,
            prev_block,
        )
        if p
    )
    return static_text, dynamic_text

def build_user_parts(original_text_full: str) -> list[str]:
    """Return the user-message blocks for a translation request.

    All instructions belong to the sole system content.  The user boundary is
    therefore lossless and contains only literal ``<<TP_Pn:OCR>>`` records;
    no heading, target instruction or Lens MT reference is injected here.
    """
    return [str(original_text_full or "")]

def exact_request_output_contract(expected_ids: list[str] | tuple[str, ...], *,
                                  structured_output: bool = False, lang: str = "en") -> str:
    ids = tuple(str(value or "") for value in expected_ids)
    if not ids or any(value != f"P{index}" for index, value in enumerate(ids)):
        raise ValueError("AI request has invalid output IDs")
    return instruction_pack(lang)["schemaOutput" if structured_output else "markerOutput"].format(ids=", ".join(ids))

def append_request_output_section(
    sections: tuple[SystemPromptSection, ...], expected_ids: list[str] | tuple[str, ...],
    *, structured_output: bool = False,
) -> tuple[SystemPromptSection, ...]:
    """Merge the per-request contract into the one provider-visible system block."""
    if any(section.name == "request_output_contract" for section in sections):
        raise ValueError("AI request output contract is already present")
    values = {section.name: section.text for section in sections if section.text}
    required = {"mandatory_system", "selected_style"}
    if not required.issubset(values) or set(values) - {"mandatory_system", "runtime_context", "selected_style"}:
        raise ValueError("AI request has an invalid canonical system composition")
    mandatory = "\n\n".join(filter(None, (
        values["mandatory_system"],
        exact_request_output_contract(expected_ids, structured_output=structured_output),
        values.get("runtime_context", ""),
    )))
    final = f"System prompt:\n{mandatory}\n\nStyle prompt:\n{values['selected_style']}"
    return (SystemPromptSection("final_system", final),)

def build_system_sections(
    lang: str,
    prompt_override: str = "",
    **options,
) -> tuple[SystemPromptSection, ...]:
    """Return exactly one final provider-visible system content block.

    The editable user style is selected once and embedded in this final block;
    it is never sent as a second message or provider part.  Keeping one block
    makes OpenAI-compatible, Gemini and Anthropic requests byte-auditable by
    the same rule.
    """
    static, dynamic = build_system_split(lang, prompt_override, **options)
    structured = bool(options.get("structured_output", False))

    runtime_blocks = tuple(filter(None, (
        IMAGE_HINT if options.get("has_image", False) else "",
        build_series_block(options.get("series_state", "")),
        build_character_block(options.get("characters"), has_image=bool(options.get("has_image", False))),
        build_glossary_block(options.get("glossary")),
        build_speaker_block(options.get("speakers")),
        build_prev_context_block(options.get("prev_context")),
    )))
    runtime_text = "\n\n".join(runtime_blocks)
    instruction_text = dynamic
    if runtime_text and dynamic.endswith(runtime_text):
        instruction_text = dynamic[: -len(runtime_text)].rstrip()

    system_policy = ""
    output_contract = instruction_text
    source_marker = SCHEMA_SOURCE_INPUT_CONTRACT if structured else SOURCE_INPUT_CONTRACT
    before, separator, after = instruction_text.partition("\n" + source_marker)
    if separator:
        system_policy = before
        output_contract = source_marker + after

    mandatory = "\n".join(filter(None, (system_policy, output_contract)))
    return tuple(section for section in (
        SystemPromptSection("mandatory_system", mandatory),
        SystemPromptSection("runtime_context", runtime_text),
        SystemPromptSection("selected_style", static),
    ) if section.text)

def join_system_sections(sections: tuple[SystemPromptSection, ...]) -> str:
    """Render named sections byte-identically to the legacy system prompt."""
    if len(sections) == 1 and sections[0].name == "final_system":
        return sections[0].text
    values = {section.name: section.text for section in sections if section.text}
    if "mandatory_system" in values:
        return "\n\n".join(filter(None, (
            values["mandatory_system"], values.get("runtime_context", ""),
            values.get("selected_style", ""),
        )))
    static = values.get("style", "")
    instruction = "\n".join(filter(None, (
        values.get("system_policy", ""),
        values.get("target_language", ""),
        values.get("output_contract", ""),
    )))
    runtime = values.get("runtime_context", "")
    dynamic = "\n\n".join(filter(None, (instruction, runtime)))
    request_contract = values.get("request_output_contract", "")
    return "\n\n".join(filter(None, (static, dynamic, request_contract)))

def conversation_record_contract(lang: str, *, structured_output: bool = False) -> str:
    code = _normalize_lang(lang)
    if structured_output:
        if code == "th":
            return ("INPUT/OUTPUT — tp.translation.image-records/1\n"
                    "ข้อความล่าสุดใช้ ID รูป I<ภาพ>_P<หน่วย> ซึ่งระบุตำแหน่ง ไม่ใช่ผู้พูด "
                    "ตอบเฉพาะ ID ในข้อความผู้ใช้ล่าสุดให้ครบครั้งเดียวด้วยคีย์เดิมใน JSON schema ที่กำหนด "
                    "ค่าของแต่ละคีย์ต้องเป็นคำแปลเท่านั้น ห้ามคงข้อความต้นฉบับเป็นค่า และห้ามมีข้อความนอก JSON "
                    "ประวัติก่อนหน้าเป็นบริบท ห้ามตอบ ID เก่าซ้ำ")
        if code == "ja":
            return ("INPUT/OUTPUT — tp.translation.image-records/1\n"
                    "最新入力のIDは I<画像>_P<単位> で、位置を示し話者を示さない。"
                    "最新ユーザーメッセージのIDだけを指定JSON schemaの同じキーで一度ずつ返す。"
                    "各キーの値には訳文だけを入れ、原文を値として残したりJSONの外に訳文や説明を書いたりしない。過去IDを再回答しない。")
        return ("INPUT/OUTPUT — tp.translation.image-records/1\n"
                "Latest source IDs are I<image>_P<unit>. IDs identify source locations, not speakers. "
                "Return only IDs from the latest user message exactly once using the same JSON keys. "
                "Each value must contain the translation only: never keep the source text as the value or place the translation/commentary outside the JSON. "
                "Previous turns are context only; do not repeat old IDs.")
    if code == "th":
        return ("INPUT/OUTPUT — tp.translation.image-records/1\n"
                "รายการงานจริงใช้ <<I<ภาพ>_P<หน่วย>:ข้อความต้นฉบับ>> โดย I ระบุภาพและ P ระบุหน่วยในภาพ ไม่ใช่ผู้พูด "
                "ตอบเฉพาะ ID รูปแบบ I<เลข>_P<เลข> ที่อยู่ในข้อความผู้ใช้ล่าสุดให้ครบครั้งเดียวในรูป <<I<ภาพ>_P<หน่วย>:คำแปล>> ด้วย ID เดิม "
                "ข้อความหลังเครื่องหมาย : ภายใน marker ต้องเป็นคำแปลที่ไม่ว่าง และต้องคงเครื่องหมาย << กับ >> ให้ครบ ต้องแทนที่ข้อความต้นฉบับด้วยคำแปล "
                "ห้ามคงข้อความต้นฉบับไว้ใน marker แล้ววางคำแปลไว้นอก marker และห้ามมีข้อความใดนอก marker นอกจากช่องว่าง "
                "ประวัติก่อนหน้าเป็นบริบท ห้ามตอบ ID เก่าซ้ำ ห้ามเพิ่ม JSON, markdown หรือคำอธิบาย")
    if code == "ja":
        return ("INPUT/OUTPUT — tp.translation.image-records/1\n"
                "最新の各項目は <<I<画像>_P<単位>:原文>>。Iは画像、Pは画像内単位を示し、話者IDではない。"
                "最新ユーザーメッセージのIDだけを同じIDの <<I<画像>_P<単位>:訳文>> で一度ずつ返す。"
                "コロンの後には空でない訳文だけを入れ、<< と >> を必ず保持する。原文をmarker内に残して訳文をmarker外へ書かない。marker外は空白以外を出力しない。過去IDを再回答しない。")
    return ("INPUT/OUTPUT — tp.translation.image-records/1\n"
            "Each latest source record is <<I<image>_P<unit>:source text>>. I identifies a stable image and P a unit inside it; IDs are locations, not speakers. "
            "Return only IDs from the latest user message exactly once as <<I<image>_P<unit>:translated text>> using the same IDs. "
            "The text after ':' inside each marker must be a non-empty translation. Keep both << and >> delimiters and replace the source text with the translation. "
            "Never keep source text inside a marker and put its translation outside; output no non-whitespace text outside markers. "
            "Previous turns are context only. Do not repeat old IDs or add JSON, markdown, commentary or explanations.")

def build_static_user_prefix(lang: str, *, structured_output: bool = False,
                             source_lang: str = "", style_examples: bool = True,
                             selected_style: str | None = None, conversation_records: bool = False) -> str:
    """Task/protocol/examples only; the selected style is owned by System."""
    pack = instruction_pack(lang)
    style = select_style(lang)[0] if selected_style is None else str(selected_style).strip()
    if not style:
        raise ValueError("AI translation style is empty")
    blocks = [pack["taskHeading"] + "\n" + target_language_priority(lang),
              pack["dataHeading"] + "\n" + pack["task"]]
    if not conversation_records:
        blocks.append(pack["schemaInput" if structured_output else "markerInput"])
    if style_examples is not False:
        examples = build_style_examples(lang, [], structured_output=structured_output, source_lang=source_lang)
        if examples:
            blocks.append(examples)
    # Conversation keeps the I#_P# contract final immediately before SOURCE.
    # Independent retains its established marker-before-examples layout.
    if conversation_records:
        blocks.append(conversation_record_contract(lang, structured_output=structured_output))
    return "\n\n".join(blocks)


def build_translation_user_message(
    lang: str, prompt_override: str, original_text_full: str,
    expected_ids: list[str] | tuple[str, ...], *,
    structured_output: bool = False, prompt_mode: str = "replace",
    glossary=None, characters=None, has_image=False, series_state="", speakers=None,
    prev_context=None, page_context=None, source_lang="", source_context=None,
    repair_reason="", style_examples: bool = True, memory_mode: str | None = None,
    conversation_records: bool = False,
) -> str:
    """Static prefix first; dynamic source evidence last. IDs are output locations.

    Explicit memory modes strictly control story data, independently of examples.
    None preserves legacy callers that passed their own already-filtered context.
    """
    pack = instruction_pack(lang)
    if memory_mode is not None:
        glossary = glossary if memory_mode in ("terms", "full") else []
        if memory_mode != "full":
            characters, series_state, speakers, prev_context = [], "", {}, []
    runtime = "\n\n".join(filter(None, (
        pack["image"] if has_image else "",
        build_series_block(series_state, lang=lang),
        build_character_block(characters, has_image=has_image, lang=lang),
        build_glossary_block(glossary, lang=lang),
        build_speaker_block(speakers, lang=lang),
        build_prev_context_block(prev_context, lang=lang),
        build_page_context_block(page_context, lang=lang),
        build_source_context_block(source_context, lang=lang),
    )))
    selected_style, _ = select_style(lang, prompt_override, prompt_mode)
    blocks = [build_static_user_prefix(lang, structured_output=structured_output,
                                       source_lang=source_lang, style_examples=style_examples,
                                       selected_style=selected_style, conversation_records=conversation_records)]
    # No dynamic ID list, context, image or repair reason before this point.
    if runtime:
        blocks.append(pack["contextHeading"] + "\n" + runtime)
    if not conversation_records:
        blocks.append(exact_request_output_contract(expected_ids, structured_output=structured_output, lang=lang))
    from .repair import wrong_language_repair_instruction
    repair = wrong_language_repair_instruction(target_language_priority(lang), repair_reason, lang=lang)
    if repair:
        blocks.append(repair)
    blocks.append(pack["sourceHeading"] + "\n" + str(original_text_full or ""))
    return "\n\n".join(blocks)


def canonical_boundary_fixture(
    lang: str,
    prompt_override: str,
    expected_ids: list[str] | tuple[str, ...],
    original_text_full: str,
    **options,
) -> dict:
    """Return deterministic API reference bytes and hashes for runtime parity tests."""
    sections = append_request_output_section(
        build_system_sections(lang, prompt_override, **options), expected_ids,
    )
    system = join_system_sections(sections)
    user = build_user_parts(original_text_full)[0]
    return {
        "version": "tp.provider-prompt-boundary/1",
        "compositionOrder": [
            "mandatory_system", "request_output_contract", "runtime_context", "selected_style",
        ],
        "system": system,
        "user": user,
        "systemSha256": hashlib.sha256(system.encode("utf-8")).hexdigest(),
        "userSha256": hashlib.sha256(user.encode("utf-8")).hexdigest(),
    }

def canonical_prompt_contract(lang: str, *, want_memo: bool = True) -> dict:
    """Return provider-neutral prompt pieces for a direct/local adapter.

    The plan contains no page content, credentials or runtime memory. Its
    systemPolicy describes only the identity/data boundary; editableStyle is
    rendered once in System by the live builders. Field names remain
    compatible with existing callers, while compositionOrder and styleRole
    describe the current role ownership. Legacy system-section helpers are
    transport fixtures, not the live translation layout.
    """
    code = _normalize_lang(lang)
    style = lang_style(code)
    system_policy = instruction_pack(code)["identity"]
    target_instruction = lang_style(code).splitlines()[0].strip()
    structured_contract = (
        "OUTPUT — tp.translation.schema-object/1\n"
        "Return only the JSON object required by the supplied schema. Each key is the corresponding Pn ID "
        "and each value is that unit's complete translation. Do not add, omit, merge, split or rename records. "
        "Do not insert manual line breaks for visual layout."
    )
    pieces = {
        "systemPolicy": system_policy,
        "editableStyle": style,
        "targetLanguageInstruction": target_instruction,
        "sourceInputContract": SOURCE_INPUT_CONTRACT,
        "imageHint": IMAGE_HINT,
        "markerOutputContract": MARKER_OUTPUT_CONTRACT,
        "structuredOutputContract": structured_contract,
        "seriesNotesHeading": SERIES_NOTES_HEADING,
    }
    hashes = {
        key: hashlib.sha256(value.encode("utf-8")).hexdigest()
        for key, value in pieces.items()
    }
    aggregate = "\n".join(f"{key}:{hashes[key]}" for key in sorted(hashes))
    return {
        "version": CANONICAL_PROMPT_CONTRACT_VERSION,
        "compositionOrder": [
            "system.identity", "system.editableStyle", "user.task", "user.dataScope",
            "user.sourceInputContract", "user.examplesIfEnabled", "user.runtimeContext",
            "user.outputContract", "user.repairIfNeeded", "user.source",
        ],
        "styleRole": "system",
        "editableStylePolicy": {
            "control": "optional_replace",
            "supportedModes": ["replace"],
            "migrationDefault": "replace",
            "emptyBehavior": "built_in",
        },
        "pieces": pieces,
        "hashes": hashes,
        "hash": hashlib.sha256(aggregate.encode("utf-8")).hexdigest(),
    }
