"""Conservative repair alignment guard, not a semantic translation scorer.

Unexpected output IDs in a sparse repair are evidence that a model may have
renumbered records. Quarantine the affected image; keep other images usable.
For a non-image or unassignable ID the entire repair response is uncertain.
Never remap guesses, retry, or apply this policy to the legacy/main parser.
"""
import re

_IMAGE_ID = re.compile(r"^(I[1-9][0-9]{0,6})_P[0-9]{1,6}$")

def uncertain_repair_ids(expected_ids, unexpected_ids):
    expected = list(dict.fromkeys(str(x) for x in expected_ids))
    unexpected = list(dict.fromkeys(str(x) for x in unexpected_ids if str(x) not in expected))
    if not unexpected:
        return []
    images = {m.group(1) for uid in expected if (m := _IMAGE_ID.fullmatch(uid))}
    affected = set()
    for uid in unexpected:
        match = _IMAGE_ID.fullmatch(uid)
        if not match or match.group(1) not in images:
            return expected
        affected.add(match.group(1))
    if any(not _IMAGE_ID.fullmatch(uid) for uid in expected):
        return expected
    return [uid for uid in expected if _IMAGE_ID.fullmatch(uid).group(1) in affected]
