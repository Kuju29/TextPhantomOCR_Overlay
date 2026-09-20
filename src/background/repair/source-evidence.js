import { selectPageContext } from '../../shared/ai/page-context.js';

function checkpointError(code) { return Object.assign(new Error(code), { code }); }

// Store IDs only: source text already lives in the immutable page checkpoint.
export function sourceEvidenceForDispatch(page, dispatch) {
  if (!dispatch?.ids?.length || !dispatch.operationId) return null;
  const byId = new Map(page.units.map(unit => [String(unit.id), unit]));
  const targetIds = [...new Set(dispatch.ids.map(String))];
  if (targetIds.some(id => !byId.has(id))) throw checkpointError('source_evidence_target_missing');
  const targets = targetIds.map(id => byId.get(id));
  const contextIds = Array.isArray(dispatch.contextIds) ? dispatch.contextIds.map(String)
    : selectPageContext(page.units.filter(u => u.translatable !== false), targets).map(u => u.id);
  if (contextIds.some(id => !byId.has(id))) throw checkpointError('source_evidence_context_missing');
  const selected = new Set([...targetIds, ...contextIds]);
  const evidenceIds = page.units.filter(unit => selected.has(String(unit.id))).map(unit => String(unit.id));
  return { operationId: String(dispatch.operationId), targetIds, evidenceIds };
}

export function applySourceEvidence(page, evidence) {
  if (!evidence) return;
  page.sourceEvidence ||= [];
  const prior = page.sourceEvidence.find(row => row.operationId === evidence.operationId);
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(evidence)) throw checkpointError('source_evidence_conflict');
  } else page.sourceEvidence.push(evidence);
}

// Called on normal dispatch and the combined answer/next-dispatch commit.
export function captureSourceEvidence(page, dispatch) {
  applySourceEvidence(page, sourceEvidenceForDispatch(page, dispatch));
}

// Preserve cross-page repair packing. Each original request is an explicitly
// scoped source group; aliases become Pn only at the actual provider boundary.
export function repairSourceContext(pages, rows) {
  const groups = new Map();
  for (const row of rows) {
    const page = pages.get(row.pageId);
    if (!page) throw checkpointError('repair_checkpoint_missing');
    const unitId = String(row.unitId || row.id);
    const byId = new Map(page.units.map(unit => [String(unit.id), unit]));
    const original = byId.get(unitId);
    if (!original || original.text !== row.text || (row.sourceHash && original.sourceHash !== row.sourceHash))
      throw checkpointError('repair_source_evidence_conflict');
    const evidence = (page.sourceEvidence || []).find(item => item.targetIds.includes(unitId));
    // Legacy/not-sent units have no previous provider view. Use captured page
    // source, not a new memory read or a generated answer, and record no claim
    // that it was the original request's exact evidence.
    const evidenceIds = evidence?.evidenceIds || [unitId, ...selectPageContext(
      page.units.filter(unit => unit.translatable !== false), [original]).map(unit => unit.id)];
    const key = JSON.stringify([page.pageId, evidence?.operationId || `undispatched:${unitId}`]);
    let group = groups.get(key);
    if (!group) {
      group = { targetIds: [], origin: evidence ? "initial_request" : "page_checkpoint", units: evidenceIds.map(id => {
        const unit = byId.get(id);
        if (!unit) throw checkpointError('repair_source_evidence_missing');
        return { id, text: evidence && !evidence.targetIds.includes(id) ? unit.text.trim() : unit.text };
      }), requestedIds: new Set() };
      groups.set(key, group);
    }
    group.targetIds.push(String(row.id)); group.requestedIds.add(unitId);
  }
  return [...groups.values()].map(group => ({ targetIds: group.targetIds, origin: group.origin,
    units: group.units.filter(unit => !group.requestedIds.has(unit.id)) })).filter(group => group.units.length);
}
