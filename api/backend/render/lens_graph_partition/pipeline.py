"""Public detector-independent Lens graph partition API."""
from __future__ import annotations

from .candidates import form_candidates
from .evidence import build_boundaries, rtl, prepare_pixels
from .model import CandidateTrace, GroupingResult
from .nodes import extract_nodes
from .item_roles import infer_item_ruby
from .roles import classify_candidate, preclassify_ruby
from .solver import solve
from .validate import validate


def partition_vertical_lens(tree: dict, image=None, *, min_margin: float = .35,
                            retained_ids: frozenset[str] = frozenset(),
                            item_exclusions: dict | None = None
                            ) -> GroupingResult:
    """Partition every local container; uncertain content is never guessed away."""
    inventory = extract_nodes(tree, infer_item_ruby(tree) if item_exclusions is None else item_exclusions)
    invalid = tuple(node for node in inventory
                    if node.bounds is None or node.glyph_px is None)
    valid = tuple(node for node in inventory
                  if node.bounds is not None and node.glyph_px is not None)
    groups, attachments, excluded, traces = [], [], [], []
    retention_conflicts = []
    unresolved = [node.paragraph_id for node in invalid]
    reasons = []

    image = prepare_pixels(image)
    ordinary, early_ruby = preclassify_ruby(valid)
    attachments.extend(early_ruby)
    candidates, formation_edges, _bridge_unresolved = form_candidates(ordinary, image)
    for candidate_id, candidate in candidates:
        baseline_classified, baseline_ruby, baseline_unresolved = classify_candidate(
            candidate)
        conflicts = [attachment.ruby_id for attachment in baseline_ruby
                     if attachment.ruby_id in retained_ids]
        if conflicts:
            retention_conflicts.extend(conflicts)
            classified, ruby, role_unresolved = classify_candidate(
                candidate, retained_ids)
        else:
            classified, ruby, role_unresolved = (
                baseline_classified, baseline_ruby, baseline_unresolved)
        attachments.extend(ruby)
        unresolved.extend(pid for pid in role_unresolved if pid not in unresolved)
        dialogue = tuple(node for node in classified if node.role == "dialogue")
        excluded.extend((node.paragraph_id, node.role) for node in classified
                        if node.role in ("punctuation", "sfx"))
        boundaries = build_boundaries(dialogue, image)
        best, runner, best_score, runner_score = solve(dialogue, boundaries)
        margin = best_score - runner_score if runner else float("inf")
        local_unresolved = list(role_unresolved)
        status = "resolved"
        if role_unresolved:
            # Withhold the whole candidate: returning its best dialogue groups
            # beside an unresolved attachment would expose a partial decision.
            local_unresolved.extend(node.paragraph_id for node in dialogue)
            status = "unresolved"
            reasons.append("candidate_role_ambiguous")
        elif runner and margin < min_margin:
            # A close score means only that there is not enough positive
            # evidence to merge.  Cut uncertain boundaries locally while
            # retaining high-confidence joins and every source paragraph.
            ordered = rtl(dialogue)
            conservative = [([ordered[0].paragraph_id] if ordered else [])]
            for boundary, node in zip(boundaries, ordered[1:]):
                confident_same = (boundary.hard == "same" or (
                    boundary.hard != "separate" and
                    boundary.keep_score - boundary.cut_score >= min_margin))
                if confident_same:
                    conservative[-1].append(node.paragraph_id)
                else:
                    conservative.append([node.paragraph_id])
            best = tuple(tuple(group) for group in conservative if group)
            errors = validate(dialogue, best)
            if errors:
                local_unresolved.extend(node.paragraph_id for node in dialogue)
                status = "unresolved"
                reasons.append("partition_invariant_failed")
            else:
                groups.extend(best)
        else:
            errors = validate(dialogue, best)
            if errors:
                local_unresolved.extend(node.paragraph_id for node in dialogue)
                status = "unresolved"
                reasons.append("partition_invariant_failed")
            else:
                groups.extend(best)
        unresolved.extend(pid for pid in local_unresolved if pid not in unresolved)
        traces.append(CandidateTrace(
            tuple(node.paragraph_id for node in rtl(dialogue)),
            tuple((node.paragraph_id, node.role) for node in classified),
            boundaries, best, runner, round(best_score, 4),
            round(runner_score, 4), round(margin, 4), candidate_id,
            status, tuple(dict.fromkeys(local_unresolved))))

    if invalid:
        reasons.insert(0, "missing_geometry")
    flat = CandidateTrace(
        tuple(pid for trace in traces for pid in trace.node_ids),
        tuple(pair for trace in traces for pair in trace.role_ids),
        tuple(formation_edges) + tuple(edge for trace in traces for edge in trace.boundaries),
        tuple(group for trace in traces for group in trace.best_groups),
        tuple(group for trace in traces for group in trace.runner_up_groups),
        sum(trace.best_score for trace in traces),
        sum(trace.runner_up_score for trace in traces),
        min((trace.margin for trace in traces), default=float("inf")),
        "page", "unresolved" if unresolved else "resolved",
        tuple(dict.fromkeys(unresolved)))

    expected = [node.paragraph_id for node in inventory]
    accounted = [pid for group in groups for pid in group]
    accounted += [item.ruby_id for item in attachments]
    accounted += [pid for pid, _ in excluded]
    accounted += list(dict.fromkeys(unresolved))
    errors = []
    if len(accounted) != len(set(accounted)):
        errors.append("duplicate_global_membership")
    missing = [pid for pid in expected if pid not in set(accounted)]
    if missing:
        unresolved.extend(pid for pid in missing if pid not in unresolved)
        accounted.extend(missing)
        final_unresolved = tuple(dict.fromkeys(unresolved))
    if set(accounted) != set(expected):
        errors.append("global_membership_not_conserved")
    if errors:
        reasons.append("global_invariant_failed")
    final_unresolved = tuple(dict.fromkeys(unresolved))
    status = "unresolved" if final_unresolved or errors else "resolved"
    return GroupingResult(status, tuple(groups), tuple(attachments),
                          tuple(excluded), final_unresolved,
                          reasons[0] if reasons else "", flat,
                          tuple(errors), tuple(traces),
                          tuple(dict.fromkeys(retention_conflicts)))
