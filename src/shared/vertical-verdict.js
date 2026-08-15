// Resolves the versioned `/v1/groups` usability contract without guessing from
// coverage percentages. New servers send `usable`; paired older builds used
// the exact applied/partial rule below.
export function resolveVerticalMergeContract(grouped) {
  const merge = grouped?.merge && typeof grouped.merge === "object" ? grouped.merge : {};
  const bubbleGroups = grouped?.tree?.bubble_groups;
  // Shape validation belongs here; attachBubbleGroups performs the stricter
  // integer/range validation against the decoded document.  An accepted
  // verdict with no non-empty group must never silently become ungrouped AI.
  const hasGroups =
    Array.isArray(bubbleGroups) &&
    bubbleGroups.some((group) => Array.isArray(group?.para_indices) && group.para_indices.length > 0);
  if (typeof merge.usable === "boolean") {
    return {
      usable: merge.usable === true && hasGroups,
      contract: "explicit",
      malformed: merge.usable === true && !hasGroups,
    };
  }
  const coverage = grouped?.coverage || {};
  const legacyAccepted =
    merge.applied === true ||
    (merge.authority === "partial" &&
      Number(coverage.modelStampedVertical || coverage.stampedVertical || 0) > 0);
  return {
    usable: legacyAccepted && hasGroups,
    contract: "legacy",
    malformed: legacyAccepted && !hasGroups,
  };
}

export function decideVerticalMerge(grouped, source) {
  const contract = resolveVerticalMergeContract(grouped);
  const ai = String(source || "").toLowerCase() === "ai";
  return {
    ...contract,
    ai,
    decision: contract.usable ? "attach" : ai ? "stop" : "continue-ungrouped",
  };
}
