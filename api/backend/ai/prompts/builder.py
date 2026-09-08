from __future__ import annotations

import hashlib

from backend.lens.languages import normalize as _normalize_lang
from backend.ai.provider_contract import SystemPromptSection
from .context import build_character_block, build_glossary_block, build_prev_context_block, build_series_block, build_speaker_block
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

TRANSLATOR_IDENTITY_BASE = (
    "You are an expert translator and localization editor. The following defines how you translate. "
    "Treat it as your own translation style and apply it naturally and consistently."
)

def build_translator_identity_system(style: str) -> str:
    selected = str(style or "").strip()
    if not selected:
        raise ValueError("AI translation style is empty")
    return TRANSLATOR_IDENTITY_BASE + "\n\nTRANSLATION STYLE\n" + selected
MARKER_OUTPUT_CONTRACT = "\n".join((
    "OUTPUT — tp.translation.compact-records/1",
    "Return every supplied ID exactly once as <<TP_Pn:translated text>>. Record order is irrelevant because results are matched by ID.",
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
                                  structured_output: bool = False) -> str:
    """Bind one provider request to its parsed, ordered output ID set."""
    ids = tuple(str(value or "") for value in expected_ids)
    if (not ids or any(value != f"P{index}" for index, value in enumerate(ids))):
        raise ValueError("AI request has invalid output IDs")
    if structured_output:
        return (
            "OUTPUT — tp.translation.schema-object/1\n"
            "Return only the JSON object required by the supplied schema. "
            f"Its keys must be exactly {', '.join(ids)}; each value is that unit's complete non-empty translation. "
            "Do not add, omit, merge, split or rename records. Do not insert manual line breaks for visual layout."
        )
    return (
        "OUTPUT — tp.translation.compact-records/1\n"
        f"Return every supplied ID exactly once as <<TP_Pn:translated text>>. Expected IDs: {', '.join(ids)}. "
        "Record order is irrelevant because results are matched by ID. Do not add, omit, merge, split or rename records. "
        "Do not insert manual line breaks inside a payload. Return only the records, with no JSON, markdown, commentary or explanations."
    )

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

def build_translation_user_message(
    lang: str,
    prompt_override: str,
    original_text_full: str,
    expected_ids: list[str] | tuple[str, ...],
    *,
    structured_output: bool = False,
    prompt_mode: str = "replace",
    glossary: list[dict] | None = None,
    characters: list[dict] | None = None,
    has_image: bool = False,
    series_state: str = "",
    speakers: dict | None = None,
    prev_context: list | None = None,
    repair_reason: str = "",
) -> str:
    """Compose the provider-visible user message for translation.

    The system role is intentionally tiny. All task-specific material lives
    here: target language, editable style, optional runtime context, source
    contract, exact output contract, and the OCR records.
    """
    style, _source = select_style(lang, prompt_override, prompt_mode)
    runtime = "\n\n".join(filter(None, (
        IMAGE_HINT if has_image else "",
        build_series_block(series_state),
        build_character_block(characters, has_image=has_image),
        build_glossary_block(glossary),
        build_speaker_block(speakers),
        build_prev_context_block(prev_context),
    )))
    source_contract = SCHEMA_SOURCE_INPUT_CONTRACT if structured_output else SOURCE_INPUT_CONTRACT
    blocks = [
        "TRANSLATION TASK\n" + target_language_priority(lang) +
        "\nUse the translation style defined in your translator identity.",
    ]
    if runtime:
        blocks.append("CONTEXT\n" + runtime)
    blocks.extend((source_contract,
        exact_request_output_contract(expected_ids, structured_output=structured_output)))
    from .repair import wrong_language_repair_instruction
    repair = wrong_language_repair_instruction(target_language_priority(lang), repair_reason)
    if repair:
        blocks.append(repair)
    blocks.append("SOURCE TEXT\n" + str(original_text_full or ""))
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

    This endpoint contract intentionally contains no page text, translation,
    credentials, character memory or series memory.  Those remain on the
    caller's machine.  Joining ``staticSystemText`` with the appropriate output
    contract (and caller-built runtime context between them) reproduces the
    same semantic ordering used by :func:`build_system_split` for Cloud.

    The legacy fields returned by ``/ai/prompt/default`` remain untouched;
    this is an additive, versioned description for newer callers.
    """
    code = _normalize_lang(lang)
    style = lang_style(code)
    system_policy = "\n".join((STYLE_PRIORITY, SYSTEM_BASE.strip()))
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
            "editableStyle",
            "systemPolicy",
            "targetLanguageInstruction",
            "sourceInputContract",
            "imageHintIfAttached",
            "runtimeContext",
            "markerOutputContract",
        ],
        "editableStylePolicy": {
            "control": "fixed_replace",
            "supportedModes": ["replace"],
            "migrationDefault": "replace",
        },
        "pieces": pieces,
        "hashes": hashes,
        "hash": hashlib.sha256(aggregate.encode("utf-8")).hexdigest(),
    }
