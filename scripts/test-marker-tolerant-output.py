"""Focused parity fixtures for tolerant compact-record extraction."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai.markers.decode import decode_translation_response


def values(decoded):
    return re.findall(
        r"<<TP_P\d+>>\n(.*?)(?=\n\n<<TP_P\d+>>|\Z)",
        decoded.ai_text_full,
        re.DOTALL,
    )


ids = ["P0", "P1", "P2"]
reordered = decode_translation_response(
    "prefix <<TP_P2:สาม>><<TP_P9:ignore>><<TP_P0:หนึ่ง>> between <<TP_P1:สอง>> suffix",
    ids,
)
assert values(reordered) == ["หนึ่ง", "สอง", "สาม"]
assert reordered.missing_ids == ()
assert reordered.discarded_ids == ("P9",)

literal_close = decode_translation_response(
    "<<TP_P1:สอง >> literal>><<TP_P0:หนึ่ง>><<TP_P2:สาม>>", ids
)
assert values(literal_close) == ["หนึ่ง", "สอง ", "สาม"]

duplicate = decode_translation_response(
    "<<TP_P0:first>><<TP_P1:สอง>><<TP_P0:last>><<TP_P2:สาม>>", ids
)
assert duplicate.missing_ids == ("P0",)
assert duplicate.ai_text_full.startswith("<<TP_P0>>\n\n\n<<TP_P1>>\nสอง")

malformed = decode_translation_response(
    "<<TP_P0:หนึ่ง>><<TP_P1 broken>><<TP_P2:สาม>>", ids
)
assert malformed.missing_ids == ()
assert malformed.ai_text_full == "<<TP_P0>>\nหนึ่ง\n\n<<TP_P1>>\nbroken\n\n<<TP_P2>>\nสาม"
assert malformed.malformed_line_count == 0

newline_separator = decode_translation_response("<<TP_P0\nline>>", ["P0"])
assert newline_separator.ai_text_full == "<<TP_P0>>\nline"

balanced_nested = decode_translation_response("<<TP_P2:สาม<<TP_P1 broken>>>>", ids)
assert balanced_nested.ai_text_full == "<<TP_P0>>\n\n\n<<TP_P1>>\nbroken\n\n<<TP_P2>>\nสาม"
assert balanced_nested.missing_ids == ("P0",)

nested_suffix = decode_translation_response("<<TP_P0:before<<TP_P1:child>>after>>", ["P0", "P1"])
assert values(nested_suffix) == ["beforeafter", "child"]

peer_bridge = decode_translation_response(
    "<<TP_P1:broken1<<>>TP_P2 broken2>>", ids
)
assert peer_bridge.ai_text_full == "<<TP_P0>>\n\n\n<<TP_P1>>\nbroken1\n\n<<TP_P2>>\nbroken2"
assert peer_bridge.missing_ids == ("P0",)

unfinished_bridge = decode_translation_response(
    "<<TP_P0:one<<>>TP_P1 two", ["P0", "P1"]
)
assert unfinished_bridge.ai_text_full == "<<TP_P0>>\n\n\n<<TP_P1>>\n"
assert unfinished_bridge.missing_ids == ("P0", "P1")

ordinary_empty_angles = decode_translation_response(
    "<<TP_P0:value<<>>not-a-peer>>", ["P0"]
)
assert ordinary_empty_angles.ai_text_full == "<<TP_P0>>\n"
assert ordinary_empty_angles.missing_ids == ("P0",)

invalid_island_token = decode_translation_response(
    "<<TP_P0:one>><<TP_P1:broken1<<broken>>TP_P2 broken2>>", ids
)
assert invalid_island_token.ai_text_full == "<<TP_P0>>\none\n\n<<TP_P1>>\n\n\n<<TP_P2>>\n"
assert invalid_island_token.missing_ids == ("P1", "P2")

unbalanced_nested = decode_translation_response(
    "<<TP_P0:หนึ่ง>><<TP_P2:สาม<<TP_P1 broken>>", ids
)
assert unbalanced_nested.ai_text_full == "<<TP_P0>>\nหนึ่ง\n\n<<TP_P1>>\n\n\n<<TP_P2>>\n"
assert unbalanced_nested.missing_ids == ("P1", "P2")

unclosed = decode_translation_response(
    "<<TP_P0:หนึ่ง>><<TP_P1:ขาดปิด<<TP_P9 broken>><<TP_P2:สาม>>", ids
)
assert unclosed.ai_text_full == "<<TP_P0>>\nหนึ่ง\n\n<<TP_P1>>\n\n\n<<TP_P2>>\n"
assert unclosed.missing_ids == ("P1", "P2")
assert "P9" in unclosed.discarded_ids

for token in ("<<TP_P1abc>>", "<<TP_P1_x>>", "<<TP_P broken>>"):
    isolated = decode_translation_response(
        f"<<TP_P0:หนึ่ง>>{token}<<TP_P2:สาม>>", ids
    )
    assert isolated.ai_text_full == "<<TP_P0>>\nหนึ่ง\n\n<<TP_P1>>\n\n\n<<TP_P2>>\nสาม"
    assert isolated.missing_ids == ("P1",)

print("Python tolerant marker output parity passed")
