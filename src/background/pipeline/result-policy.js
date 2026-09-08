// Pure result-shape helpers shared by orchestration and focused tests.

export function markNoTranslatableText(result, reason) {
  result.meta = { ...(result.meta || {}), skipped_reason: reason };
}

export function textSkipReason(result, nestedAiReason = undefined) {
  return String(
    result?.meta?.skipped_reason ||
      result?.metadata?.skipped_reason ||
      nestedAiReason ||
      result?.Ai?.meta?.skipped_reason ||
      result?.ai?.meta?.skipped_reason ||
      result?.translated?.meta?.skipped_reason ||
      result?.original?.meta?.skipped_reason ||
      "",
  )
    .trim()
    .toLowerCase();
}

export function isTextNoOverlaySkippable(
  mode,
  source,
  result,
  nestedAiReason = undefined,
) {
  if (String(mode || "") !== "lens_text") return false;
  const src = String(source || "").toLowerCase();
  const reason = textSkipReason(result, nestedAiReason);
  if (src === "ai")
    return /no[_ -]?text|no[_ -]?translatable[_ -]?text/.test(reason);
  return (
    !reason ||
    /no[_ -]?text|empty|no[_ -]?overlay|no[_ -]?paragraph/.test(reason)
  );
}

export function extractNewImage(result) {
  return (
    result?.imageDataUri ||
    result?.imageDataURI ||
    result?.image ||
    result?.imageUrl ||
    result?.image_url ||
    result?.imageURL ||
    null
  );
}

export function extractHtml(result) {
  return {
    aiHtml: result?.Ai?.aihtml || result?.ai?.aihtml || null,
    translatedHtml:
      result?.translated?.translatedhtml || result?.translatedhtml || null,
    originalHtml:
      result?.original?.originalhtml || result?.originalhtml || null,
  };
}

export function summarizeResultPresentation(result, mode) {
  const newImg = extractNewImage(result);
  const html = extractHtml(result);
  const hasHtml = Boolean(
    html.aiHtml ||
    html.translatedHtml ||
    html.originalHtml ||
    result?.lensDocument?.paragraphs?.length,
  );
  const skipReason = textSkipReason(result);
  return {
    newImg,
    ...html,
    hasHtml,
    skipReason,
    shouldShowSkipBadge: mode === "lens_text" && Boolean(skipReason),
  };
}

/** A safe-render refusal is not a malformed provider response. */
export function aiPageFailure(outcome) {
  return {
    code: outcome?.code || (outcome?.usable ? "RENDER_FAILED" : "AI_OUTPUT_INVALID"),
    stage: outcome?.failedStage || (outcome?.usable ? "render" : "ai"),
  };
}
