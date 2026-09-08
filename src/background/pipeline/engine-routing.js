export function planAiRoute(payload, directLocal = undefined) {
  if (payload?.mode !== "lens_text" || payload?.source !== "ai") return null;
  if (!payload?.render?.lensDocument) return null;

  const ai = payload.ai && typeof payload.ai === "object" ? payload.ai : null;
  const direct = Boolean(directLocal);
  return {
    route: direct ? "direct-local" : "server",
    reason: direct
      ? "Local AI translation runs directly from the extension to the user's PC"
      : "AI text translation is API-owned; geometry and HTML are extension-owned",
    ai,
    originalSource: payload.source,
  };
}

export function payloadForFullServer(payload, renderPolicy = undefined) {
  const { debug: _debug, ...rest } = payload || {};
  return {
    ...rest,
    render: {
      ...(payload?.render || {}),
      background: "image",
      ...(renderPolicy ||
        (payload?.engine === "api" ? { lensDocument: false } : {})),
    },
  };
}

export async function dispatchPreparedJob(context, dependencies) {
  const { base, payload, makeContext, capabilities, dispatchOptions } = context;
  const { dispatchSync, dispatchLegacy } = dependencies;
  if (capabilities.syncTranslate) {
    await dispatchSync(base, payload, makeContext, {
      ...dispatchOptions,
      capabilities,
    });
    return "sync";
  }
  await dispatchLegacy(base, payload, makeContext, dispatchOptions);
  return "legacy";
}
