// Builds terminal image-error messages from the owning job context.
// Keeping this pure prevents concurrent jobs from borrowing the ambient trace.
import { publicTpError } from "../shared/error-contract.js";

export function imageErrorMessage(ctx, message, original = undefined) {
  const owner = ctx && typeof ctx === "object" ? ctx : {};
  const error = publicTpError(message, owner.traceId || owner?.context?.tp_trace || "");
  // Job-owned errors carry the same target generation as successful overlay
  // messages. Older/immediate producers have no generation and deliberately
  // remain compatible; the content side treats only an explicit mismatching
  // generation as stale.
  const generation = owner.generation && typeof owner.generation === "object"
    ? { ...owner.generation }
    : null;
  return {
    type: "IMAGE_ERROR",
    original: original === undefined ? owner.imgUrl ?? null : original,
    message: `${error.userMessage} · ${error.code}`,
    error,
    ...(generation ? { generation } : {}),
    tpTrace: String(owner.traceId || owner?.context?.tp_trace || ""),
  };
}
