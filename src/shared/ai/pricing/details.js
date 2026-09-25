import { bangkokDate } from "./fx.js";
import { sumMoney } from "./money.js";
export function requestGroups(history, day = null) {
  const groups = new Map();
  for (const row of history || []) for (const delta of row.deltas || []) {
    if (day && bangkokDate(delta.timestamp || row.startedAt) !== day) continue;
    const groupId = delta.groupKey;
    const key = `${row.runtime}|${row.provider}|${row.model}|${groupId}`;
    let group = groups.get(key);
    if (!group) { group = { id:groupId, startedAt:delta.timestamp, runtime:row.runtime,
      provider:row.provider, model:row.model, requests:0, failures:0,
      imageRequests:0, totalTokens:0, usd:"0", unpricedRequests:0, deltas:[] }; groups.set(key,group); }
    group.requests += delta.requests || 1;
    group.failures += delta.failures || 0;
    group.imageRequests += delta.imageCount || 0;
    group.totalTokens += delta.totalTokens || 0;
    group.startedAt = Math.min(group.startedAt, delta.timestamp);
    if (delta.price?.usd == null) group.unpricedRequests += delta.requests || 1;
    else group.usd = sumMoney(group.usd, delta.price.usd);
    group.deltas.push(delta);
  }
  return [...groups.values()].sort((a,b) => b.startedAt - a.startedAt);
}
export function todayRequestGroups(history, at = Date.now()) {
  return requestGroups(history, bangkokDate(at));
}
