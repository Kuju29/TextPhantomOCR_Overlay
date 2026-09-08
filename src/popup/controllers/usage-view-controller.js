export function createUsageViewController({
  els,
  state,
  isLocalProvider,
  getStorage,
  storageKey,
  currentUsage,
  historyRows,
}) {
  const target = (modelOverride = null) => {
    const provider = String(els.aiProvider?.value || "").trim();
    return {
      runtime: isLocalProvider(provider) ? "local" : "cloud",
      provider: provider || "unknown",
      model:
        String(
          modelOverride ?? els.aiModel?.value ?? state.desiredAiModel ?? "auto",
        ).trim() || "auto",
    };
  };

  const render = (row) => {
    if (
      !els.aiUsageWrap ||
      !els.aiUsageKind ||
      !els.aiUsageModel ||
      !els.aiUsageCounts
    )
      return;
    els.aiUsageWrap.style.display = row.provider === "unknown" ? "none" : "";
    els.aiUsageKind.textContent = row.runtime === "local" ? "Local" : "Cloud";
    els.aiUsageModel.textContent = `${row.provider} / ${row.model}`;
    const count = (value) => Number(value).toLocaleString();
    let tokenText = "not used yet";
    if (row.tokenStatus === "reported")
      tokenText = `input ${count(row.inputTokens)} · output ${count(row.outputTokens)} · total ${count(row.totalTokens)}`;
    else if (row.tokenStatus === "incomplete")
      tokenText = `usage incomplete (input ${row.inputTokens == null ? "—" : count(row.inputTokens)} · output ${row.outputTokens == null ? "—" : count(row.outputTokens)} · total ${row.totalTokens == null ? "—" : count(row.totalTokens)})`;
    else if (row.tokenStatus === "unavailable")
      tokenText = "token usage unavailable from provider";
    const details = [];
    const subset = (key) => (row.tokenCoverage?.[key] || 0) < row.requests ? " (reported subset)" : "";
    if (row.pendingOperations || row.pendingOverflow) details.push(`${row.pendingOperations || 0} operation(s) awaiting confirmed usage${row.pendingOverflow ? ` + ${row.pendingOverflow} older unresolved operations` : ""}; not counted as zero`);
    if (row.incompleteRequests > 0) details.push(`usage missing/incomplete for ${row.incompleteRequests} request(s); shown counts are known subtotals`);
    if (row.cachedInputTokens != null) details.push(`${row.runtime === "local" ? "prompt reuse" : "cache read"} ${count(row.cachedInputTokens)}${(row.tokenCoverage?.cachedInputTokens || 0) < row.requests ? " (reported subset)" : ""}`);
    else if (row.requests > 0) details.push("cache read — not reported");
    if (row.cacheWriteInputTokens != null) details.push(`cache write ${count(row.cacheWriteInputTokens)}${subset("cacheWriteInputTokens")}`);
    if (row.uncachedInputTokens != null) details.push(`not cache-read ${count(row.uncachedInputTokens)}${subset("uncachedInputTokens")}`);
    if (row.thinkingTokens != null) details.push(`reasoning ${count(row.thinkingTokens)} (included in output)${subset("thinkingTokens")}`);
    if (row.providerCostUsd != null && row.runtime !== "local") details.push(`provider cost $${row.providerCostUsd}${row.costReportedRequests < row.requests ? " (known subtotal)" : ""}`);
    else if (row.requests > 0 && row.runtime !== "local") details.push("provider cost — not reported");
    els.aiUsageCounts.textContent = `${row.requests} request${row.requests === 1 ? "" : "s"} · ${tokenText}${details.length ? " · " + details.join(" · ") : ""}`;
    els.aiUsageCounts.title = "Translation usage only. Cache reads/writes are included in Input; reasoning is included in Output. Browser totals are not a customer billing balance.";
  };

  const refresh = async () => {
    if (
      !els.aiUsageWrap ||
      !els.aiUsageKind ||
      !els.aiUsageModel ||
      !els.aiUsageCounts
    )
      return;
    const selected = target();
    if (selected.provider === "unknown") {
      els.aiUsageWrap.style.display = "none";
      return;
    }
    const ledger = (await getStorage({ [storageKey]: null }))[storageKey];
    render(currentUsage(ledger, selected));
  };

  const formatNumber = (value) =>
    value == null ? "—" : Number(value).toLocaleString();
  const formatTime = (value) =>
    value > 0 ? new Date(value).toLocaleString() : "Unknown time";

  const renderHistory = async () => {
    if (!els.aiUsageHistoryList) return;
    const ledger = (await getStorage({ [storageKey]: null }))[storageKey];
    const rows = historyRows(ledger);
    els.aiUsageHistoryList.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "ai-usage-history-empty";
      empty.textContent = "No AI usage recorded yet.";
      els.aiUsageHistoryList.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const item = document.createElement("article");
      item.className = "ai-usage-history-item";
      const title = document.createElement("div");
      title.className = "ai-usage-history-item-title";
      const kind = document.createElement("span");
      kind.textContent = row.runtime === "local" ? "Local" : "Cloud";
      const model = document.createElement("strong");
      model.textContent = `${row.provider} / ${row.model}`;
      title.append(kind, model);
      const period = document.createElement("div");
      period.className = "ai-usage-history-period";
      period.textContent = `${formatTime(row.startedAt)} — ${row.current ? "Current" : row.endedAt ? formatTime(row.endedAt) : "Ended"}${row.resetReason ? ` · ${row.resetReason.replaceAll("_", " ")}` : ""}`;
      const requests = document.createElement("div");
      requests.textContent = `${row.requests} requests · ${row.successes} success · ${row.failures} failure`;
      const tokens = document.createElement("div");
      tokens.textContent = `Input ${formatNumber(row.inputTokens)} · Output ${formatNumber(row.outputTokens)} · Total ${formatNumber(row.totalTokens)}`;
      const detail = document.createElement("div");
      detail.textContent = `Cache read ${formatNumber(row.cachedInputTokens)} · Cache write ${formatNumber(row.cacheWriteInputTokens)} · Reasoning ${formatNumber(row.thinkingTokens)} · Provider cost ${row.providerCostUsd == null ? "—" : "$"+row.providerCostUsd}${row.costReportedRequests < row.requests ? " (known subtotal)" : ""} · Cache-read coverage ${row.tokenCoverage?.cachedInputTokens || 0}/${row.requests}${row.incompleteRequests ? ` · Incomplete usage: ${row.incompleteRequests} request(s); known subtotals only` : ""}`;
      const engines = document.createElement("div");
      engines.className = "ai-usage-history-engines";
      engines.textContent = `Extension ${row.extensionRequests} · API ${row.apiRequests}`;
      item.append(title, period, requests, tokens, detail, engines);
      els.aiUsageHistoryList.appendChild(item);
    }
  };

  const closeHistory = () => {
    const dialog = els.aiUsageHistoryDialog;
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else {
      dialog.removeAttribute("open");
      dialog.hidden = true;
    }
  };

  const openHistory = async () => {
    const dialog = els.aiUsageHistoryDialog;
    if (!dialog) return;
    await renderHistory();
    dialog.hidden = false;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  };

  return { target, render, refresh, openHistory, closeHistory };
}
