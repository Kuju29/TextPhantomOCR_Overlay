import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createUsageViewController } from "../src/popup/controllers/usage-view-controller.js";
import { currentUsage, applyUsageSelectionBoundary, recordProviderGeneration,
  resetActiveUsage, normalizeUsageLedger, usageDetailedRows, usageHistoryRows, usageToday } from "../src/shared/ai-usage.js";

class Element {
  constructor(value = "") { this.value=value; this.textContent=""; this.title=""; this.style={}; this.children=[]; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=[...children]; }
  setAttribute() { this.open=true; }
  showModal() { this.open=true; }
  addEventListener() {}
}
globalThis.document={createElement:()=>new Element()};
const field = value => new Element(value);
const els = {aiProvider:field("openrouter"),aiModel:field("gpt-4"),aiUsageWrap:field(),
  aiUsageKind:field(),aiUsageModel:field(),aiUsageCounts:field(),aiUsageTotal:field(),aiUsageLabel:field(),
  aiUsageDetailedList:field(),aiUsageDetailedDialog:field(),aiUsageHistoryList:field(),aiUsageHistoryDialog:field()};
const at=Date.parse("2026-09-25T03:00:00Z"), fx={rate:"34",date:"2026-09-25",source:"manual",manualRate:"34"};
const cloud={runtime:"cloud",provider:"openrouter",model:"gpt-4"};
let ledger=normalizeUsageLedger(null); ledger.pricing.fx=fx;
const add=(target,operationId,inputTokens,outputTokens,usd,stamp)=>{
  ledger=recordProviderGeneration(ledger,{...target,operationId,engine:"runsextension",
    inputTokens,outputTokens,totalTokens:inputTokens+outputTokens,providerCostUsd:usd,
    cachedInputTokens:0,imageCount:1,jobId:operationId,startedAt:stamp},
    {now:stamp,id:()=>`session-${operationId}`});
};
const ui=createUsageViewController({els,state:{},isLocalProvider:p=>p==="ollama",storageKey:"usage",
  getStorage:async()=>({usage:ledger}),currentUsage,historyRows:usageHistoryRows,detailedRows:usageDetailedRows});
add(cloud,"first",1000,100,"1.25",at);
await ui.refresh(ledger);
assert.equal(els.aiUsageModel.textContent,"openrouter / gpt-4");
assert.match(els.aiUsageTotal.textContent,/^1,100\s+≈ ฿42\.50$/);
assert.match(els.aiUsageCounts.textContent,/API cost \$1\.25 · ≈ ฿42\.50/);

const gemini={runtime:"cloud",provider:"gemini",model:"flash"};
ledger=applyUsageSelectionBoundary(ledger,{...gemini,reason:"provider_switch"},{now:at+100});
els.aiProvider.value="gemini";els.aiModel.value="flash";
ui.render({...gemini,requests:0,totalTokens:0,tokenStatus:"not_used"});
assert.match(els.aiUsageTotal.textContent,/^0\s+≈ ฿0\.00$/,"the immediate switch is zero even before storage returns");
await ui.refresh(ledger);
assert.equal(els.aiUsageModel.textContent,"gemini / flash");
assert.equal(els.aiUsageKind.textContent,"Cloud");
assert.match(els.aiUsageCounts.textContent,/Requests: 0/);
assert.doesNotMatch(els.aiUsageCounts.textContent,/42\.50|Cloud API charges today/);
add(gemini,"second",300,50,"0.50",at+200);
await ui.refresh(ledger);
assert.match(els.aiUsageTotal.textContent,/^350\s+≈ ฿17\.00$/);
assert.equal(usageToday(ledger,at+200).totalTokens,1450,"the saved daily ledger still has both calls");

await ui.openDetailed();
const details=JSON.stringify(els.aiUsageDetailedList);
assert.match(details,/gemini \/ flash/);
assert.match(details,/\$0\.50/);
assert.doesNotMatch(details,/openrouter|\$1\.25|Today across providers/,
  "Detailed includes only the active provider/model session");
await ui.openHistory();
assert.equal(els.aiUsageHistoryList.children.length,2);
const history=els.aiUsageHistoryList.children.map(item=>JSON.stringify(item));
assert.match(history[0],/gemini \/ flash/);
assert.match(history[0],/\$0\.50/);
assert.doesNotMatch(history[0],/\$1\.25/);
assert.match(history[1],/openrouter \/ gpt-4/);
assert.match(history[1],/\$1\.25/);
assert.doesNotMatch(history[1],/\$0\.50/);

ledger=resetActiveUsage(ledger,{now:at+300,id:()=>"manual-reset"});
await ui.refresh(ledger);
assert.match(els.aiUsageTotal.textContent,/^0\s+≈ ฿0\.00$/);
await ui.openHistory();
assert.equal(els.aiUsageHistoryList.children.length,3,"Reset preserves prior session with its own time and cost");

ledger=applyUsageSelectionBoundary(ledger,{...cloud,reason:"provider_switch"},{now:at+400});
els.aiProvider.value="openrouter";els.aiModel.value="gpt-4";await ui.refresh(ledger);
assert.match(els.aiUsageTotal.textContent,/^0\s+≈ ฿0\.00$/,"returning to an earlier provider starts fresh");

const local={runtime:"local",provider:"ollama",model:"qwen"};
ledger=applyUsageSelectionBoundary(ledger,{...local,reason:"provider_switch"},{now:at+500});
els.aiProvider.value="ollama";els.aiModel.value="qwen";
add(local,"local",2000,100,null,at+600);
await ui.refresh(ledger);
assert.equal(els.aiUsageKind.textContent,"Local");
assert.match(els.aiUsageTotal.textContent,/^2,100\s+≈ ฿0\.00$/);
assert.match(els.aiUsageCounts.textContent,/API cost \$0\.00 · ≈ ฿0\.00/);
assert.doesNotMatch(els.aiUsageCounts.textContent,/\$1\.25|\$0\.50/);
const css=await readFile(new URL("../src/popup/popup.css",import.meta.url),"utf8");
assert.doesNotMatch(css,/\.ai-summary-value\s*\{[^}]*float\s*:\s*right/,
  "a floated monetary summary squeezes the expanded metrics into a narrow column");
console.log("PASS Tokens used, Detailed and History follow selected provider/model sessions and isolated prices");
