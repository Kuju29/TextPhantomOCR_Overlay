import { applyTranslations, translationUnits } from '../../shared/lens-document.js';
import { eraseBoxesForAiPartial } from '../../shared/erase-boxes.js';
import { sessionSafe } from '../translation-session-store.js';

export const stable = value => value == null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
export async function digestText(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function makePageCheckpoint({ payload, result, plan, units, ctx, operationId }) {
  const cleanAi = sessionSafe(plan.ai || {});
  const sourceLang = String(result?.lensDocument?.languages?.source || '');
  const imageId = String(payload.metadata?.image_id || ctx.imageKey || '');
  const groupKey = await digestText(stable({ ai: cleanAi, account: await digestText(plan.ai?.api_key || ''),
    sourceLang, targetLang: payload.lang, route: plan.route, rate: payload.rate,
    // Never mix page-specific visual/series evidence across images.
    image: plan.ai?.send_image ? imageId : '' }));
  const rows = await Promise.all(units.map(async u => ({ id: String(u.id), text: String(u.text),
    paragraphIds: u.paragraphIds, translatable: u.translatable,
    sourceHash: await digestText(u.text) })));
  // Only the renderer payload is needed for a patch; remove raw OCR debug,
  // binary image fields and transient generation telemetry.
  const cleanResult = sessionSafe({ lensDocument: result.lensDocument, eraseBoxes: result.eraseBoxes,
    backgroundMode: result.backgroundMode, layout: result.layout,
    metadata: result.metadata, source: result.source, Ai: result.Ai, meta: result.meta,
    warnings: result.warnings });
  return { pageId: imageId, generationId: ctx.jobId || operationId.replace(/[^A-Za-z0-9:_.-]/g, '_').slice(0,160),
    groupKey, sourceLang, targetLang: payload.lang, route: plan.route, ai: cleanAi,
    rate: payload.rate || null, unlimited: payload.limits?.aiUnlimited === true,
    operationId, ctx: sessionSafe(ctx), result: cleanResult, originalEraseBoxes: result.eraseBoxes,
    units: rows, accepted: [], failures: [], blocked: [], inFlight: [], phase: 'prepared', delivered: false,
    repaired: [] };
}

export function buildPatchedResult(page, accepted) {
  // Rebuild from the original checkpoint + immutable accepted map, never from
  // arbitrary provider IDs or a partially patched DOM.
  const byId = new Map(page.units.map(u => [u.id, u]));
  const safe = new Map(page.accepted.map(u => [u.id, u.text]));
  for (const item of accepted) {
    const source = byId.get(item.unitId || item.id);
    if (!source || item.sourceHash !== source.sourceHash ||
        item.generationId !== page.generationId || safe.has(source.id)) continue;
    safe.set(source.id, item.translation);
  }
  const passthrough = page.units.filter(u => !u.translatable).map(u => ({ id: u.id, text: u.text }));
  const applied = applyTranslations(page.result.lensDocument,
    [...safe].map(([id,text]) => ({id,text})).concat(passthrough));
  const result = structuredClone(page.result);
  result.lensDocument = applied.document;
  result.aiRoute = { ...(result.aiRoute || {}), ...applied.report, contentRepairOwner: 'server_pool', contentRepairAttempts: accepted.length || page.repaired.length ? 1 : 0 };
  const missing = applied.report.missing.map(String);
  if (missing.length) {
    const erased = eraseBoxesForAiPartial(applied.document, page.originalEraseBoxes);
    if (!erased.ok) throw Object.assign(new Error(erased.reason), {code:'repair_erase_conflict', failedStage:'render'});
    result.eraseBoxes = erased.eraseBoxes;
    result.aiPartial = { partial: true, translated: applied.report.translated, missing,
      missingUnits: missing.map(id => ({ id, paragraphIds: byId.get(id)?.paragraphIds || [] })),
      omitted: [], declined: [], wrongLanguage: page.failures.filter(x => x.reason === 'wrong_language' && missing.includes(x.id)).map(x => x.id) };
  } else {
    result.eraseBoxes = page.originalEraseBoxes;
    delete result.aiPartial;
  }
  result.warnings = (result.warnings || []).filter(x => !String(x).startsWith('AI left '));
  if (missing.length) result.warnings.push(`AI repair finished; ${missing.length} unit(s) remain unresolved: ${missing.join(', ')}`);
  return { result, missing, accepted: [...safe].map(([id,text]) => ({id,text})) };
}

export function pageInitialReport(page) {
  return { pageId: page.pageId, generationId: page.generationId, groupKey: page.groupKey,
    status: page.phase === 'interrupted' ? 'interrupted' : 'finished',
    initialAccepted: page.accepted.length, unverified: page.blocked.length,
    failed: page.failures.map(f => ({ ...f, text: page.units.find(u => u.id === f.id).text,
      sourceHash: page.units.find(u => u.id === f.id).sourceHash })) };
}
