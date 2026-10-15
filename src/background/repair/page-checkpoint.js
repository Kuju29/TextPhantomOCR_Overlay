import { reservedConversation } from '../ai/translation-paths/order.js';
import { applyTranslations } from '../../shared/lens-document.js';
import { eraseBoxesForAiPartial } from '../../shared/erase-boxes.js';
import { sessionSafe } from '../translation-session-store.js';
import { pageImageEnabled } from '../../shared/page-image-policy.js';
import { hasMeaningfulAiSource } from '../../shared/ai-source-filter.js';

const stable = value => value == null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
export async function digestText(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkpointGroupKey(ai, apiKey, sourceLang, targetLang, route, rate, imageId, legacy = false) {
  const groupingAi = sessionSafe({...ai});
  if (groupingAi.translation_mode === 'independent') delete groupingAi.independent_examples;
  if (groupingAi.conversation) {
    const {pageId,pageIndex,pageOrder,pageQueueWaitMs, ...scope} = groupingAi.conversation;
    groupingAi.conversation = scope;
  }
  return digestText(stable({ai:groupingAi, account:await digestText(apiKey), ...(legacy ? {sourceLang} : {}),
    targetLang, route, rate, image:pageImageEnabled(ai?.send_image) ? imageId : ''}));
}

export async function checkpointCredentialMatches(page, apiKey) {
  if (!apiKey || !/^[a-f0-9]{64}$/.test(String(page?.groupKey || ''))) return false;
  const matches = (rate, legacy) => checkpointGroupKey(page.ai, apiKey, page.sourceLang,
    page.targetLang, page.route, rate, page.pageId, legacy).then(key => key === page.groupKey);
  // Old checkpoints normalize a missing rate to null after computing the group.
  return await matches(page.rate, false) || await matches(page.rate, true) ||
    (page.rate == null && (await matches(undefined, false) || await matches(undefined, true)));
}

export async function makePageCheckpoint({ payload, result, plan, units, ctx, operationId }) {
  const reserved = reservedConversation(payload);
  const cleanAi = sessionSafe({...plan.ai, ...(reserved ? {conversation:reserved} : {})});
  // Example pairs live once in bounded local storage. Repeating them in every
  // page checkpoint would waste session quota and fragment repair grouping.
  if (cleanAi.translation_mode === 'independent') delete cleanAi.independent_examples;
  const sourceLang = String(result?.lensDocument?.languages?.source || '');
  const imageId = String(payload.metadata?.image_id || ctx.imageKey || '');
  const groupKey = await checkpointGroupKey(cleanAi, plan.ai?.api_key || '',
    sourceLang, payload.lang, plan.route, payload.rate, imageId);
  const rows = await Promise.all(units.map(async u => ({ id: String(u.id), text: String(u.text),
    paragraphIds: u.paragraphIds, translatable: u.translatable,
    sourceHash: await digestText(u.text) })));
  // Only the renderer payload is needed for a patch; remove raw OCR debug,
  // binary image fields and transient generation telemetry.
  const cleanResult = sessionSafe({ lensDocument: result.lensDocument,
    backgroundMode: result.backgroundMode, layout: result.layout,
    metadata: result.metadata, source: result.source, Ai: result.Ai, meta: result.meta,
    warnings: result.warnings });
  return { pageId: imageId, generationId: ctx.jobId || operationId.replace(/[^A-Za-z0-9:_.-]/g, '_').slice(0,160),
    groupKey, sourceLang, targetLang: payload.lang, route: plan.route, ai: cleanAi,
    rate: payload.rate || null, unlimited: payload.limits?.aiUnlimited === true,
    operationId, ctx: sessionSafe(ctx), result: cleanResult, originalEraseBoxes: result.eraseBoxes,
    units: rows, accepted: [], failures: [], blocked: [], inFlight: [], phase: 'prepared', delivered: false,
    repaired: [], sourceEvidence: [] };
}

// Once every translatable unit has an accepted answer and the page confirms
// placement, neither repair nor a replay needs its OCR/render source. Retain
// only the small report required by the chapter-wide repair seal.
export function compactDeliveredPage(page) {
  if (!page || page.compacted === true || page.phase !== 'finished' || page.delivered !== true ||
      page.patchPending || page.patchError || (page.repaired || []).length ||
      (page.failures || []).length || (page.blocked || []).length || (page.inFlight || []).length ||
      !Array.isArray(page.units) || !Array.isArray(page.accepted)) return page;
  const wanted = new Set(page.units.filter(unit => unit.translatable && hasMeaningfulAiSource(unit.text)).map(unit => String(unit.id)));
  const accepted = new Set(page.accepted.map(unit => String(unit.id)));
  if (wanted.size !== accepted.size || [...wanted].some(id => !accepted.has(id))) return page;
  return { pageId:page.pageId, generationId:page.generationId, groupKey:page.groupKey,
    phase:'finished', delivered:true, compacted:true, initialAcceptedCount:accepted.size,
    units:[], accepted:[], failures:[], blocked:[], inFlight:[], repaired:[] };
}

export function buildPatchedResult(page, accepted) {
  // Rebuild from the original checkpoint + immutable accepted map, never from
  // arbitrary provider IDs or a partially patched DOM.
  const byId = new Map(page.units.map(u => [u.id, u]));
  const skipped = new Set(page.units.filter(u => !u.translatable || !hasMeaningfulAiSource(u.text)).map(u => u.id));
  const safe = new Map(page.accepted.filter(u => byId.has(u.id) && !skipped.has(u.id)).map(u => [u.id, u.text]));
  for (const item of accepted) {
    const source = byId.get(item.unitId || item.id);
    if (!source || item.sourceHash !== source.sourceHash ||
        item.generationId !== page.generationId || safe.has(source.id) || skipped.has(source.id) || item.state === 'skipped') continue;
    safe.set(source.id, item.translation);
  }
  const passthrough = page.units.filter(u => skipped.has(u.id)).map(u => ({ id: u.id, text: u.text }));
  const applied = applyTranslations(page.result.lensDocument,
    [...safe].map(([id,text]) => ({id,text})).concat(passthrough));
  const result = structuredClone(page.result);
  result.lensDocument = applied.document;
  result.aiRoute = { ...(result.aiRoute || {}), ...applied.report, translated:safe.size, skippedUnitIds:[...skipped], skippedUnits:skipped.size,
    contentRepairOwner: 'server_pool', contentRepairAttempts: accepted.some(row => row.state !== 'skipped') || page.repaired.length ? 1 : 0 };
  const missing = applied.report.missing.map(String);
  if (missing.length) {
    const erased = eraseBoxesForAiPartial(applied.document, page.originalEraseBoxes);
    if (!erased.ok) throw Object.assign(new Error(erased.reason), {code:'repair_erase_conflict', failedStage:'render'});
    result.eraseBoxes = erased.eraseBoxes;
    result.aiPartial = { partial: true, translated: safe.size, missing,
      missingUnits: missing.map(id => ({ id, paragraphIds: byId.get(id)?.paragraphIds || [] })),
      omitted: [], declined: [], wrongLanguage: page.failures.filter(x => x.reason === 'wrong_language' && missing.includes(x.id)).map(x => x.id) };
  } else {
    result.eraseBoxes = page.originalEraseBoxes;
    delete result.aiPartial;
  }
  result.warnings = (result.warnings || []).filter(x => !String(x).startsWith('AI left '));
  return { result, missing, skipped:[...skipped], accepted: [...safe].map(([id,text]) => ({id,text})) };
}

export function pageInitialReport(page) {
  return { pageId: page.pageId, generationId: page.generationId, groupKey: page.groupKey,
    status: page.phase === 'interrupted' ? 'interrupted' : 'finished',
    initialAccepted: page.compacted ? page.initialAcceptedCount : page.accepted.filter(row => hasMeaningfulAiSource(page.units.find(u => u.id === row.id)?.text)).length,
    unverified: page.blocked.length,
    failed: page.failures.map(f => ({ ...f, text: page.units.find(u => u.id === f.id).text,
      sourceHash: page.units.find(u => u.id === f.id).sourceHash })) };
}
