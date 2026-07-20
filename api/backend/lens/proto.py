"""Minimal protobuf wire-format reader for Google Lens responses.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Google Lens returns OCR geometry as nested, *unschematised* protobuf messages
embedded inside the JSON response.  We only need a handful of fields, so
instead of compiling ``.proto`` files we walk the wire format directly.

Wire types handled: varint (0), 64-bit (1), length-delimited (2), 32-bit (5).

The ``looks_like_*`` / ``is_item_message`` heuristics exist because the
message layout is not documented — we identify "item" sub-messages by their
*shape* (a geometry block plus one or more span blocks).
"""

from __future__ import annotations

import struct

# A decoded field is (field_number, wire_type, value).
ProtoField = tuple[int, int, object]


def read_varint(buf: bytes, i: int) -> tuple[int, int]:
    """Read a base-128 varint starting at ``buf[i]``; return ``(value, next_i)``."""
    shift = 0
    result = 0
    while True:
        if i >= len(buf):
            raise ValueError("eof varint")
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return result, i
        shift += 7
        if shift > 70:
            raise ValueError("varint too long")


def parse(buf: bytes, start: int = 0, end: int | None = None) -> list[ProtoField]:
    """Decode every top-level field in ``buf[start:end]``."""
    if end is None:
        end = len(buf)
    i = start
    out: list[ProtoField] = []
    while i < end:
        key, i = read_varint(buf, i)
        field = key >> 3
        wire = key & 7
        if wire == 0:  # varint
            val, i = read_varint(buf, i)
            out.append((field, wire, val))
        elif wire == 1:  # 64-bit
            out.append((field, wire, buf[i : i + 8]))
            i += 8
        elif wire == 2:  # length-delimited
            length, i = read_varint(buf, i)
            out.append((field, wire, buf[i : i + length]))
            i += length
        elif wire == 5:  # 32-bit
            out.append((field, wire, buf[i : i + 4]))
            i += 4
        else:
            raise ValueError(f"wiretype {wire}")
    return out


def f32(b4: bytes) -> float:
    """Decode a little-endian 32-bit float."""
    return struct.unpack("<f", b4)[0]


def to_hex(b: bytes) -> str:
    return b.hex()


def get_float_field(fields: list[ProtoField], field_num: int) -> float | None:
    """Return the value of the first 32-bit float field numbered ``field_num``."""
    for f, w, v in fields:
        if f == field_num and w == 5:
            return f32(v)  # type: ignore[arg-type]
    return None


# --- Shape heuristics ------------------------------------------------------

def get_points_from_geom(
    geom_bytes: bytes,
) -> tuple[tuple[float, float] | None, tuple[float, float] | None, float | None]:
    """Extract ``(p_first, p_last, height)`` from a geometry sub-message.

    Lens encodes free-angle / curved text as a *polyline*: up to 6 points
    tracing the text along its baseline.  The renderer treats the line as a
    straight chord from the first point to the last point — so the returned
    ``p1`` / ``p2`` are the polyline's endpoints, not the first two points.
    Using ``pts[0]`` / ``pts[1]`` (the previous behaviour) under-counts the
    baseline length dramatically — a 6-point polyline spanning ~110px decodes
    to ~17px, which then makes every span box ~6x too narrow to fit its text.

    p1/p2 are the baseline endpoints (normalised 0..1); ``height`` is the
    normalised text height.  Returns ``(None, None, None)`` when the message
    isn't a geometry block.
    """
    pts: list[tuple[float, float]] = []
    height: float | None = None
    for f, w, v in parse(geom_bytes):
        if f == 1 and w == 2:
            p_fields = parse(v)  # type: ignore[arg-type]
            x = get_float_field(p_fields, 1)
            y = get_float_field(p_fields, 2)
            if x is not None and y is not None:
                pts.append((x, y))
        elif f == 3 and w == 5:
            height = f32(v)  # type: ignore[arg-type]
    if len(pts) >= 2 and height is not None:
        return pts[0], pts[-1], height
    return None, None, None


def get_polyline_from_geom(
    geom_bytes: bytes,
) -> tuple[list[tuple[float, float]], float | None]:
    """Return the *full* polyline + height from a geometry sub-message.

    Used by the renderer when an exact curve trace is needed.  Returns
    ``([], None)`` when the message isn't a geometry block.
    """
    pts: list[tuple[float, float]] = []
    height: float | None = None
    for f, w, v in parse(geom_bytes):
        if f == 1 and w == 2:
            p_fields = parse(v)  # type: ignore[arg-type]
            x = get_float_field(p_fields, 1)
            y = get_float_field(p_fields, 2)
            if x is not None and y is not None:
                pts.append((x, y))
        elif f == 3 and w == 5:
            height = f32(v)  # type: ignore[arg-type]
    return pts, height


def looks_like_geom(geom_bytes: bytes) -> bool:
    """True if ``geom_bytes`` has >=2 points and a height field."""
    pts = 0
    has_height = False
    for f, w, v in parse(geom_bytes):
        if f == 1 and w == 2:
            p_fields = parse(v)  # type: ignore[arg-type]
            if (
                get_float_field(p_fields, 1) is not None
                and get_float_field(p_fields, 2) is not None
            ):
                pts += 1
        elif f == 3 and w == 5:
            has_height = True
    return pts >= 2 and has_height


def looks_like_span(span_bytes: bytes) -> bool:
    """True if ``span_bytes`` has both a t0/t1 float pair and a start/end range."""
    has_t = False
    has_range = False
    for f, w, _v in parse(span_bytes):
        if f in (3, 4) and w == 5:
            has_t = True
        elif f in (1, 2) and w == 0:
            has_range = True
    return has_t and has_range


def is_item_message(msg_bytes: bytes) -> bool:
    """True if ``msg_bytes`` is an OCR "item" (geometry + >=1 span)."""
    geom_ok = False
    span_ok = 0
    for f, w, v in parse(msg_bytes):
        if f == 1 and w == 2 and not geom_ok:
            geom_ok = looks_like_geom(v)  # type: ignore[arg-type]
        elif f == 2 and w == 2 and looks_like_span(v):  # type: ignore[arg-type]
            span_ok += 1
    return geom_ok and span_ok > 0


def extract_items_from_paragraph(par_bytes: bytes) -> list[bytes]:
    """Find every item sub-message inside a paragraph message."""
    items = [
        v
        for _, w, v in parse(par_bytes)
        if w == 2 and is_item_message(v)  # type: ignore[arg-type]
    ]
    if items:
        return items

    found: list[bytes] = []
    seen: set[bytes] = set()
    nodes = 0

    def walk(buf: bytes, depth: int) -> None:
        nonlocal nodes
        if depth >= 4 or nodes > 20000:
            return
        for _, w, v in parse(buf):
            if w != 2:
                continue
            nodes += 1
            if nodes > 20000:
                return
            if is_item_message(v):  # type: ignore[arg-type]
                if v not in seen:
                    seen.add(v)  # type: ignore[arg-type]
                    found.append(v)  # type: ignore[arg-type]
            else:
                walk(v, depth + 1)  # type: ignore[arg-type]

    walk(par_bytes, 0)
    return found


def extract_item_geom_spans(item_bytes: bytes) -> tuple[bytes | None, list[bytes]]:
    """Split an item message into ``(geometry_bytes, [span_bytes, ...])``."""
    geom_bytes: bytes | None = None
    spans_bytes: list[bytes] = []
    for f, w, v in parse(item_bytes):
        if f == 1 and w == 2:
            geom_bytes = v  # type: ignore[assignment]
        elif f == 2 and w == 2:
            spans_bytes.append(v)  # type: ignore[arg-type]
    return geom_bytes, spans_bytes


def extract_span(
    span_bytes: bytes,
) -> tuple[int | None, int | None, float | None, float | None]:
    """Decode a span message into ``(start, end, t0, t1)``.

    ``start``/``end`` index into the paragraph's full text; ``t0``/``t1`` are
    the span's normalised position along the item baseline (0..1).
    """
    start: int | None = None
    end: int | None = None
    t0: float | None = None
    t1: float | None = None
    for f, w, v in parse(span_bytes):
        if f == 1 and w == 0:
            start = int(v)  # type: ignore[arg-type]
        elif f == 2 and w == 0:
            end = int(v)  # type: ignore[arg-type]
        elif f == 3 and w == 5:
            t0 = f32(v)  # type: ignore[arg-type]
        elif f == 4 and w == 5:
            t1 = f32(v)  # type: ignore[arg-type]
    return start, end, t0, t1
