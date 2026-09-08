/** Owns popup usage rendering and selection-session transitions. */
export function createAiUsageController({
  persistBoundary,
  readCurrentUsage,
  renderUsage,
}) {
  let renderSequence = 0;
  let pendingTarget = null;

  const sameTarget = (left, right) =>
    Boolean(left && right) &&
    left.runtime === right.runtime &&
    left.provider === right.provider &&
    left.model === right.model;

  function begin(target) {
    renderSequence += 1;
    pendingTarget = { ...target };
    renderUsage({
      ...target,
      requests: 0,
      inputTokens: null,
      outputTokens: null,
      totalTokens: 0,
      tokensReported: false,
      tokenStatus: "not_used",
    });
  }

  async function select(target, currentTarget = () => target) {
    begin(target);
    await persistBoundary(target);
    if (!sameTarget(target, currentTarget())) return;
    pendingTarget = null;
    await refresh(currentTarget);
  }

  async function refresh(currentTarget, readLedger = async () => null) {
    const target = currentTarget();
    if (!target || target.provider === "unknown") return;
    if (pendingTarget && sameTarget(pendingTarget, target)) {
      renderUsage({
        ...target,
        requests: 0,
        inputTokens: null,
        outputTokens: null,
        totalTokens: 0,
        tokensReported: false,
        tokenStatus: "not_used",
      });
      return;
    }
    const sequence = ++renderSequence;
    const ledger = await readLedger();
    if (sequence !== renderSequence || !sameTarget(target, currentTarget()))
      return;
    renderUsage(readCurrentUsage(ledger, target));
  }

  async function reset(target, persistReset, currentTarget = () => target) {
    begin(target);
    await persistReset();
    if (!sameTarget(target, currentTarget())) return;
    pendingTarget = null;
    await refresh(currentTarget);
  }

  return { begin, refresh, reset, sameTarget, select };
}
