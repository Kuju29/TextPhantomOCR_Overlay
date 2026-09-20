import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {formatUsageLines,formatUsageSummary} from '../src/shared/ai/usage-view.js';
import {createUsageViewController} from '../src/popup/controllers/usage-view-controller.js';
const row={runtime:'cloud',provider:'fixture',model:'test',requests:46,inputTokens:136342,outputTokens:3954,totalTokens:140296,thinkingTokens:0,cachedInputTokens:43520,uncachedInputTokens:92822,tokenStatus:'incomplete',pendingOperations:3,incompleteRequests:3};
for(const lang of ['th','en','ja']){
 const s=formatUsageLines(row,lang);assert.doesNotMatch(s,/[\u0e00-\u0e7f\u3040-\u30ff]/);assert.match(s,/Recorded total: 140,296/);assert.match(s,/Awaiting usage: 3/);assert.match(s,/Uncached input: 92,822/);
 assert.equal(formatUsageSummary(row),'140,296 · incomplete');
}
const html=await readFile(new URL('../src/popup/popup.html',import.meta.url),'utf8');
{const tag=html.match(/<details[^>]*id="ai-usage-wrap"[^>]*>/)[0];assert.doesNotMatch(tag,/\bopen\b/);} assert.ok(!html.includes('ai-diagnostics-wrap')); assert.ok(!html.includes('Latest AI request'));
const field=(value='')=>({value,style:{},textContent:'',title:'',addEventListener(){}});
const els={aiProvider:field('fixture'),aiModel:field('test'),lang:field('th'),aiUsageWrap:field(),aiUsageKind:field(),aiUsageModel:field(),aiUsageCounts:field(),aiUsageTotal:field()};
const controller=createUsageViewController({els,state:{desiredLang:'ja'},isLocalProvider:()=>false,currentUsage:()=>row,getStorage:async()=>({}),historyRows:()=>[],storageKey:'usage'});
controller.render(row);assert.equal(els.aiUsageTotal.textContent,'140,296 · incomplete');assert.match(els.aiUsageCounts.textContent,/Requests: 46/);assert.doesNotMatch(els.aiUsageCounts.textContent,/[\u0e00-\u0e7f]/);
assert.equal(formatUsageSummary({totalTokens:null}), '—');assert.match(formatUsageLines({requests:2,thinkingTokens:null,cachedInputTokens:null}),/Cached input \(included\): —/);
console.log('PASS collapsed English usage UI; diagnostics panel removed; exact totals/partial/unknown/subsets preserved.');
