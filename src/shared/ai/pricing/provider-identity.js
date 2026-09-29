// HF reports the upstream's native alias in response.model, not the Hub repo ID.
// Prices belong to the requested Hub repository + observed upstream, never to a
// similarly named model on another route. All other providers keep resolved IDs.
export function pricingModel(event = {}) {
  const provider = String(event.provider || "").toLowerCase();
  const requested = String(event.requestedModel || event.model || "").trim();
  if (provider === "huggingface" && requested.includes("/") && requested !== "auto")
    return requested.replace(/:[^/]+$/, "");
  return String(event.resolvedModel || event.model || "").trim();
}
