export function buildEnqueuePolicy(payload, tabId, dependencies) {
  const expected = String(
    payload?.context?.tp_tab_session || payload?.metadata?.tp_tab_session || "",
  ).trim();
  const queuedBatchId = String(payload?.metadata?.batch_id || "").trim();
  const sessionIsCurrent = () => {
    const current = dependencies.getTabSessionId(tabId);
    return !(expected && (!current || expected !== current));
  };
  const shouldStart = () =>
    sessionIsCurrent() &&
    !(queuedBatchId && dependencies.getBatch(queuedBatchId)?.cancelled);
  return {
    shouldStart,
    laneManaged: payload?.engine !== "api",
  };
}
