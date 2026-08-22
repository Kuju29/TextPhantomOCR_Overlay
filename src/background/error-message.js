// Builds terminal image-error messages from the owning job context.
// Keeping this pure prevents concurrent jobs from borrowing the ambient trace.
import { publicTpError } from "../shared/error-contract.js";

export function imageErrorMessage(ctx, message, original = undefined) {
  const owner = ctx && typeof ctx === "object" ? ctx : {};
  const error = publicTpError(message, owner.traceId || owner?.context?.tp_trace || "");
  return {
    type: "IMAGE_ERROR",
    original: original === undefined ? owner.imgUrl ?? null : original,
    message: `${error.userMessage} · ${error.code}`,
    error,
    tpTrace: String(owner.traceId || owner?.context?.tp_trace || ""),
  };
}
