import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const tabMessages = [];
globalThis.chrome = {
  runtime: { sendMessage(_msg, cb) { cb?.(); }, get lastError() { return null; } },
  tabs: { sendMessage(_tab, msg, _opts, cb) { tabMessages.push(msg); cb?.({ ok: true }); } },
};

const {
  IMAGE_PHASES, batchMark, batchPassStats, batchProgressSnapshot, batchUpdateToast, ensureBatch, markImagePhase,
  markLocalAiStreamProgress, updateImagePresentation,
  restoreBatchSnapshot, serializeBatchSnapshot,
} = await import("../src/background/batches.js");

assert.deepEqual(IMAGE_PHASES, [
  "waiting", "scanning", "downloading", "lens_queued", "lens", "grouping_queued", "grouping", "ai_queued",
  "ai_generating", "server_processing", "rendering", "done", "error", "cancelled",
]);
const batch = ensureBatch("progress-contract", 17, 0);
batch.items.set("a", { attempt: 1, status: "queued", payload: { context: { page_index: 0 } } });
assert.equal(batchPassStats(batch).total, 1, "an active item must never be reported as */0");
let snapshot = batchProgressSnapshot(batch, "Starting", 1000);
assert.equal(snapshot.active, 1);
assert.equal(snapshot.total, 1);
assert.equal(snapshot.items[0].phase, "waiting");
assert.equal(snapshot.items[0].label, "Image 1");
markImagePhase("progress-contract", "a", "ai_generating");
batchUpdateToast(batch, "AI is generating", true);
let liveStatus = tabMessages.filter((msg) => msg?.type === "BATCH_STATUS_UPDATE").at(-1);
assert.match(String(liveStatus?.batch?.message), /0\/1.*AI is generating/,
  "the batch status message must show both progress and the current image phase");
assert.equal(tabMessages.filter((msg) => msg?.type === "TP_TOAST").length, 0,
  "live batch progress must not create a competing toast beside the status board");
for (const [state, label] of [
  ["connecting", "Connecting to Local AI"],
  ["waiting_for_model", "Waiting for Local AI model"],
  ["thinking", "Local AI is thinking"],
  ["first_response", "Local AI responded"],
  ["generating", "Local AI is generating"],
  ["completed", "Local AI response complete"],
]) {
  markLocalAiStreamProgress("progress-contract", "a", state);
  const status = tabMessages.filter((msg) => msg?.type === "BATCH_STATUS_UPDATE").at(-1);
  assert.match(String(status?.batch?.message), new RegExp(label), `${state} must reach the real batch status message`);
}
assert.equal(markLocalAiStreamProgress("progress-contract", "a", "raw model text"), null,
  "provider content can never become a visible progress state");
let item = batch.items.get("a");
assert.equal(item.status, "processing");
assert.ok(Number(item.phaseAt) > 0);
const phaseAt = item.phaseAt;
batchMark("progress-contract", "a", { lastError: "metadata only" });
assert.equal(batch.items.get("a").phaseAt, phaseAt);
batchMark("progress-contract", "a", { status: "inserting" });
assert.equal(batch.items.get("a").phase, "rendering", "legacy callers can advance a canonical item");
markImagePhase("progress-contract", "a", "error", { lastError: "quota exhausted" });
batchUpdateToast(batch, "Error", true);
assert.match(String(tabMessages.filter((msg) => msg?.type === "BATCH_STATUS_UPDATE").at(-1)?.batch?.message), /inserted 0\/1.*Error: quota exhausted/,
  "a terminal failure must keep its real error without counting as an inserted image");
snapshot = batchProgressSnapshot(batch);
assert.equal(snapshot.active, 0);
assert.equal(snapshot.terminal, 1);
assert.equal(snapshot.items[0].error, "quota exhausted");
assert.equal(batchPassStats(batch).error, 1);
assert.equal(batchPassStats(batch).finished, 1, "internal completion is retained while finished text is hidden");
markImagePhase("progress-contract", "a", "rendering");
assert.equal(batch.items.get("a").phase, "error", "a late same-attempt update cannot reopen terminal work");
markImagePhase("progress-contract", "a", "server_processing", { attempt: 2 });
assert.equal(batch.items.get("a").phase, "server_processing", "a new attempt may reset terminal work");
assert.equal(batch.items.get("a").attempt, 2);

const encoded = serializeBatchSnapshot(batch);
assert.equal(encoded.items[0].payload, undefined, "persisted progress must not contain image bytes or request payloads");
const restored = restoreBatchSnapshot(encoded);
assert.ok(restored?.restored);
assert.equal(restored.items.get("a").phase, "server_processing");
restored.total2 = 0;
restored.pass = 2;
restored.items.get("a").attempt = 2;
const rebuilt = restoreBatchSnapshot(serializeBatchSnapshot(restored));
assert.equal(rebuilt.total2, 1, "restore rebuilds a missing total from current-attempt items");
assert.throws(() => markImagePhase("progress-contract", "a", "mystery"), /Unknown image phase/);

const repairPending = ensureBatch("progress-repair-pending", 17, 0);
repairPending.items.set("repair-page", { attempt:1, status:"processing", phase:"ai_generating" });
const deferredMessage = { type:"IMAGE_ERROR", original:"https://fixture.invalid/page", message:"deferred" };
const messageCountBeforeDeferred = tabMessages.length;
markImagePhase("progress-repair-pending", "repair-page", "error", {
  lastError:"wrong target language",
  deferredImageError:deferredMessage,
  suppressToast:true,
});
assert.equal(tabMessages.length, messageCountBeforeDeferred,
  "a repair-owned failure must not publish a terminal toast before recovery finishes");
const restoredDeferred = restoreBatchSnapshot(serializeBatchSnapshot(repairPending));
assert.deepEqual(restoredDeferred.items.get("repair-page").deferredImageError, deferredMessage,
  "the deferred terminal IMAGE_ERROR must survive service-worker recovery");
updateImagePresentation("progress-repair-pending", "repair-page", {repairPhase:"done"});
const repairDone=batchProgressSnapshot(repairPending);
assert.equal(repairDone.active,0,'repair done must terminalize the canonical batch item');
assert.equal(repairDone.items[0].progress.overall.state,'done');
assert.equal(batchPassStats(repairPending).done,1);

const multi = ensureBatch("progress-multi", 17, 0);
multi.total1 = 2;
multi.items.set("m1", { attempt: 1, status: "done", phase: "done", payload: { context: { page_index: 0 } } });
multi.items.set("m2", { attempt: 1, status: "processing", phase: "ai_generating", payload: { context: { page_index: 1 } } });
updateImagePresentation("progress-multi", "m1", {insertionAck:{present:true}});
batchUpdateToast(multi, "AI is generating", true);
assert.match(String(tabMessages.filter((msg) => msg?.type === "BATCH_STATUS_UPDATE").at(-1)?.batch?.message), /inserted 1\/2.*AI 1 active/,
  "translate-all must summarize active pipeline stages without pretending images run serially");

const progressPanel = await readFile(new URL("../src/content/progress-panel.js", import.meta.url), "utf8");
const messaging = await readFile(new URL("../src/content/messaging.js", import.meta.url), "utf8");
assert.match(progressPanel, /AI \/ queue/);
assert.match(progressPanel, /setInterval\(tick,500\)/,
  "running and queued timers must advance even while a provider emits no new event");
const batchHandler = messaging.slice(
  messaging.indexOf('if (type === "BATCH_STATUS_UPDATE")'),
  messaging.indexOf('if (type === "API_STATUS_UPDATE")'),
);
assert.match(batchHandler, /updateBatchProgress/,
  "batch telemetry must drive the per-image progress board");
assert.doesNotMatch(batchHandler, /showToast/,
  "the live board must not also duplicate progress into a toast");
console.log("Batch progress board contract tests passed.");

// A failed translation can acknowledge that its error badge was shown; this
// must never turn Insert=error into skipped or count as a placed translation.
const badgeReceipt = ensureBatch('progress-error-badge',17,0);
badgeReceipt.items.set('error-image',{attempt:1,status:'error',phase:'error',payload:{context:{page_index:0}}});
updateImagePresentation(badgeReceipt.id,'error-image',{
  placementPending:false,placementConfirmed:false,insertionAck:{present:false},
  progressEvent:{lane:'insert',state:'error',resultState:'error',detail:'Image error shown'},
});
assert.equal(badgeReceipt.items.get('error-image').progress.insert.state,'error');
assert.equal(badgeReceipt.items.get('error-image').progress.result.state,'error');
assert.equal(batchPassStats(badgeReceipt).inserted,0);
console.log('Error badge receipt preserves error status and zero inserted translations.');

// The reader can finish translating while an unmounted page stays in its
// existing placement queue. Keep the board visible until that page appears,
// while reporting that processing and repair generation have finished.
const fakeNode=()=>({style:{},dataset:{},textContent:'',isConnected:true,
  appendChild(){},addEventListener(){},setAttribute(){},contains(){return false;},querySelectorAll(){return []}});
const nodes={root:fakeNode(),main:fakeNode(),text:fakeNode(),toggle:fakeNode(),details:fakeNode()};
const page={__TP:{bail:false,getToastProgressHost:()=>nodes,setToastProgressMode(){}},addEventListener(){}};
vm.runInNewContext(progressPanel,{window:page,document:{addEventListener(){},createElement:fakeNode},
  setInterval:()=>1,clearInterval(){},setTimeout:(fn,delay)=>setTimeout(fn,delay>=1000?30:delay),clearTimeout});
const current=Date.now();
page.__TP.updateBatchProgress({id:'reader-finished-with-unmounted-page',startedAt:current+100,
  completedAt:current+200,ts:current+200,sequence:1,total:2,terminal:1,lifecycle:'completed',
  processingComplete:true,placement:{released:true,waiting:1,placed:1},repair:{phase:'apply_pending',failedUnits:1,
    repaired:1,unappliedRepairedUnits:1},items:[{label:'Image 1',terminal:true,inserted:true},
    {label:'Image 2',terminal:false,inserted:false,progress:{insert:{state:'queued'},ai:{state:'done'}}}]});
await new Promise(resolve=>setTimeout(resolve,180));
assert.match(nodes.text.textContent,/done .*processing complete.*1 saved for display/);
assert.match(nodes.text.textContent,/Repair translated 1\/1/);
assert.doesNotMatch(nodes.text.textContent,/Insert waiting|AI waiting/,
  'saved placement must not be displayed as live processing');
assert.equal(nodes.root.style.display,'block','a released reader stays visible while a saved result awaits its page');
page.__TP.updateBatchProgress({id:'reader-finished-with-unmounted-page',startedAt:current+100,
  completedAt:current+200,ts:current+201,sequence:2,total:2,terminal:2,lifecycle:'completed',
  processingComplete:true,placement:{released:true,waiting:0,placed:2},repair:{phase:'done',failedUnits:1,
    repaired:1},items:[{label:'Image 1',terminal:true,inserted:true},
    {label:'Image 2',terminal:true,inserted:true}]});
await new Promise(resolve=>setTimeout(resolve,180));
assert.equal(nodes.root.style.display,'none','the board hides after the last saved placement is acknowledged');
page.__TP.clearBatchProgress();
console.log('Reader status stays visible for lazy placement and hides after every saved page appears.');
