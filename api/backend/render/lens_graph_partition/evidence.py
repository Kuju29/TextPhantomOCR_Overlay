"""Adaptive adjacent-boundary evidence from Lens geometry and page pixels."""
from __future__ import annotations

from statistics import median
from typing import Any

import numpy as np

from .model import BoundaryEvidence, VerticalNode


def prepare_pixels(image: Any):
    """Convert the page once; boundary probes reuse the same grayscale view."""
    if image is None:
        return None
    try:
        arr = np.asarray(image)
        return arr[..., :3].mean(axis=2) if arr.ndim == 3 else arr
    except Exception:
        return None


def rtl(nodes: tuple[VerticalNode, ...]) -> tuple[VerticalNode, ...]:
    return tuple(sorted(nodes, key=lambda n: (-n.bounds[0], n.bounds[1],
                                              n.paragraph_index)))


def _mad(values: list[float]) -> float:
    center = median(values) if values else 0.0
    return max(0.15, median([abs(v - center) for v in values]) if values else 1.0)


def _corridor(image: Any, right: VerticalNode, left: VerticalNode) -> tuple[bool, float, float]:
    if image is None:
        return False, 0.0, 0.0
    try:
        arr = np.asarray(image)
        if arr.ndim == 3:
            arr = arr[..., :3].mean(axis=2)
        rx1, ry1, rx2, ry2 = right.bounds
        lx1, ly1, lx2, ly2 = left.bounds
        # Overlapping envelopes have no empty inter-column corridor. Sorting
        # these endpoints instead would probe their glyphs as a separator.
        if rx1 <= lx2:
            return False, 0.0, 0.0
        x1, x2 = int(round(lx2)), int(round(rx1))
        y1, y2 = int(max(ry1, ly1)), int(min(ry2, ly2))
        crop = arr[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
        if crop.shape[0] < 8 or crop.shape[1] < 2:
            return False, 0.0, 0.0
        low, high = float(np.quantile(crop, .05)), float(np.quantile(crop, .95))
        # A uniform bright corridor is whitespace, not a dark separator.  The
        # former percentile rule classified every white pixel as "dark" when
        # its threshold was also 255.
        if high - low < 8.0:
            if high >= 240.0:
                return True, 0.0, 1.0
            if high <= 40.0:
                # A uniformly dark narrow corridor is a separator only when
                # both adjacent side bands are materially brighter.  Uniform
                # black artwork/fill therefore cannot masquerade as a line.
                band = max(2, crop.shape[1])
                left_band = arr[max(0, y1):max(0, y2),
                                max(0, x1 - band):max(0, x1)]
                right_band = arr[max(0, y1):max(0, y2),
                                 min(arr.shape[1], x2):min(arr.shape[1], x2 + band)]
                sides = [float(np.median(part)) for part in (left_band, right_band)
                         if part.size]
                isolated = len(sides) == 2 and min(sides) >= high + 40.0
                return True, 1.0 if isolated else 0.0, 0.0
            return True, 0.0, 0.0
        threshold = low + .30 * (high - low)
        dark = crop <= threshold
        column_density = dark.mean(axis=0)
        # Requiring a dense connected vertical run rejects scattered glyph
        # pixels while retaining a panel/balloon separator.
        run_best = 0
        for column in dark.T:
            run = 0
            for value in column:
                run = run + 1 if value else 0
                run_best = max(run_best, run)
        line = max(float(column_density.max(initial=0.0)),
                   run_best / max(1, crop.shape[0]))
        whitespace = float((~dark).mean())
        return True, line, whitespace
    except Exception:
        return False, 0.0, 0.0


def vertical_continuation(
    first: VerticalNode, second: VerticalNode, image: Any = None,
) -> tuple[bool, bool]:
    """Prove a Lens paragraph split along the vertical reading flow.

    Lens occasionally emits the upper and lower halves of one vertical text
    region as separate paragraphs.  This relation is intentionally narrow:
    their column envelopes must coincide, their glyph scales must agree and
    the small gap between them must not contain a persistent horizontal rule.
    The second return value records whether pixels were available to veto a
    cross-panel merge.
    """
    if first.bounds is None or second.bounds is None:
        return False, False
    upper, lower = sorted((first, second), key=lambda node: (
        node.bounds[1], node.bounds[0], node.paragraph_index))
    ux1, _uy1, ux2, uy2 = upper.bounds
    lx1, ly1, lx2, _ly2 = lower.bounds
    glyph_a = max(1.0, first.glyph_px or 1.0)
    glyph_b = max(1.0, second.glyph_px or 1.0)
    glyph = max(glyph_a, glyph_b)
    width_a, width_b = ux2 - ux1, lx2 - lx1
    x_overlap = max(0.0, min(ux2, lx2) - max(ux1, lx1))
    overlap_ratio = x_overlap / max(1.0, min(width_a, width_b))
    center_delta = abs((ux1 + ux2) - (lx1 + lx2)) / 2.0 / glyph
    vertical_gap = max(0.0, ly1 - uy2) / glyph
    glyph_ratio = max(glyph_a, glyph_b) / min(glyph_a, glyph_b)
    geometry = (
        overlap_ratio >= .72 and center_delta <= .8 and
        vertical_gap <= 1.5 and glyph_ratio <= 1.4 and ly1 >= uy2
    )
    if not geometry or image is None:
        return False, False
    try:
        arr = np.asarray(image)
        if arr.ndim == 3:
            arr = arr[..., :3].mean(axis=2)
        x1, x2 = int(round(max(ux1, lx1))), int(round(min(ux2, lx2)))
        y1, y2 = int(round(uy2)), int(round(ly1))
        crop = arr[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
        # A white gap alone proves nothing: unrelated boxes on a blank page
        # must not merge.  Require visible enclosure/art context on both sides
        # of the combined narrow region before treating it as one container.
        band = max(4, int(round(glyph)))
        top = max(0, int(round(min(upper.bounds[1], lower.bounds[1]))))
        bottom = min(arr.shape[0], int(round(max(
            upper.bounds[3], lower.bounds[3]))))
        left = max(0, int(round(min(ux1, lx1))))
        right = min(arr.shape[1], int(round(max(ux2, lx2))))
        side_bands = (
            arr[top:bottom, max(0, left - band):left],
            arr[top:bottom, right:min(arr.shape[1], right + band)],
        )
        side_ink = [float((part < 225.0).mean()) for part in side_bands
                    if part.size]
        if len(side_ink) != 2 or min(side_ink) < .02:
            return False, True
        if crop.shape[0] < 2 or crop.shape[1] < 8:
            return False, False
        low, high = float(np.quantile(crop, .05)), float(np.quantile(crop, .95))
        if high - low < 8.0:
            # A bright uniform gap is positive continuation evidence.  A dark
            # one is artwork/border and therefore vetoes the relation.
            return high >= 240.0, True
        dark = crop <= low + .30 * (high - low)
        row_density = dark.mean(axis=1)
        longest = 0
        for row in dark:
            run = 0
            for value in row:
                run = run + 1 if value else 0
                longest = max(longest, run)
        separator = max(float(row_density.max(initial=0.0)),
                        longest / max(1, crop.shape[1])) >= .78
        return not separator, True
    except Exception:
        return False, False


def build_boundaries(nodes: tuple[VerticalNode, ...], image: Any = None
                     ) -> tuple[BoundaryEvidence, ...]:
    ordered = rtl(nodes)
    if len(ordered) < 2:
        return ()
    gaps, heads, fonts, font_ratios = [], [], [], []
    for right, left in zip(ordered, ordered[1:]):
        glyph = max(right.glyph_px or 1.0, left.glyph_px or 1.0, 1.0)
        gaps.append(max(0.0, right.bounds[0] - left.bounds[2]) / glyph)
        heads.append(abs(right.bounds[1] - left.bounds[1]) / glyph)
        right_glyph = right.glyph_px or glyph
        left_glyph = left.glyph_px or glyph
        fonts.append(abs(right_glyph - left_glyph) / glyph)
        font_ratios.append(max(right_glyph, left_glyph) /
                           max(1.0, min(right_glyph, left_glyph)))
    centers = (median(gaps), median(heads), median(fonts))
    scales = (_mad(gaps), _mad(heads), _mad(fonts))
    out = []
    for index, (right, left) in enumerate(zip(ordered, ordered[1:])):
        gap_z = (gaps[index] - centers[0]) / scales[0]
        # MAD on almost equal close gutters can amplify a harmless sub-glyph
        # difference. Strong head/scale agreement bounds this relative evidence;
        # persistent pixel separators and absolute large-gap vetoes remain intact.
        if gaps[index] <= 1.5 and heads[index] <= .5 and font_ratios[index] <= 1.25:
            gap_z = min(gap_z, .5)
        head_z = (heads[index] - centers[1]) / scales[1]
        font_z = (fonts[index] - centers[2]) / scales[2]
        overlap = (
            max(0.0, min(right.bounds[3], left.bounds[3]) -
                max(right.bounds[1], left.bounds[1]))
            / max(1.0, min(right.bounds[3] - right.bounds[1],
                           left.bounds[3] - left.bounds[1]))
        )
        known, line, whitespace = _corridor(image, right, left)
        reasons = []
        hard = "none"
        continuation, continuation_pixels = vertical_continuation(
            right, left, image)
        if continuation and continuation_pixels:
            hard, reasons = "same", ["vertical_continuation"]
        elif known and line >= .78:
            hard, reasons = "separate", ["persistent_line"]
        elif gaps[index] >= 3.5:
            hard, reasons = "separate", ["large_glyph_normalized_gap"]
        elif heads[index] >= 2.0 and overlap <= .5:
            hard, reasons = "separate", ["head_offset_with_low_overlap"]
        elif font_ratios[index] >= 1.75:
            hard, reasons = "separate", ["large_font_ratio"]
        cut = 1.3 * max(0.0, gap_z) + .7 * max(0.0, head_z) + \
            .8 * max(0.0, font_z) + .8 * line + \
            .65 * max(0.0, heads[index] - 1.0) + \
            .9 * max(0.0, font_ratios[index] - 1.25)
        keep = 1.2 * overlap + .5 * whitespace + \
            .4 / (1.0 + max(0.0, gap_z)) + \
            .25 / (1.0 + heads[index])
        out.append(BoundaryEvidence(
            right.paragraph_id, left.paragraph_id,
            round(gap_z, 4), round(head_z, 4), round(font_z, 4),
            round(overlap, 4), round(line, 4), round(whitespace, 4),
            hard, round(keep, 4), round(cut, 4), tuple(reasons),
            round(gaps[index], 4), round(heads[index], 4),
            round(font_ratios[index], 4), 0.0, known,
        ))
    return tuple(out)
