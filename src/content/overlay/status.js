(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  function reason(result) {
    return String(
      result?.meta?.skipped_reason ||
        result?.metadata?.skipped_reason ||
        result?.Ai?.meta?.skipped_reason ||
        result?.ai?.meta?.skipped_reason ||
        result?.translated?.meta?.skipped_reason ||
        result?.original?.meta?.skipped_reason ||
        result?.Ai?.meta?.reason ||
        result?.ai?.meta?.reason ||
        "",
    )
      .trim()
      .toLowerCase();
  }

  function label(value) {
    if (/no[_ -]?translatable/.test(value)) return "No translatable text";
    if (/no[_ -]?text/.test(value)) return "No text";
    if (/rate.?limit/.test(value)) return "AI rate limit";
    if (/missing.*key|no[_ -]?ai[_ -]?key/.test(value)) return "No AI key";
    if (/model/.test(value) && /unavailable|missing|not[_ -]?found/.test(value))
      return "AI model unavailable";
    return value
      ? value.replace(/[_-]+/g, " ").slice(0, 72)
      : "AI output unavailable";
  }

  TP.overlayStatus = { label, reason };
})();
