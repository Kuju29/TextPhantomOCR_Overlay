"""Robust parsing of AI responses.

LLMs frequently wrap their output in code fences, add stray prose, emit raw
newlines inside JSON strings, or get "stuck" repeating a character.  These
helpers recover the actual translated text from that mess.

Two extraction modes are supported:
- ``parse_text`` — the response is expected to be plain marked text.
- ``parse_json`` — the response is expected to be ``{"aiTextFull": "..."}``.
"""

from __future__ import annotations

import json
import re


def strip_wrappers(s: str) -> str:
    """Remove code fences and ``<AiTextFull>`` tags, normalise newlines."""
    t = (s or "").strip()
    if not t:
        return ""
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    if "```" in t:
        t = re.sub(r"```[a-zA-Z0-9_-]*", "", t)
        t = t.replace("```", "")
    t = re.sub(r"</?AiTextFull>", "", t, flags=re.IGNORECASE).strip()
    return t


def _sanitize_json_like(raw: str) -> str:
    """Make almost-JSON text parseable.

    Walks the text character by character.  Inside string literals it escapes
    raw newlines/tabs and clips runs of a repeated character to at most 3 (a
    cheap guard against models that loop on ``"……………"``).  Outside strings
    the text is passed through unchanged.
    """
    t = strip_wrappers(raw)
    if not t:
        return ""

    out: list[str] = []
    in_str = False
    esc = False
    run_ch = ""
    run_len = 0

    def flush_run() -> None:
        nonlocal run_ch, run_len
        if run_len:
            out.append(run_ch * min(run_len, 3))
        run_ch = ""
        run_len = 0

    for ch in t:
        if in_str:
            if esc:
                flush_run()
                out.append(ch)
                esc = False
                continue
            if ch == "\\":
                flush_run()
                out.append(ch)
                esc = True
                continue
            if ch == '"':
                flush_run()
                out.append(ch)
                in_str = False
                continue
            if ch == "\n":
                flush_run()
                out.append("\\n")
                continue
            if ch == "\t":
                flush_run()
                out.append("\\t")
                continue
            if ch == run_ch:
                run_len += 1
                continue
            flush_run()
            run_ch = ch
            run_len = 1
            continue

        flush_run()
        if ch == '"':
            out.append(ch)
            in_str = True
            esc = False
            continue
        out.append(ch)

    flush_run()
    return "".join(out)


def _extract_first_json(raw: str) -> object:
    """Find and parse the first balanced ``{...}`` object in ``raw``."""
    t = _sanitize_json_like(raw)
    if not t:
        raise ValueError("AI returned empty text")
    if t.find("{") < 0:
        raise ValueError("AI returned no JSON object")

    in_str = False
    esc = False
    depth = 0
    json_start: int | None = None

    for i in range(t.find("{"), len(t)):
        ch = t[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                json_start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and json_start is not None:
                    return json.loads(t[json_start : i + 1])

    raise ValueError("Failed to parse AI JSON")


def parse_json(raw: str) -> str:
    """Extract ``aiTextFull`` from a JSON-style AI response."""
    obj = _extract_first_json(raw)
    if not isinstance(obj, dict):
        raise ValueError("AI JSON is not an object")
    txt = obj.get("aiTextFull")
    if txt is None:
        txt = obj.get("textFull")
    if txt is None:
        raise ValueError("AI JSON missing aiTextFull")
    t = str(txt)
    if "\\n" in t and "\n" not in t:
        t = t.replace("\\n", "\n")
    return t.replace("\r\n", "\n").replace("\r", "\n").strip()


def parse_character_memo(memo: str) -> list[dict]:
    """Parse the ``<<TP_MEMO>>`` block into character entries.

    Expected line format (loosely enforced — LLM output varies):

        Name | gender: female | speech: สุภาพ ค่ะ | note: guild receptionist

    Returns a list of ``{"name", "gender", "speech", "note"}`` dicts with
    empty/unknown fields omitted.  Best-effort: malformed lines are skipped.
    """
    out: list[dict] = []
    for line in (memo or "").splitlines():
        line = line.strip().lstrip("-•*").strip()
        if not line or line.lower() in ("none", "n/a", "-"):
            continue
        parts = [p.strip() for p in line.split("|")]
        name = parts[0].strip()
        if not name or len(name) > 40:
            continue
        entry: dict = {"name": name}
        for part in parts[1:]:
            key, _, val = part.partition(":")
            key = key.strip().lower()
            val = val.strip()
            if key == "notes":
                key = "note"
            if key in ("gender", "speech", "note") and val and val.lower() != "unknown":
                entry[key] = val[:120]
        out.append(entry)
        if len(out) >= 12:
            break
    return out


def parse_text(raw: str) -> str:
    """Extract translated text from a plain-text AI response.

    Falls back to :func:`parse_json` if the model ignored instructions and
    returned a JSON object anyway.
    """
    t = strip_wrappers(raw)
    if not t:
        raise ValueError("AI returned empty text")
    if t.lstrip().startswith("{"):
        return parse_json(t)
    if "\\n" in t and "\n" not in t:
        t = t.replace("\\n", "\n")
    t = re.sub(r"^aiTextFull\s*[:=]\s*", "", t, flags=re.IGNORECASE).strip()
    return t
