/** One contract for the opt-in page image setting and verified model support. */
export function pageImageEnabled(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["always", "true", "1", "on"].includes(value.trim().toLowerCase());
}

export function modelVisionSupport(capabilities) {
  const vision = capabilities?.vision;
  return typeof vision?.supported === "boolean" ? vision.supported : null;
}

export function assertPageImageSupported(enabled, capabilities) {
  if (!pageImageEnabled(enabled)) return;
  const supported = modelVisionSupport(capabilities);
  if (supported === true) return;
  const message = supported === false
    ? "[AI option > Page image to AI] is unavailable for the selected model"
    : "[AI option > Page image to AI] requires verified image support for the selected model";
  const error = new Error(message);
  error.code = supported === false
    ? "AI_PAGE_IMAGE_UNSUPPORTED"
    : "AI_PAGE_IMAGE_UNVERIFIED";
  throw error;
}
