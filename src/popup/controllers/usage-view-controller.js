import { formatUsageLines, formatUsageSummary, formatUsageLabel } from "../../shared/ai/usage-view.js";
export function createUsageViewController({
  els,
  state,
  isLocalProvider,
  getStorage,
  storageKey,
  currentUsage,
  historyRows,
  flushUsage = null,
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
    els.aiUsageCounts.textContent = formatUsageLines(row);
    els.aiUsageCounts.title = "Input + output. Cached input is included, not subtracted. Token counts are not a bill.";
    if (els.aiUsageLabel) els.aiUsageLabel.textContent = formatUsageLabel(row);
    if (els.aiUsageTotal) els.aiUsageTotal.textContent = formatUsageSummary(row);
    els.aiUsageModel.title = `${row.provider} / ${row.model}`;

  };

  let refreshSequence = 0;
  const refreshImpl = async (recoverReceipts, snapshots) => {
    const sequence = ++refreshSequence;
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
    // Storage change events already carry the complete committed ledger. A
    // normal direct refresh folds durable receipts left by a stopped worker.
    // While translation is live, popup hydration uses refreshPassive() instead:
    // token display is read-only and must not scan/fold the whole receipt journal
    // on the same storage path the active worker is committing into.
    if (recoverReceipts && !snapshots.length && flushUsage)
      await flushUsage({ recover: true });
    const ledger = snapshots.length ? snapshots[0]
      : (await getStorage({ [storageKey]: null }))[storageKey];
    const current = target();
    if (sequence !== refreshSequence || current.runtime !== selected.runtime ||
        current.provider !== selected.provider || current.model !== selected.model) return;
    render(currentUsage(ledger, selected));
  };
  const refresh = async (...snapshots) => refreshImpl(true, snapshots);
  const refreshPassive = async (...snapshots) => refreshImpl(false, snapshots);

  const formatNumber = (value) =>
    value == null ? "—" : Number(value).toLocaleString("en-US");
  const formatTime = (value) =>
    value > 0 ? new Date(value).toLocaleString("en-GB") : "Unknown time";

  const renderHistory = async () => {
    if (!els.aiUsageHistoryList) return;
    if (flushUsage) await flushUsage({ recover: true });
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
      const metrics = document.createElement("div");
      metrics.className = "ai-metric-lines";
      metrics.textContent = formatUsageLines(row);
      const outcomes = document.createElement("div");
      outcomes.className = "ai-metric-lines";
      outcomes.textContent = `Completed calls: ${formatNumber(row.successes)}\nFailed calls: ${formatNumber(row.failures)}`;
      item.append(title, period, metrics, outcomes);
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

  return { target, render, refresh, refreshPassive, openHistory, closeHistory };
}
