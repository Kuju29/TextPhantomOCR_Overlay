"""Exact instruction-layout evidence, never tokenizer counts or cache claims."""
import hashlib
from .builder import build_static_user_prefix
from .instruction_packs import instruction_locale
from .localization import LOCALIZATION_POLICY_VERSION, build_style_examples
from .styles import select_style
from backend.lens.languages import normalize


def prompt_layout(system, user, *, lang, source_lang="", structured=False,
                  examples=True, memory_mode=None, selected_style=None, conversation_records=False):
    style = select_style(lang)[0] if selected_style is None else str(selected_style).strip()
    prefix = build_static_user_prefix(lang, structured_output=structured, source_lang=source_lang,
                                     style_examples=examples, selected_style=style, conversation_records=conversation_records)
    base_persistent_prefix = build_static_user_prefix(lang, structured_output=structured, source_lang=source_lang,
                                                     style_examples=False, selected_style=style, conversation_records=conversation_records)
    # Conversation stores/replays the exact first provider-visible User anchor.
    persistent_prefix = prefix if conversation_records else base_persistent_prefix
    if not user.startswith(prefix + "\n\n"):
        raise ValueError("prompt_static_prefix_mismatch")
    # Count only instruction blocks, not incidental copies inside OCR/context.
    system_copies, user_copies = system.count(style), prefix.count(style)
    if system_copies != 1 or user_copies != 0:
        raise ValueError("prompt_style_delivery_mismatch")
    digest = lambda text: hashlib.sha256(text.encode("utf-8")).hexdigest()
    return {"schema": "tp.prompt_layout/1", "policyVersion": LOCALIZATION_POLICY_VERSION,
            "styleRole": "system", "systemStyleCopies": system_copies, "userStyleCopies": user_copies,
            "styleChars": len(style), "styleSha256": digest(style),
            "instructionLocale": instruction_locale(lang), "targetLang": normalize(lang),
            "sourceLang": normalize(source_lang), "examplesEnabled": examples is not False,
            "examplesIncluded": bool(examples is not False and build_style_examples(lang, [], structured_output=structured, source_lang=source_lang)),
            "memoryMode": memory_mode if memory_mode in ("off", "terms", "full") else "legacy_filtered",
            "systemChars": len(system), "userStaticChars": len(prefix),
            "userPersistentStaticChars": len(persistent_prefix),
            "bootstrapExamplesChars": len(build_style_examples(lang, [], structured_output=structured, source_lang=source_lang) or "") if examples is not False else 0,
            "dynamicChars": len(user)-len(prefix),
            "systemSha256": digest(system), "userStaticSha256": digest(prefix),
            "userPersistentStaticSha256": digest(persistent_prefix),
            "staticPrefixSha256": digest(system+"\0"+prefix),
            "countUnit": "unicode_characters", "styleCountScope": "instruction_blocks",
            "cacheHit": None, "cacheSupport": "unknown"}
