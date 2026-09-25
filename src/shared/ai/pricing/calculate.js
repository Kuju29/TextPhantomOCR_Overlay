import { money, sumMoney, lessMoney, multiplyMoney, perMillion } from "./money.js";
import { selectRate } from "./providers.js";
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
export function priceGeneration(event, config = {}) {
  const provided = money(event?.providerCostUsd);
  if (event?.runtime === "local") return { usd: "0", source: "local_api_free", status: "local_api_free", savingsUsd: null };
  if (String(event?.provider || "").toLowerCase() === "paid")
    return { usd: null, source: "paid_credits", status: "credit_charge_unavailable", savingsUsd: null };
  if (provided !== null) return { usd: provided, source: "provider", status: "reported", savingsUsd: null };
  const rate = selectRate(event?.provider, event?.resolvedModel || event?.model,
    config.overrides,event?.upstreamProvider,config.liveRates);
  if (!rate) return { usd: null, source: "no_rate", status: "unpriced", savingsUsd: null };
  if ([rate.input,rate.output].some(value=>money(value)===null) ||
      [rate.cached,rate.cacheWrite,rate.cacheWrite1h].some(value=>value != null && money(value)===null))
    return {usd:null,source:rate.origin,status:"invalid_rate",savingsUsd:null};
  const input = count(event?.inputTokens), output = count(event?.outputTokens);
  if (input === null || output === null || count(event?.totalTokens) !== input+output ||
      (event?.usageStatus && !["reported"].includes(event.usageStatus)))
    return { usd: null, source: rate.origin, status: "missing_usage", rate, savingsUsd: null };
  if ((event?.requests || 1) > 1 && rate.highContextThreshold && input > rate.highContextThreshold)
    return {usd:null,source:rate.origin,status:"unknown_per_request_tier",rate,savingsUsd:null};
  const cached = count(event.cachedInputTokens), write = count(event.cacheWriteInputTokens);
  const write1h = count(event.cacheWrite1hInputTokens), write5m = count(event.cacheWrite5mInputTokens);
  if ((cached !== null && cached > input) || (write !== null && write > input - (cached || 0)))
    return { usd: null, source: rate.origin, status: "inconsistent", rate, savingsUsd: null };
  if (write !== null && ((write1h !== null && write1h > write) ||
    (write5m !== null && write5m > write) ||
    (write1h !== null && write5m !== null && write1h + write5m !== write)))
    return { usd:null, source:rate.origin, status:"inconsistent_cache_duration", rate, savingsUsd:null };
  // Anthropic input is fresh + read + write. For other providers input includes
  // cached tokens; never add those tokens to Total a second time.
  const writeCount = write || 0, readCount = cached || 0;
  if (writeCount && !rate.cacheWrite)
    return { usd: null, source: rate.origin, status: "missing_cache_write_rate", rate, savingsUsd: null };
  const large = rate.highContextThreshold && input > rate.highContextThreshold;
  const inputRate = large ? multiplyMoney(rate.input, rate.highInputFactor) : rate.input;
  const outputRate = large ? multiplyMoney(rate.output, rate.highOutputFactor) : rate.output;
  const writeRate = large && rate.cacheWrite ? multiplyMoney(rate.cacheWrite,rate.highInputFactor) : rate.cacheWrite;
  const write1hRate = large && rate.cacheWrite1h ? multiplyMoney(rate.cacheWrite1h,rate.highInputFactor) : rate.cacheWrite1h;
  if (write1h && !write1hRate) return {usd:null,source:rate.origin,status:"missing_1h_cache_rate",rate,savingsUsd:null};
  const hourCount = write1h || 0;
  const durationKnown = !writeCount || write1h !== null || write5m === writeCount;
  const cacheRate = large && rate.cached ? multiplyMoney(rate.cached, rate.highInputFactor) : rate.cached;
  if (readCount && !cacheRate) return { usd: null, source:rate.origin, status:"missing_cache_rate", rate, savingsUsd:null };
  const parts = {
    ordinaryUsd: perMillion(input - readCount - writeCount, inputRate),
    cacheReadUsd: perMillion(readCount, cacheRate || "0"),
    cacheWriteUsd: sumMoney(perMillion(writeCount-hourCount,writeRate || "0"),perMillion(hourCount,write1hRate || "0")),
    outputUsd: perMillion(output, outputRate),
  };
  return {
    usd: sumMoney(...Object.values(parts)), source: rate.origin,
    status: cached === null && rate.cached ? "upper_bound_cache_unreported" :
      !durationKnown && rate.cacheWrite1h ? "cache_write_duration_unknown" :
      event.failures > 0 ? "estimated_failed_request" :
      rate.extraFees ? "estimate_excludes_extras" : "estimated",
    savingsUsd: cached === null ? null : lessMoney(perMillion(readCount, inputRate), parts.cacheReadUsd),
    parts, rate: { ...rate, input:inputRate, output:outputRate, cached:cacheRate || null, cacheWrite:writeRate || null },
  };
}
