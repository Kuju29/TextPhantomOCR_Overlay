import { repairSourceContext } from './source-evidence.js';
import { checkedOrigins } from '../../shared/ai/conversation/origins.js';

const conflict = message => Object.assign(new Error(message), {
  code:'repair_source_evidence_conflict', stage:'conversation_mapping',
  requestDispatched:false, providerAttempts:0, generationAttempts:0, retryable:false,
});

// Durable R aliases identify pool receipts. Provider I IDs must identify the
// original translatable unit in its immutable page reservation, not pool order.
export function orderRepairUnits(pages, units) {
  const keys = new Map();
  for (const [id, page] of pages) {
    const descriptor = page?.ai?.conversation || {};
    const pageIndex = descriptor.pageIndex;
    const order = Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : descriptor.pageOrder;
    keys.set(id, {order:Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
      units:new Map((page?.units || []).filter(unit=>unit.translatable!==false).map((unit,i)=>[String(unit.id),i]))});
  }
  return units.map((row,index)=>({row,index,key:keys.get(row.pageId)})).sort((a,b)=>
    (a.key?.order??Number.MAX_SAFE_INTEGER)-(b.key?.order??Number.MAX_SAFE_INTEGER) ||
    (a.row.pageId===b.row.pageId ? (a.key?.units.get(String(a.row.unitId||a.row.id))??Number.MAX_SAFE_INTEGER)-
      (b.key?.units.get(String(b.row.unitId||b.row.id))??Number.MAX_SAFE_INTEGER) : 0) || a.index-b.index
  ).map(item=>item.row);
}

export function prepareConversationRepairWire(pages, units, conversationRepair) {
  if (!conversationRepair) return {taskUnits:[...units],
    wireUnits:units.map(row => ({id:String(row.id),text:row.text})), origins:[],
    sourceContext:repairSourceContext(pages, units), wireToAlias:new Map()};
  const pageGroups = new Map(), seenAliases = new Set(), seenWireIds = new Set();
  for (const row of orderRepairUnits(pages, units)) {
    const page = pages.get(row.pageId), descriptor = page?.ai?.conversation;
    const originals = (page?.units || []).filter(unit => unit.translatable !== false);
    const unitIndex = originals.findIndex(unit => String(unit.id) === String(row.unitId || row.id));
    const original = originals[unitIndex];
    if (!page || descriptor?.pageId !== page.pageId ||
        !Number.isSafeInteger(descriptor.pageOrder) || descriptor.pageOrder < 1 ||
        !original || original.text !== row.text || original.sourceHash !== row.sourceHash ||
        page.generationId !== row.generationId)
      throw conflict('Repair source identity does not match its checkpoint');
    const alias = String(row.id), wireId = `I${descriptor.pageOrder}_P${unitIndex}`;
    if (seenAliases.has(alias) || seenWireIds.has(wireId))
      throw conflict('Repair source identities are not unique');
    seenAliases.add(alias); seenWireIds.add(wireId);
    if (!pageGroups.has(page.pageId)) pageGroups.set(page.pageId, {page,rows:[]});
    pageGroups.get(page.pageId).rows.push({row,alias,wireId});
  }
  const ordered = [...pageGroups.values()].flatMap(group => group.rows);
  const aliasToWire = new Map(ordered.map(item => [item.alias,item.wireId]));
  const wireToAlias = new Map(ordered.map(item => [item.wireId,item.alias]));
  const taskUnits = ordered.map(item => item.row);
  const wireUnits = ordered.map(item => ({id:item.wireId,text:item.row.text}));
  const origins = checkedOrigins([...pageGroups.values()].map(({page,rows}) => ({
    pageId:page.pageId, pageOrder:page.ai.conversation.pageOrder,
    ...(Number.isInteger(page.ai.conversation.pageIndex) ? {pageIndex:page.ai.conversation.pageIndex} : {}),
    unitIds:rows.map(item => item.wireId), originalIds:rows.map(item => item.alias), sourceFingerprint:'',
  })), wireUnits.map(unit => unit.id));
  const sourceContext = repairSourceContext(pages, taskUnits).map(group => ({...group,
    targetIds:group.targetIds.map(id => aliasToWire.get(String(id))).filter(Boolean),
  })).filter(group => group.targetIds.length && group.units.length);
  return {taskUnits,wireUnits,origins,sourceContext,wireToAlias};
}
