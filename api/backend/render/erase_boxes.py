"""Serialise Lens text boxes so the CLIENT can erase them.


The server used to do the whole background job: inpaint every Lens token out
of the page, re-encode the result, and base64 it into the response. That is
the single most expensive thing the direct lane does and the largest field in
the reply — a multi-megabyte string per image, held in the job registry until
the extension polls for it.

The boxes themselves are a few hundred bytes. The browser already has the
original image decoded in the page, and a canvas can fill those boxes far
faster than a 2-vCPU container can inpaint and re-encode them. So the server
sends the boxes and the extension paints.

Everything here is deliberately free of numpy/PIL/cv2 so the schema can be
tested without the image stack installed.

Schema ``tp.erase-boxes/1``::

    {
      "schema": "tp.erase-boxes/1",
      "boxes": [ {"l": 0.1, "t": 0.2, "w": 0.3, "h": 0.04, "r": 0.0}, ... ]
    }

``l/t/w/h`` are normalised to the image size (0..1) and ``r`` is the box's
rotation in degrees about its own centre — the same numbers
``render.geometry.token_box_quad_px`` consumes, so the client reconstructs
exactly the quad the server would have erased.
"""

from __future__ import annotations

from typing import Any

SCHEMA = "tp.erase-boxes/1"

# Normalised coordinates only ever need this much precision: at 5 decimals one
# unit is 0.01 px on a 1000 px page. Rounding here is what keeps the payload
# small — full float repr roughly triples it.
_PRECISION = 5

# Boxes thinner than this in normalised units are Lens noise (stray marks,
# single-pixel artefacts). Painting them costs a canvas op and achieves
# nothing visible.
_MIN_SIDE = 1e-4


def _round(value: Any) -> float | None:
    """Round to the wire precision, or ``None`` when there is no number here."""
    try:
        rounded = round(float(value), _PRECISION)
    except (TypeError, ValueError):
        return None
    if rounded != rounded or rounded in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return rounded


def box_payload(token: dict) -> dict[str, float] | None:
    """One token's box, or ``None`` when it carries no usable geometry.

    Nothing here substitutes a default for a missing number. A box at 0,0 with
    the right size is not "close enough" — it paints a rectangle over the corner
    of the page and leaves the real text showing. Mirrored by
    ``src/shared/erase-boxes.js``.
    """
    box = token.get("box")
    if not isinstance(box, dict):
        return None

    w = _round(box.get("width"))
    h = _round(box.get("height"))
    if w is None or h is None:
        return None
    if w <= _MIN_SIDE or h <= _MIN_SIDE:
        return None

    left = _round(box.get("left"))
    top = _round(box.get("top"))
    if left is None or top is None:
        return None

    out = {"l": left, "t": top, "w": w, "h": h}

    # Rotation genuinely defaults: an upright box omits it, and "unset" and
    # "0°" are the same intent. A present-but-unreadable rotation is not the
    # same thing, and drops the box.
    if "rotation_deg" in box:
        rotation = _round(box.get("rotation_deg"))
        if rotation is None:
            return None
        # Omit the common case rather than repeat "r": 0.0 on every box.
        if rotation:
            out["r"] = rotation
    return out


def build(tokens: list[dict] | None) -> dict[str, Any]:
    """Build the ``tp.erase-boxes/1`` payload for ``tokens``.

    Tokens without geometry are dropped, and the count of dropped tokens is
    reported: a page where most tokens were unusable is a page whose
    background will look wrong, and that must be visible rather than inferred
    from a suspiciously short box list.
    """
    boxes: list[dict[str, float]] = []
    skipped = 0
    for token in tokens or []:
        payload = box_payload(token) if isinstance(token, dict) else None
        if payload is None:
            skipped += 1
            continue
        boxes.append(payload)

    out: dict[str, Any] = {"schema": SCHEMA, "boxes": boxes}
    if skipped:
        out["skipped"] = skipped
    return out
