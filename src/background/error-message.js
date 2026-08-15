// Builds terminal image-error messages from the owning job context.
// Keeping this pure prevents concurrent jobs from borrowing the ambient trace.
export function imageErrorMessage(ctx, message, original = undefined) {
  const owner = ctx && typeof ctx === "object" ? ctx : {};
  return {
    type: "IMAGE_ERROR",
    original: original === undefined ? owner.imgUrl ?? null : original,
    message: String(message || "Unknown error"),
    tpTrace: String(owner.traceId || owner?.context?.tp_trace || ""),
  };
}
