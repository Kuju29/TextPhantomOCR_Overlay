import { formatUsageLabel, formatUsageLines, formatUsageSummary } from "../../shared/ai/usage-view.js";
import { normalizeUsageLedger } from "../../shared/ai-usage.js";
import { requestGroups } from "../../shared/ai/pricing/details.js";
import { bangkokDate, convertThb, refreshUsdThb } from "../../shared/ai/pricing/fx.js";
import { displayMoney, money } from "../../shared/ai/pricing/money.js";
import { rateKey, routeRateKey, selectRate } from "../../shared/ai/pricing/providers.js";
import { fetchLiveRate } from "../../shared/ai/pricing/live.js";

const number = value => value == null ? "—" : Number(value).toLocaleString("en-US");
const time = value => value ? new Date(value).toLocaleString("en-GB", {timeZone:"Asia/Bangkok",hour12:false}) : "Unknown";
const costStatus = price => price?.source === "provider" ? "Provider reported" :
  price?.source === "local_api_free" ? "Local API fee (hardware excluded)" :
  price?.source === "paid_credits" ? "TextPhantom credits (separate)" :
  price?.status === "estimate_excludes_extras" ? "Estimated tokens; provider may add request/image fees" :
  price?.status === "cache_write_duration_unknown" ? "Estimate uses 5-minute cache write rate; 1-hour writes may cost more" :
  price?.status === "estimated_posthoc" ? "Estimated using catalogue price fetched later the same day" :
  price?.status === "estimated_posthoc_cache_unknown" ? "Later catalogue estimate is an upper bound; cache count was not reported" :
  price?.status === "estimated_failed_request" ? "Estimated usage on a failed request; billing may differ" :
  price?.status === "upper_bound_cache_unreported" ? "Estimated upper bound; cache count unavailable" :
  price?.usd != null ? "Estimated at saved rate" : "Price unavailable";
const paragraph = (parent, value, className = "ai-usage-stat") => {
  const div = document.createElement("div"); div.className = className;
  div.textContent = value; parent.appendChild(div); return div;
};

export function createUsageViewController({els,state,isLocalProvider,getStorage,storageKey,
  currentUsage,historyRows,detailedRows=historyRows,flushUsage=null,persistPricingSettings=null}) {
  const target = (modelOverride=null) => {
    const provider = String(els.aiProvider?.value || "").trim();
    return {runtime:isLocalProvider(provider) ? "local" : "cloud",provider:provider || "unknown",
      model:String(modelOverride ?? els.aiModel?.value ?? state.desiredAiModel ?? "auto").trim() || "auto"};
  };
  let refreshSequence = 0, fxTask = null, lastFxAttempt = 0, rateTask = null;
  const lastRateAttempt = new Map();
  const routeFor = (ledger,selected,model=selected.model) => {
    const entries = normalizeUsageLedger(ledger).models;
    const matching = Object.values(entries).filter(v => v.provider?.toLowerCase() === selected.provider.toLowerCase() &&
      v.model?.toLowerCase() === String(model || "").toLowerCase());
    return matching.flatMap(v => v.sessions || []).flatMap(s => s.deltas || [])
      .sort((a,b) => (b.timestamp||0)-(a.timestamp||0)).find(d => d.upstreamProvider)?.upstreamProvider || "";
  };
  const thb = (usd, price, fx) => price?.thb ?? convertThb(usd, fx);
  const charge = (row, fx) => {
    const requests = row?.requests || 0, totals = row?.priceTotals;
    const unpriced = row?.runtime === "local" ? 0 : Math.max(totals?.unpricedRequests || 0, requests - (totals?.pricedRequests || 0));
    const usd = row?.runtime === "local" || !requests ? "0" : totals?.pricedRequests ? totals.usd : null;
    const converted = row?.runtime === "local" || !requests ? "0" :
      totals && totals.pricedRequests > 0 && totals.pricedRequests === totals.thbCoveredRequests
        ? totals.thb : convertThb(usd, fx);
    return { usd, thb: converted, unpriced };
  };
  const costLine = (row, fx) => {
    const cost = charge(row, fx);
    return `API cost ${displayMoney(cost.usd,"USD")} · ≈ ${displayMoney(cost.thb,"THB")}` +
      (cost.unpriced ? ` · ${number(cost.unpriced)} unpriced call${cost.unpriced === 1 ? "" : "s"}` : "");
  };
  const render = (row, ledger=null) => {
    if (!els.aiUsageWrap || !els.aiUsageCounts) return;
    const fx = ledger ? normalizeUsageLedger(ledger).pricing?.fx : null;
    const cost = charge(row, fx);
    els.aiUsageWrap.style.display = row.provider === "unknown" ? "none" : "";
    if (els.aiUsageKind) els.aiUsageKind.textContent = row.runtime === "local" ? "Local" : "Cloud";
    if (els.aiUsageModel) {
      els.aiUsageModel.textContent = `${row.provider} / ${row.model}`;
      els.aiUsageModel.title = `${row.provider} / ${row.model}`;
    }
    els.aiUsageCounts.textContent = formatUsageLines(row) +
      `\nCompleted: ${number(row.successes || 0)} · Failed: ${number(row.failures || 0)}` +
      `\n${costLine(row, fx)}`;
    els.aiUsageCounts.title = "Current provider/model session since the last switch or reset. Cached input and reasoning are already included in token totals.";
    if (els.aiUsageLabel) els.aiUsageLabel.textContent = formatUsageLabel(row);
    if (els.aiUsageTotal) {
      const amount = cost.thb == null ? displayMoney(cost.usd,"USD") : displayMoney(cost.thb,"THB");
      els.aiUsageTotal.textContent = `${formatUsageSummary(row)}  ≈ ${amount}${cost.unpriced ? " · partial" : ""}`;
      els.aiUsageTotal.title = `${costLine(row, fx)}. ${fx ? `Reference rate ${fx.rate} THB/USD (${fx.source}).` : "THB conversion unavailable."}`;
    }
  };
  const maybeRefreshFx = ledger => {
    if (!persistPricingSettings || fxTask || Date.now()-lastFxAttempt < 60000) return;
    const config = normalizeUsageLedger(ledger).pricing;
    if (config.fx?.manualRate || config.fx?.date === bangkokDate()) return;
    lastFxAttempt = Date.now();
    fxTask = refreshUsdThb(config).then(fx => {
      if (!fx || JSON.stringify(fx) === JSON.stringify(config.fx)) return;
      return persistPricingSettings(prior => ({...prior,fx:prior.fx?.manualRate ? prior.fx : fx}));
    }).catch(() => {}).finally(() => { fxTask=null; });
  };
  const maybeRefreshRate = (ledger,selected) => {
    if (!persistPricingSettings || rateTask || !["featherless","huggingface"].includes(selected.provider.toLowerCase())) return;
    const actual = currentUsage(ledger,selected);
    const model = selected.model === "auto" ? actual?.model : selected.model;
    const upstream = selected.provider.toLowerCase() === "huggingface" ? routeFor(ledger,selected,model) : "";
    if (!model || model === "auto" || (selected.provider.toLowerCase() === "huggingface" && !upstream)) return;
    const key = routeRateKey(selected.provider,model,upstream);
    const existing = normalizeUsageLedger(ledger).pricing.liveRates[key];
    if (existing?.fetchedAt && Date.now()-existing.fetchedAt < 12*60*60*1000) return;
    if (Date.now()-(lastRateAttempt.get(key)||0) < 60*60*1000) return;
    lastRateAttempt.set(key,Date.now());
    rateTask = fetchLiveRate(selected.provider,model,upstream).then(rate => {
      if (!rate) return;
      return persistPricingSettings(prior => ({...prior,liveRates:{...prior.liveRates,[key]:rate}}));
    }).catch(() => {}).finally(() => { rateTask=null; });
  };
  const refreshImpl = async (recover,snapshots) => {
    const sequence = ++refreshSequence;
    if (!els.aiUsageWrap) return;
    const selected = target();
    if (recover && !snapshots.length && flushUsage) await flushUsage({recover:true});
    const ledger = snapshots.length ? snapshots[0] : (await getStorage({[storageKey]:null}))[storageKey];
    const current = target();
    if (sequence !== refreshSequence || current.runtime !== selected.runtime || current.provider !== selected.provider || current.model !== selected.model) return;
    render(currentUsage(ledger,selected),ledger);
    maybeRefreshFx(ledger);
    maybeRefreshRate(ledger,selected);
  };
  const refresh = async (...snapshots) => refreshImpl(true,snapshots);
  const refreshPassive = async (...snapshots) => refreshImpl(false,snapshots);
  async function load() {
    if (flushUsage) await flushUsage({recover:true});
    return (await getStorage({[storageKey]:null}))[storageKey];
  }
  function renderRequest(parent,delta,fx) {
    const box = document.createElement("details"), summary = document.createElement("summary");
    box.className="ai-usage-request";
    summary.textContent=`${time(delta.timestamp)} · ${delta.failures ? "Failed" : "Completed"} · ${number(delta.totalTokens)} tokens · ${displayMoney(delta.price?.usd,"USD")}`;
    box.appendChild(summary);
    const p = delta.price || {};
    paragraph(box,`Input ${number(delta.inputTokens)} (cached read ${number(delta.cachedInputTokens)}, cache write ${number(delta.cacheWriteInputTokens)})\nOutput ${number(delta.outputTokens)} (reasoning ${number(delta.thinkingTokens)})\n${costStatus(p)} · ${displayMoney(p.usd,"USD")} · ≈ ${displayMoney(thb(p.usd,p,fx),"THB")}`);
    if (p.parts) paragraph(box,`Input ${displayMoney(p.parts.ordinaryUsd,"USD")} + cache read ${displayMoney(p.parts.cacheReadUsd,"USD")} + cache write ${displayMoney(p.parts.cacheWriteUsd,"USD")} + output ${displayMoney(p.parts.outputUsd,"USD")}`);
    if (p.rate) paragraph(box,`Saved $/1M: input ${p.rate.input}, cache read ${p.rate.cached ?? "—"}, cache write ${p.rate.cacheWrite ?? "—"}, output ${p.rate.output} · ${p.rate.origin || ""} ${p.rate.asOf || ""}`);
    if (p.savingsUsd != null) paragraph(box,`Cache read savings vs full input price: ≈ ${displayMoney(p.savingsUsd,"USD")}`);
    if (delta.requests>1) paragraph(box,`${number(delta.requests)} attempts; per-attempt token split unavailable`);
    parent.appendChild(box);
  }
  function show(dialog) {if (!dialog) return;dialog.hidden=false;if(typeof dialog.showModal==="function" && !dialog.open) dialog.showModal();else dialog.setAttribute("open","");}
  function close(dialog) {if (!dialog) return;if(typeof dialog.close==="function" && dialog.open) dialog.close();else{dialog.removeAttribute("open");dialog.hidden=true;}}
  function populateRates(ledger) {
    if (!els.aiPriceInput) return;
    const selected=target(),model=selected.model==="auto"?currentUsage(ledger,selected)?.model:selected.model;
    if (els.aiPriceProviderRates) els.aiPriceProviderRates.hidden = selected.runtime === "local";
    const pricing=normalizeUsageLedger(ledger).pricing,rate=selectRate(selected.provider,model,pricing.overrides,routeFor(ledger,selected,model),pricing.liveRates);
    for(const [key,val] of [["aiPriceInput",rate?.input],["aiPriceCached",rate?.cached],["aiPriceWrite",rate?.cacheWrite],["aiPriceOutput",rate?.output]])
      if(els[key]) els[key].value=val??"";
    if(els.aiPriceFx) els.aiPriceFx.value=pricing.fx?.manualRate||"";
    if(els.aiPriceStatus) els.aiPriceStatus.textContent=selected.runtime === "local"
      ? "Local AI uses your own computer: provider API charge $0. Hardware and electricity are excluded."
      : rate
      ? `${selected.provider}/${model}: ${rate.origin==="user"?"Custom":rate.origin==="live_catalogue"?`Live catalogue ${rate.asOf}`:`Provider snapshot ${rate.asOf}`} · ${rate.url||""}`
      : `${selected.provider}/${model}: no verified rate; enter input and output for future requests.`;
  }
  async function saveRates() {
    if(!persistPricingSettings || !els.aiPriceStatus) return;
    const ledger=await load(),selected=target(),model=selected.model==="auto"?currentUsage(ledger,selected)?.model:selected.model;
    const read=key=>els[key]?.value?.trim()??"";
    const input=read("aiPriceInput"),cached=read("aiPriceCached"),write=read("aiPriceWrite"),output=read("aiPriceOutput"),manualRate=read("aiPriceFx");
    if(selected.runtime!=="local" && (input||output||cached||write) && (!model||model==="auto"||money(input)===null||money(output)===null||
      (cached&&money(cached)===null)||(write&&money(write)===null)||[input,output,cached,write].some(v=>v&&Number(v)>10000))) {
      els.aiPriceStatus.textContent="Choose a specific model and valid USD rates per million tokens.";return;
    }
    if(manualRate&&(money(manualRate)===null||Number(manualRate)<15||Number(manualRate)>70)) {
      els.aiPriceStatus.textContent="USD/THB must be between 15 and 70.";return;
    }
    const before=normalizeUsageLedger(ledger).pricing,rate=selectRate(selected.provider,model,before.overrides,routeFor(ledger,selected,model),before.liveRates);
    const changed=[input,cached,write,output].some((v,i)=>v!==String([rate?.input,rate?.cached,rate?.cacheWrite,rate?.output][i]??""));
    await persistPricingSettings(prior=>{
      const overrides={...prior.overrides};
      if(selected.runtime!=="local"&&changed&&input&&output) overrides[rateKey(selected.provider,model)]={input,output,...(cached?{cached}:{}),...(write?{cacheWrite:write}:{}),asOf:bangkokDate(),origin:"user"};
      const fx=manualRate?{rate:manualRate,manualRate,date:bangkokDate(),source:"manual"}:prior.fx?.manualRate?null:prior.fx;
      return {...prior,overrides,fx};
    });
    els.aiPriceStatus.textContent="Saved. Existing request prices stay fixed.";
    await refreshPassive();
  }
  els.aiPriceSave?.addEventListener?.("click",()=>void saveRates().catch(e=>{if(els.aiPriceStatus) els.aiPriceStatus.textContent=`Could not save: ${e.message}`;}));
  els.aiPriceRestore?.addEventListener?.("click",()=>void (async()=>{
    if(!persistPricingSettings) return;
    const ledger=await load(),selected=target(),model=selected.model==="auto"?currentUsage(ledger,selected)?.model:selected.model;
    if(!model||model==="auto") {els.aiPriceStatus.textContent="Choose a specific model first.";return;}
    await persistPricingSettings(prior=>{
      const overrides={...prior.overrides};delete overrides[rateKey(selected.provider,model)];
      return {...prior,overrides};
    });
    populateRates(await load());
    els.aiPriceStatus.textContent+= " · Custom rate cleared for future requests.";
  })().catch(e=>{if(els.aiPriceStatus) els.aiPriceStatus.textContent=`Could not restore: ${e.message}`;}));
  async function openDetailed() {
    if(!els.aiUsageDetailedList) return;
    const selected=target(),ledger=await load();
    if (target().runtime!==selected.runtime||target().provider!==selected.provider||target().model!==selected.model) return;
    const list=els.aiUsageDetailedList;list.replaceChildren();
    const row=currentUsage(ledger,selected),fx=normalizeUsageLedger(ledger).pricing?.fx;
    const session=detailedRows(ledger).find(item=>item.current&&item.runtime===selected.runtime&&
      item.provider.toLowerCase()===selected.provider.toLowerCase()&&item.model.toLowerCase()===row.model.toLowerCase());
    const groups=requestGroups(session?[session]:[]);
    paragraph(list,`${row.runtime==="local"?"Local":"Cloud"} · ${row.provider} / ${row.model}\n`+
      `${row.startedAt?time(row.startedAt):"No current session"} — Current · ${number(row.requests)} AI calls · ${number(row.failures)} failed · ${formatUsageSummary(row)} tokens\n${costLine(row,fx)}`);
    if(groups.reduce((n,g)=>n+g.requests,0)<row.requests) paragraph(list,"Some older individual calls are no longer retained; the session totals above still include them.");
    if(!groups.length) paragraph(list,"No calls in this session yet.");
    for(const group of groups) {
      const item=document.createElement("article");item.className="ai-usage-history-item";
      paragraph(item,`${time(group.startedAt)}\n${number(group.imageRequests)} image requests · ${number(group.requests)} AI calls · ${number(group.failures)} failed · ${number(group.totalTokens)} tokens · ${displayMoney(group.usd,"USD")}${group.unpricedRequests?` + ${group.unpricedRequests} unpriced`:""}`);
      for(const delta of group.deltas) renderRequest(item,delta,fx);
      list.appendChild(item);
    }
    populateRates(ledger);show(els.aiUsageDetailedDialog);
  }
  async function openHistory() {
    if(!els.aiUsageHistoryList) return;
    const ledger=await load(),fx=normalizeUsageLedger(ledger).pricing?.fx,list=els.aiUsageHistoryList;list.replaceChildren();
    const rows=detailedRows(ledger);
    if(!rows.length) paragraph(list,"No AI usage recorded yet.","ai-usage-history-empty");
    for(const row of rows) {
      const item=document.createElement("article");item.className="ai-usage-history-item";
      const title=document.createElement("div");title.className="ai-usage-history-item-title";
      const kind=document.createElement("span");kind.textContent=row.runtime==="local"?"Local":"Cloud";
      const name=document.createElement("strong");name.textContent=`${row.provider} / ${row.model}`;
      title.append(kind,name);item.appendChild(title);
      paragraph(item,`${time(row.startedAt)} — ${row.current?"Current":row.endedAt?time(row.endedAt):"Ended"} · ${(row.resetReason||"session").replaceAll("_"," ")}`,"ai-usage-history-period");
      paragraph(item,formatUsageLines(row),"ai-metric-lines");
      paragraph(item,`${number(row.requests)} calls · ${number(row.successes)} completed · ${number(row.failures)} failed\n${costLine(row,fx)}`+
        (row.runtime!=="local"&&row.priceTotals?.pricedRequests ?
          `\nProvider reported ${displayMoney(row.priceTotals.reportedUsd,"USD")} · saved-rate estimate ${displayMoney(row.priceTotals.estimatedUsd,"USD")}` : ""));
      if(row.requests>(row.deltas||[]).reduce((n,d)=>n+(d.requests||1),0)) paragraph(item,"Newest 200 individual calls retained; session totals include older calls.");
      if(row.deltas?.length) {
        const calls=document.createElement("details"),summary=document.createElement("summary");
        calls.className="ai-usage-request";summary.textContent=`Individual requests (${number(row.deltas.length)} records)`;
        calls.appendChild(summary);
        for(const delta of row.deltas) renderRequest(calls,delta,fx);
        item.appendChild(calls);
      }
      list.appendChild(item);
    }
    show(els.aiUsageHistoryDialog);
  }
  return {target,render,refresh,refreshPassive,openDetailed,closeDetailed:()=>close(els.aiUsageDetailedDialog),openHistory,closeHistory:()=>close(els.aiUsageHistoryDialog)};
}
