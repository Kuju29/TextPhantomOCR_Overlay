from __future__ import annotations
from dataclasses import dataclass
from typing import Final, NoReturn

import hashlib, json, re

from backend.ai.errors import ModelOutputContractError
from .wire import PREFIX, SUFFIX, END_MARKER, DONE_MARKER

_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(\d+)>>")
_WIRE_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(\d+):")
MEMO_MARKER: Final[str] = "<<TP_MEMO>>"

@dataclass(frozen=True)
class DecodedTranslation:
    """One model answer decoded without changing any translated value."""
    ai_text_full: str
    memo: str
    response_shape: str
    accepted_losslessly: bool = True
    content_modified: bool = False
    missing_ids: tuple[str, ...] = ()
    end_marker_present: bool = False
    accepted_without_end_marker: bool = False
    # Structural diagnostics only. Never retain response text in metadata.
    discarded_ids: tuple[str, ...] = ()
    malformed_line_count: int = 0
    duplicate_ids: tuple[str, ...] = ()
    ignored_prose_chars: int = 0

class _DuplicateJsonKey(ValueError):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key

def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    obj: dict = {}
    for key, value in pairs:
        if key in obj:
            raise _DuplicateJsonKey(key)
        obj[key] = value
    return obj

_FENCE_RE: Final[re.Pattern[str]] = re.compile(
    r"\A```(?:json)?[ \t]*\n?([\s\S]*?)\n?```\Z", re.IGNORECASE
)
_XML_WRAPPER_RE: Final[re.Pattern[str]] = re.compile(
    r"\A<AiTextFull>([\s\S]*)</AiTextFull>\Z", re.IGNORECASE
)

def _unwrap_known_response(raw: str) -> tuple[str, bool]:
    """Strip only whole-response wrappers; never search/repair content."""
    original = str(raw or "")
    legacy_text = original.strip()
    fenced = _FENCE_RE.fullmatch(legacy_text)
    if fenced:
        return fenced.group(1).strip(), True
    tagged = _XML_WRAPPER_RE.fullmatch(legacy_text)
    if tagged:
        return tagged.group(1).strip(), True
    # Canonical records have a physical-line grammar, so preserve blank lines
    # and surrounding whitespace until that grammar has been checked.
    return original, False

def _canonical_markers(values: list[str]) -> str:
    """Attach protocol markers while preserving every value byte-for-byte."""
    return "\n\n".join(f"{PREFIX}{i}{SUFFIX}\n{value}" for i, value in enumerate(values))

# Aligns received values to the full expected sequence, leaving an empty string
# where the model omitted an id. An omission is reported, never invented.
def _align_to_expected(
    received: list[str], values: list[str], expected: list[str]
) -> tuple[list[str], list[str]]:
    by_id = dict(zip(received, values))
    aligned = [by_id.get(item, "") for item in expected]
    missing = [item for item in expected if item not in by_id]
    return aligned, missing

def _contract_error(message: str, shape: str, **details: object) -> NoReturn:
    raise ModelOutputContractError(message, response_shape=shape, **details)

def _observed_shape(raw: str) -> str:
    text = str(raw or "").strip()
    if not text: return "empty"
    if text.startswith("```"): return "markdown_fence"
    if text.startswith("{") or text.startswith("["): return "json"
    if DONE_MARKER in text: return "tp_done_marker"
    if END_MARKER in text or _MARKER_RE.search(text): return "legacy_open_end_markers"
    if _WIRE_MARKER_RE.search(text): return "compact_records_malformed"
    if text.startswith("<"): return "xml_or_tagged"
    return "unmarked_text"

def _strict_contract_error(raw: str, subtype: str, **details: object) -> NoReturn:
    payload = str(raw or "").encode("utf-8")
    observed = _observed_shape(raw)
    error = ModelOutputContractError(
        "AI output does not match the selected translation contract", response_shape=observed,
        expectedContract="tp.translation.compact-records/1", observedShape=observed,
        observedSha256=hashlib.sha256(payload).hexdigest(),
        validatorSubtype=subtype, **details,
    )
    error.code = "AI_OUTPUT_CONTRACT_MISMATCH"
    raise error

def _decode_strict_records(raw: str, expected: list[str]) -> DecodedTranslation:
    """Extract expected closed records; provider prose is irrelevant."""
    text = str(raw or "")
    if not text:
        _strict_contract_error(text, "empty_output", missingIds=expected)
    parsed: list[tuple[str, str]] = []
    malformed: list[str] = []
    all_claims: list[str] = []
    stack: list[dict[str, str]] = []
    pending: list[tuple[str, str]] = []
    island_invalid = False
    island_invalid_ids: set[str] = set()
    def poison_island() -> None:
        nonlocal island_invalid
        island_invalid = True
        island_invalid_ids.update(frame["id"] for frame in stack)
        island_invalid_ids.update(item for item, _ in pending)
    at = 0
    while at < len(text):
        if text.startswith("<<>>", at) and stack:
            bridge = re.match(r"<<>>TP_(P\d+)(?::|\s)", text[at:])
            if bridge:
                frame = stack.pop()
                pending.append((frame["id"], frame["value"]))
                all_claims.append(bridge.group(1))
                stack.append({"id": bridge.group(1), "value": ""})
                at += len(bridge.group(0))
                continue
            poison_island()
            at += 4
            continue
        if text.startswith("<<TP_P", at):
            numeric = re.match(r"<<TP_(P\d+)", text[at:])
            if numeric:
                all_claims.append(numeric.group(1))
            header = re.match(r"<<TP_(P\d+)(?::|\s)", text[at:])
            if header:
                if not stack:
                    pending = []
                    island_invalid = False
                    island_invalid_ids = set()
                stack.append({"id": header.group(1), "value": ""})
                at += len(header.group(0))
                continue
            if numeric:
                malformed.append(numeric.group(1))
            if stack:
                poison_island()
            malformed_close = text.find(">>", at + 6)
            at = len(text) if malformed_close < 0 else malformed_close + 2
            continue
        if text.startswith("<<", at) and stack:
            poison_island()
            invalid_close = text.find(">>", at + 2)
            if invalid_close < 0:
                at = len(text)
                continue
            bare_peer = re.match(r"TP_(P\d+)(?::|\s)", text[invalid_close + 2:])
            if bare_peer:
                all_claims.append(bare_peer.group(1))
                malformed.append(bare_peer.group(1))
                island_invalid_ids.add(bare_peer.group(1))
            at = invalid_close + 2
            continue
        if text.startswith(">>", at) and stack:
            frame = stack.pop()
            pending.append((frame["id"], frame["value"]))
            at += 2
            if not stack:
                if island_invalid:
                    malformed.extend(island_invalid_ids)
                    malformed.extend(item for item, _ in pending)
                else:
                    parsed.extend(pending)
                pending = []
                island_invalid = False
                island_invalid_ids = set()
            continue
        if stack:
            stack[-1]["value"] += text[at]
        at += 1
    if stack:
        malformed.extend(frame["id"] for frame in stack)
        malformed.extend(item for item, _ in pending)
        malformed.extend(island_invalid_ids)
    received = [item for item, _ in parsed]
    duplicates = sorted({item for item in all_claims if all_claims.count(item) > 1})
    extra = [item for item in all_claims if item not in expected]
    invalid = set(duplicates + malformed)
    missing = [item for item in expected if item not in received or item in invalid]
    empty = [item for item, value in parsed if not value.strip()]
    by_id = {item: value for item, value in parsed
             if item in expected and item not in invalid}
    omitted = [item for item in expected if item not in by_id or not by_id[item].strip()]
    record_chars = sum(len(f"<<TP_{item}:{value}>>") for item, value in parsed)
    return DecodedTranslation(
        _canonical_markers([by_id.get(item, "") for item in expected]), "", "plain_records_v1",
        missing_ids=tuple(omitted),
        discarded_ids=tuple(sorted(set(extra + duplicates))),
        malformed_line_count=len(malformed),
        duplicate_ids=tuple(duplicates),
        ignored_prose_chars=max(0, len(text) - record_chars),
    )

# Rejects an ambiguous id set. A missing id is not ambiguous: it is one unit the
# model did not answer, and it is reported rather than treated as a broken page.
def _validate_id_set(
    received: list[str], expected: list[str], shape: str, *, ordered: bool
) -> None:
    duplicates = sorted({item for item in received if received.count(item) > 1})
    extra = [item for item in received if item not in expected]
    if duplicates or extra:
        _contract_error(
            "AI translation IDs do not match the input",
            shape,
            expectedIds=expected,
            receivedIds=received,
            missingIds=[item for item in expected if item not in received],
            extraIds=extra,
            duplicateIds=duplicates,
        )
    if ordered and received != [item for item in expected if item in received]:
        _contract_error(
            "AI translation IDs are out of order",
            shape,
            expectedIds=expected,
            receivedIds=received,
            outOfOrderIds=received,
        )

def _decode_marker_text(
    text: str, expected: list[str], shape: str
) -> tuple[list[str], str, list[str], bool]:
    """Decode a complete marker answer; any structural uncertainty is fatal."""
    # New generations terminate explicitly.  Historical marker responses did
    # not, so absence remains accepted as decoder-only compatibility.
    if text.count(END_MARKER) > 1:
        _contract_error("AI answer contains duplicate end markers", shape, duplicateFields=["end"])
    end_present = END_MARKER in text
    if end_present:
        before, end, trailing = text.partition(END_MARKER)
        if trailing.strip():
            _contract_error("AI answer contains text after end marker", shape, ambiguous=["textAfterEnd"])
        text = before.rstrip()
    if text.count(MEMO_MARKER) > 1:
        _contract_error("AI answer contains duplicate memo markers", shape, duplicateFields=["memo"])
    body, separator, memo = text.partition(MEMO_MARKER)
    if separator and _MARKER_RE.search(memo):
        _contract_error("AI answer has translation markers after memo", shape, ambiguous=["markerAfterMemo"])
    matches = list(_MARKER_RE.finditer(body))
    if body.count(PREFIX) != len(matches):
        _contract_error("AI answer contains malformed paragraph markers", shape, ambiguous=["malformedMarker"])
    if not matches:
        _contract_error("AI answer contains no paragraph markers", shape, missingIds=expected)
    if body[: matches[0].start()].strip():
        _contract_error("AI answer contains text outside paragraph markers", shape, ambiguous=["leadingText"])
    received = [f"P{match.group(1)}" for match in matches]
    _validate_id_set(received, expected, shape, ordered=False)
    values: list[str] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        values.append(body[match.end() : end].strip())
    aligned, missing = _align_to_expected(received, values, expected)
    return aligned, memo.strip(), missing, end_present

def _decode_line_text(text: str, expected: list[str]) -> list[str] | None:
    """Decode strict one-line output; return None for legacy marker shapes."""
    lines = [line for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if line.strip()]
    matches = [re.fullmatch(r"\s*<<TP_(P\d+)>>[ \t]+(.+?)\s*", line) for line in lines]
    if not matches or any(match is None for match in matches):
        return None
    received = [match.group(1) for match in matches if match]
    _validate_id_set(received, expected, "plain_lines_v1", ordered=True)
    missing = [item for item in expected if item not in received]
    values = [match.group(2).strip() for match in matches if match]
    empty = [item for item, value in zip(received, values) if not value]
    if missing or empty:
        _contract_error("AI answer did not complete the line contract", "plain_lines_v1",
                        missingIds=missing, emptyIds=empty,
                        validatorSubtype="missing_ids" if missing else "empty_ids")
    return values

def _decode_wire_text(
    text: str, expected: list[str]
) -> tuple[list[str], list[str], list[str], int] | None:
    """Decode attributable ``<<TP_Pn:text>>`` records without guessing.

    Missing and empty records are content defects: valid records are retained
    so the pipeline can repair only the defective IDs. Structural ambiguity is
    rejected. The greedy value permits literal ``>>``; the final pair closes
    the physical-line record.
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    if not any(_WIRE_MARKER_RE.search(line) for line in lines):
        return None
    if any(separator in normalized for separator in ("\u0085", "\u2028", "\u2029")):
        _contract_error("AI answer contains a Unicode line separator", "plain_records_v1",
                        validatorSubtype="unicode_line_separator")
    received: list[str] = []
    values: list[str] = []
    malformed_lines: list[str] = []
    tainted_ids: set[str] = set()
    for line in lines:
        match = re.fullmatch(r"[ \t]*<<TP_P(\d+):(.*)>>[ \t]*", line)
        if match is None:
            # A second record opener on one physical line is structurally
            # ambiguous even when one apparent record happens to be valid.
            identifiable = re.findall(r"<<TP_P(\d+)\b", line)
            if len(identifiable) > 1:
                _contract_error("AI answer contains concatenated records", "plain_records_v1",
                                receivedIds=received, validatorSubtype="concatenated_record")
            # A marker-looking token whose ID cannot be identified must never
            # be guessed or salvaged around.
            if "<<TP_P" in line and not identifiable:
                _contract_error("AI answer contains an ambiguous record ID", "plain_records_v1",
                                receivedIds=received, validatorSubtype="ambiguous_id")
            for raw_id in identifiable:
                item = f"P{raw_id}"
                if item not in expected:
                    _contract_error("AI answer contains an unexpected record ID", "plain_records_v1",
                                    receivedIds=received, extraIds=[item],
                                    validatorSubtype="extra_id")
                tainted_ids.add(item)
            malformed_lines.append(line)
            continue
        value = match.group(2)
        if _WIRE_MARKER_RE.search(value):
            _contract_error("AI answer contains nested or concatenated records", "plain_records_v1",
                            receivedIds=received, validatorSubtype="nested_record")
        received.append(f"P{match.group(1)}")
        values.append(value.strip())
    _validate_id_set(received, expected, "plain_records_v1", ordered=False)
    if malformed_lines:
        # Salvage is intentionally partial-only. A response which appears to
        # answer every ID but also contains prose/malformed output is not a
        # strict complete answer and remains a contract error.
        trustworthy = [item for item in received if item not in tainted_ids]
        if not trustworthy or all(item in trustworthy for item in expected):
            _contract_error("AI answer contains prose or malformed records", "plain_records_v1",
                            receivedIds=received,
                            discardedIds=sorted(tainted_ids),
                            malformedLineCount=len(malformed_lines),
                            validatorSubtype="malformed_record")
        kept_values = [value for item, value in zip(received, values) if item not in tainted_ids]
        received = trustworthy
        values = kept_values
    aligned, omitted = _align_to_expected(received, values, expected)
    empty = [item for item, value in zip(expected, aligned) if not value]
    missing = [item for item in expected if item in set(omitted) | set(empty)]
    return aligned, missing, sorted(tainted_ids), len(malformed_lines)

def decode_legacy_translation_response(
    raw: str, expected: list[str], *, require_complete: bool = False,
    allow_complete_without_end: bool = False,
) -> DecodedTranslation:
    """Decode one generation using only lossless, unambiguous response shapes.

    Accepted shapes are the canonical envelope, legacy flat P0..Pn JSON, a
    legacy ``aiTextFull`` JSON string containing all markers, and complete
    plain markers.  No value is guessed, filled, merged, renumbered or sent
    back to a model for repair.
    """
    if not expected or expected != [f"P{i}" for i in range(len(expected))]:
        raise ValueError("expected IDs must be the exact sequence P0..Pn")
    text, wrapped = _unwrap_known_response(raw)
    if not text:
        _contract_error("AI returned empty text", "empty", missingIds=expected)

    wire = _decode_wire_text(text, expected)
    if wire is not None:
        values, missing_ids, discarded_ids, malformed_line_count = wire
        return DecodedTranslation(
            _canonical_markers(values), "", "plain_records_v1",
            missing_ids=tuple(missing_ids), end_marker_present=False,
            accepted_without_end_marker=True,
            discarded_ids=tuple(discarded_ids),
            malformed_line_count=malformed_line_count,
        )

    # Legacy response shapes historically allowed surrounding whitespace.
    text = text.strip()

    if text.startswith("{") or text.endswith("}"):
        shape = "json_wrapped" if wrapped else "json"
        if not (text.startswith("{") and text.endswith("}")):
            _contract_error("AI returned an incomplete JSON object", shape, ambiguous=["partialJson"])
        try:
            obj = json.loads(text, object_pairs_hook=_unique_object)
        except _DuplicateJsonKey as exc:
            _contract_error("AI JSON contains a duplicate key", shape, duplicateFields=[exc.key])
        except (TypeError, ValueError, json.JSONDecodeError):
            _contract_error("AI returned invalid JSON", shape, ambiguous=["invalidJson"])
        if not isinstance(obj, dict):
            _contract_error("AI JSON is not an object", shape, fieldTypeErrors=["$:object"])

        keys = list(obj)
        if "translations" in obj:
            shape = "canonical_envelope_wrapped" if wrapped else "canonical_envelope"
            missing_fields = [key for key in ("translations", "memo") if key not in obj]
            extra_fields = [key for key in keys if key not in ("translations", "memo")]
            if missing_fields or extra_fields:
                _contract_error(
                    "AI envelope fields do not match the contract",
                    shape,
                    missingFields=missing_fields,
                    extraFields=extra_fields,
                    topLevelKeys=keys,
                )
            translations = obj.get("translations")
            memo = obj.get("memo")
            if not isinstance(translations, list) or not isinstance(memo, str):
                failures = []
                if not isinstance(translations, list):
                    failures.append("translations:array")
                if not isinstance(memo, str):
                    failures.append("memo:string")
                _contract_error("AI envelope contains a wrong field type", shape, fieldTypeErrors=failures)
            ids: list[str] = []
            values: list[str] = []
            entry_errors: list[str] = []
            for index, entry in enumerate(translations):
                if not isinstance(entry, dict):
                    entry_errors.append(f"translations[{index}]:object")
                    continue
                extra = [key for key in entry if key not in ("id", "text")]
                missing = [key for key in ("id", "text") if key not in entry]
                if extra or missing:
                    entry_errors.append(f"translations[{index}]:fields")
                    continue
                if not isinstance(entry["id"], str):
                    entry_errors.append(f"translations[{index}].id:string")
                    continue
                if not isinstance(entry["text"], str):
                    entry_errors.append(f"translations[{index}].text:string")
                    continue
                ids.append(entry["id"])
                values.append(entry["text"])
            if entry_errors:
                _contract_error("AI envelope contains an invalid entry", shape, fieldTypeErrors=entry_errors)
            _validate_id_set(ids, expected, shape, ordered=False)
            aligned, missing_ids = _align_to_expected(ids, values, expected)
            return DecodedTranslation(
                _canonical_markers(aligned), memo, shape, missing_ids=tuple(missing_ids)
            )

        p_keys = [key for key in keys if re.fullmatch(r"P\d+", key)]
        if p_keys:
            shape = "flat_json_wrapped" if wrapped else "flat_json"
            allowed = set(expected) | {"memo"}
            missing = [item for item in expected if item not in obj]
            extra = [key for key in keys if key not in allowed]
            wrong_types = [key for key in expected if key in obj and not isinstance(obj[key], str)]
            if "memo" in obj and not isinstance(obj["memo"], str):
                wrong_types.append("memo")
            if extra or wrong_types:
                _contract_error(
                    "AI flat JSON does not match the input",
                    shape,
                    missingIds=missing,
                    extraIds=[key for key in extra if re.fullmatch(r"P\d+", key)],
                    extraFields=[key for key in extra if not re.fullmatch(r"P\d+", key)],
                    nonStringFields=wrong_types,
                    topLevelKeys=keys,
                )
            if len(missing) == len(expected):
                _contract_error(
                    "AI flat JSON answered none of the input units",
                    shape,
                    missingIds=missing,
                    topLevelKeys=keys,
                )
            values = [str(obj.get(item) or "") for item in expected]
            return DecodedTranslation(
                _canonical_markers(values), str(obj.get("memo") or ""), shape,
                missing_ids=tuple(missing),
            )

        if "aiTextFull" in obj:
            shape = "ai_text_full_json_wrapped" if wrapped else "ai_text_full_json"
            extra = [key for key in keys if key not in ("aiTextFull", "memo")]
            wrong_types = [
                key
                for key in ("aiTextFull", "memo")
                if key in obj and not isinstance(obj[key], str)
            ]
            if extra or wrong_types:
                _contract_error(
                    "AI aiTextFull JSON does not match the legacy contract",
                    shape,
                    extraFields=extra,
                    nonStringFields=wrong_types,
                )
            values, inline_memo, missing_ids, end_present = _decode_marker_text(obj["aiTextFull"], expected, shape)
            if inline_memo and "memo" in obj:
                _contract_error("AI answer supplies memo in two locations", shape, ambiguous=["twoMemoLocations"])
            memo = inline_memo if inline_memo else str(obj.get("memo") or "")
            return DecodedTranslation(
                _canonical_markers(values), memo, shape, missing_ids=tuple(missing_ids),
                end_marker_present=end_present,
            )

        _contract_error(
            "AI JSON has no supported translation shape",
            "unknown_json_wrapped" if wrapped else "unknown_json",
            topLevelKeys=keys,
            ambiguous=["unsupportedShape"],
        )

    line_values = _decode_line_text(text, expected)
    if line_values is not None:
        return DecodedTranslation(_canonical_markers(line_values), "", "plain_lines_v1")

    # TP_DONE was never requested by the new protocol, but is accepted as a
    # decode-only alias for older/custom clients.
    text = text.replace(DONE_MARKER, END_MARKER)
    shape = "plain_markers_wrapped" if wrapped else "plain_markers"
    values, memo, missing_ids, end_present = _decode_marker_text(text, expected, shape)
    empty_ids = [item for item, value in zip(expected, values) if not value.strip()]
    accepted_without_end = bool(
        require_complete and allow_complete_without_end and not missing_ids
        and not empty_ids and not end_present
    )
    if require_complete and (missing_ids or empty_ids or (not end_present and not accepted_without_end)):
        validator_subtype = (
            "missing_ids" if missing_ids else "empty_ids" if empty_ids
            else "missing_end_marker"
        )
        _contract_error(
            "AI answer did not complete the marker contract", shape,
            missingIds=missing_ids, emptyIds=empty_ids,
            endMarkerPresent=end_present,
            receivedIds=[f"P{i}" for i in sorted({int(m.group(1)) for m in _MARKER_RE.finditer(text)})],
            validatorSubtype=validator_subtype,
        )
    return DecodedTranslation(
        _canonical_markers(values), memo, shape, missing_ids=tuple(missing_ids),
        end_marker_present=end_present,
        accepted_without_end_marker=accepted_without_end,
    )

def decode_translation_response(
    raw: str, expected: list[str], *, require_complete: bool = False,
    allow_complete_without_end: bool = False,
) -> DecodedTranslation:
    """Decode new generation output with the selected contract only.

    Compatibility flags remain for call-site stability but never enable old
    shapes. Import/replay code must opt into
    :func:`decode_legacy_translation_response` explicitly.
    """
    del require_complete, allow_complete_without_end
    if not expected or expected != [f"P{i}" for i in range(len(expected))]:
        raise ValueError("expected IDs must be the exact sequence P0..Pn")
    return _decode_strict_records(raw, expected)
