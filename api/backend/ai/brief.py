"""Chapter Brief — ONE AI call that READS the whole chapter before any page
is translated.

⛔ DORMANT (18 Jul 2026): the extension no longer calls ``POST /ai/brief`` —
the user unplugged this flow (pass 1 ran "translated" jobs under an AI batch,
which conflicts with the chosen "every source runs as itself" model).
Read STATUS-CURRENT.md (extension root) before wiring it back in.

This is the heart of the read-then-translate architecture (see
DESIGN-TRANSLATION-TH.md): a human translator reads the chapter first, then
translates.  The brief call receives the OCR text of every page IN ORDER plus
the existing series memory, and returns a single frozen SERIES CONTEXT:

- ``bible``      — rewritten running summary (premise, scene, relationships,
                   tone) the translator must keep in mind;
- ``characters`` — accumulated character sheet (name / gender / speech / note);
- ``speakers``   — per page, per paragraph: who most likely speaks it, decided
                   with WHOLE-chapter evidence (far more reliable than per-page
                   guessing);
- ``terms``      — new recurring names/terms found in this chapter.

Every page of the chapter is then translated IN PARALLEL against this one
immutable context, so nothing races and the per-page prompts stay small
(no per-page memo/state emission).
"""

from __future__ import annotations

import re
from typing import Any, Final

from backend.ai import parsing, prompts, throttle
from backend.ai.clients import anthropic as anthropic_client
from backend.ai.clients import gemini as gemini_client
from backend.ai.clients import openai_compat
from backend.ai.providers import (
    is_hf_provider,
    is_local_provider,
    resolve_base_url,
    resolve_model,
    resolve_provider,
)
from backend.lens.languages import normalize as normalize_lang

# Input caps: a chapter's OCR text is small (a dense page is ~500-1500 chars),
# but clamp defensively so a pathological chapter cannot blow the context.
MAX_PAGES: Final[int] = 80
MAX_PAGE_CHARS: Final[int] = 4000
MAX_TOTAL_CHARS: Final[int] = 120_000
MAX_BIBLE_CHARS: Final[int] = 1500


BRIEF_SYSTEM: Final[str] = (
    "You are the lead translator preparing to translate a manga chapter into {lang_name}.\n"
    "You are given the OCR source text of EVERY page of the chapter, in reading order, plus the series "
    "memory accumulated from earlier chapters. READ everything first, then output the updated SERIES "
    "CONTEXT — the notes the translation team will rely on. Do NOT translate the pages.\n"
    "Output EXACTLY these four blocks, in this order, nothing else:\n"
    "\n"
    "<<TP_BIBLE>>\n"
    "Max 12 short plain-text lines in {lang_name}: premise (1-2 lines), current scene/arc + mood, key "
    "relationships (A-B: rivals / siblings / master-servant), overall tone, and any fact a translator "
    "must not forget. MERGE the previous bible with what this chapter adds — rewrite it fresh, never "
    "just append.\n"
    "\n"
    "<<TP_CHARS>>\n"
    "One line per named character who appears or is addressed, format:\n"
    "Name | gender: male/female/unknown | speech: how they talk in {lang_name} | note: role/relationship\n"
    "gender ONLY with explicit evidence (he/she, gendered title, gendered self-speech); otherwise "
    "unknown — a wrong guess poisons every later page. Merge with the previous sheet; correct it when "
    "this chapter proves an entry wrong. Max 12 lines.\n"
    "\n"
    "<<TP_SPEAKERS>>\n"
    "One line per page, format:  page N: 0=Name; 1=Name; 2=unknown\n"
    "Map EVERY numbered paragraph of that page to its most likely speaker, using the WHOLE chapter as "
    "evidence (who answers whom, names called out, running scenes). Narration boxes = narrator. Write "
    "unknown when truly unsure — never guess a name.\n"
    "\n"
    "<<TP_TERMS>>\n"
    "NEW recurring names/terms first seen this chapter, one per line:  source => translation in {lang_name}\n"
    "Names, places, skills, items, organizations ONLY — never full sentences. Max 15 lines. Write none "
    "if nothing new."
)


def _clamp(text: str, limit: int) -> str:
    t = str(text or "").strip()
    return t[:limit].rstrip() if len(t) > limit else t


def build_brief_user(pages: list[dict], memory: dict | None) -> str:
    """Render the brief request: previous memory, then every page's text.

    ``pages``  — [{"index": 1-based page number, "text": OCR full text}].
    Paragraphs inside a page are numbered ``<0>`` ``<1>`` … (split on blank
    lines) so the SPEAKERS block can reference them by index.
    ``memory`` — {"bible": str, "characters": [...], "terms"/"glossary": [...]}.
    """
    mem = memory or {}
    parts: list[str] = []

    bible = _clamp(str(mem.get("bible") or ""), MAX_BIBLE_CHARS)
    parts.append("PREVIOUS BIBLE:\n" + (bible if bible else "none"))

    chars = mem.get("characters") or []
    char_lines: list[str] = []
    for c in chars[:30]:
        if not isinstance(c, dict) or not str(c.get("name") or "").strip():
            continue
        bits = [str(c["name"]).strip()]
        for k in ("gender", "speech", "note"):
            v = str(c.get(k) or "").strip()
            if v:
                bits.append(f"{k}: {v}")
        char_lines.append(" | ".join(bits))
    parts.append("PREVIOUS CHARACTER SHEET:\n" + ("\n".join(char_lines) if char_lines else "none"))

    terms = mem.get("terms") or mem.get("glossary") or []
    term_lines = [
        f"{str(t.get('src')).strip()} => {str(t.get('tgt')).strip()}"
        for t in terms[:40]
        if isinstance(t, dict) and str(t.get("src") or "").strip() and str(t.get("tgt") or "").strip()
    ]
    parts.append("KNOWN TERMS:\n" + ("\n".join(term_lines) if term_lines else "none"))

    total = 0
    page_parts: list[str] = []
    for p in (pages or [])[:MAX_PAGES]:
        if not isinstance(p, dict):
            continue
        idx = int(p.get("index") or 0)
        text = _clamp(str(p.get("text") or ""), MAX_PAGE_CHARS)
        if not text:
            continue
        paras = [seg.strip() for seg in re.split(r"\n\s*\n", text) if seg.strip()]
        if not paras:
            paras = [text]
        body = "\n".join(f"<{i}> {seg}" for i, seg in enumerate(paras))
        block = f"=== PAGE {idx} ===\n{body}"
        total += len(block)
        if total > MAX_TOTAL_CHARS:
            break
        page_parts.append(block)
    parts.append("CHAPTER PAGES (source text, reading order):\n\n" + "\n\n".join(page_parts))
    return "\n\n".join(parts)


_PAGE_LINE_RE: Final[re.Pattern[str]] = re.compile(r"^page\s*(\d+)\s*[:：]\s*(.+)$", re.IGNORECASE)
_TERM_LINE_RE: Final[re.Pattern[str]] = re.compile(r"^(.+?)\s*(?:=>|->|→)\s*(.+)$")


def _section(text: str, start: str, all_marks: tuple[str, ...]) -> str:
    """Extract the body of section ``start`` up to the next known marker."""
    t = text or ""
    i = t.find(start)
    if i < 0:
        return ""
    body = t[i + len(start):]
    cut = len(body)
    for m in all_marks:
        if m == start:
            continue
        j = body.find(m)
        if 0 <= j < cut:
            cut = j
    return body[:cut].strip()


_MARKS: Final[tuple[str, ...]] = ("<<TP_BIBLE>>", "<<TP_CHARS>>", "<<TP_SPEAKERS>>", "<<TP_TERMS>>")


def parse_brief(raw: str) -> dict[str, Any]:
    """Parse the brief response into the frozen series-context dict.

    Best-effort: a malformed section degrades to empty rather than failing the
    whole brief — the page translations then simply run with less context.
    """
    text = parsing.strip_wrappers(raw)

    bible = _clamp(_section(text, "<<TP_BIBLE>>", _MARKS), MAX_BIBLE_CHARS)
    if bible.lower() == "none":
        bible = ""

    characters = parsing.parse_character_memo(_section(text, "<<TP_CHARS>>", _MARKS))

    speakers: dict[str, dict[str, str]] = {}
    for line in _section(text, "<<TP_SPEAKERS>>", _MARKS).splitlines():
        line = line.strip().lstrip("-•*").strip()
        m = _PAGE_LINE_RE.match(line)
        if not m:
            continue
        pairs = parsing.parse_speaker_pairs(m.group(2))
        if pairs:
            speakers[m.group(1)] = pairs

    terms: list[dict[str, str]] = []
    for line in _section(text, "<<TP_TERMS>>", _MARKS).splitlines():
        line = line.strip().lstrip("-•*").strip()
        if not line or line.lower() == "none":
            continue
        m = _TERM_LINE_RE.match(line)
        if not m:
            continue
        src, tgt = m.group(1).strip(), m.group(2).strip()
        # min_len=2: the brief AUTHORS these deliberately as terms, and CJK
        # names/terms are often exactly 2 chars (田中, 魔剣, 勇者).
        if src and tgt and prompts.looks_like_term(src, tgt, min_len=2):
            terms.append({"src": src, "tgt": tgt})
        if len(terms) >= 15:
            break

    return {"bible": bible, "characters": characters, "speakers": speakers, "terms": terms}


def _generate(api_key: str, provider: str, model: str, base_url: str,
              system_text: str, user_text: str) -> str:
    """Minimal provider dispatch (mirrors translate.py's routing)."""
    if provider == "gemini":
        r = gemini_client.generate(api_key, model, system_text, [user_text])
    elif provider == "anthropic":
        r = anthropic_client.generate(api_key, model, system_text, [user_text])
    elif is_hf_provider(provider, base_url):
        r = throttle.generate_with_backoff(
            api_key, base_url, model, system_text, [user_text], allow_hf_fallback=True,
        )
    else:
        r = openai_compat.generate(
            api_key, base_url, model, system_text, [user_text], allow_hf_fallback=False,
        )
    return r.text


def run_chapter_brief(
    pages: list[dict],
    memory: dict | None,
    ai: dict | None,
    lang: str,
) -> dict[str, Any]:
    """Run the chapter-brief call and return the frozen series context.

    ``ai`` carries the same fields the translate payload uses
    (api_key / provider / model / base_url).  Raises ``ValueError`` on missing
    key (non-local providers) — the caller decides how to fall back.
    """
    ai = ai or {}
    api_key = str(ai.get("api_key") or "").strip()
    provider_hint = str(ai.get("provider") or "auto").strip().lower()
    base_hint = str(ai.get("base_url") or "").strip().lower()
    looks_local = (
        is_local_provider(provider_hint)
        or "localhost" in base_hint or "127.0.0.1" in base_hint or "0.0.0.0" in base_hint
    )
    if not api_key and not looks_local:
        raise ValueError("AI api_key is required")

    provider = resolve_provider(str(ai.get("provider") or "auto"), api_key)
    if not api_key and looks_local and provider in ("", "auto", "openai"):
        provider = "ollama"
    model = resolve_model(provider, str(ai.get("model") or "auto"))
    base_url = resolve_base_url(provider, str(ai.get("base_url") or "auto"))
    if not api_key and is_local_provider(provider):
        api_key = "local"

    lang_code = normalize_lang(lang)
    lang_name = {"th": "Thai", "en": "English", "ja": "Japanese",
                 "zh": "Chinese", "ko": "Korean", "id": "Indonesian"}.get(lang_code, lang_code)
    system_text = BRIEF_SYSTEM.format(lang_name=lang_name)
    user_text = build_brief_user(pages, memory)

    raw = _generate(api_key, provider, model, base_url, system_text, user_text)
    ctx = parse_brief(raw)
    ctx["meta"] = {
        "provider": provider,
        "model": model,
        "lang": lang_code,
        "pages": len(pages or []),
    }
    return ctx
