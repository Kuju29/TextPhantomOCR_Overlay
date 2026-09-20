// Original source IDs and current-request wire IDs are different namespaces.
const CONVERSATION_ID=/^I([1-9][0-9]{0,6})_P([0-9]{1,6})$/;
const LEGACY_WIRE_ID=/^P[0-9]{1,6}$/;
const originalId = value => typeof value === 'string' && Array.from(value).length > 0 &&
  Array.from(value).length <= 160 && value === value.trim() && !/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(value);
function invalid(field, reason) {
  throw Object.assign(new Error('Conversation source mapping is invalid'), {
    code: 'ai_conversation_origin_invalid', stage: 'conversation_mapping', origin: 'client',
    category: 'input', retryable: false, providerAttempts: 0, generationAttempts: 0,
    requestDispatched: false, validation: {field, reason},
  });
}
export function checkedOrigins(value, sourceIds = null) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 128) invalid('conversation.origins','invalid_page_list');
  const seen = new Set(), pages = new Set();
  const rows = value.map((item,index) => {
    const field = `conversation.origins.${index}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid(field,'invalid_page_origin');
    const ids = item.unitIds, originals = item.originalIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 2000 || !Array.isArray(originals) || ids.length !== originals.length)
      invalid(field,'incomplete_mapping');
    for (const [i,id] of ids.entries()) {
      if (typeof id !== 'string' || !(CONVERSATION_ID.test(id)||LEGACY_WIRE_ID.test(id))) invalid(`${field}.unitIds.${i}`,'invalid_wire_id');
      const match=CONVERSATION_ID.exec(id);
      if(match&&Number.isInteger(item.pageOrder)&&Number(match[1])!==item.pageOrder) invalid(`${field}.unitIds.${i}`,'image_id_mismatch');
      if (seen.has(id)) invalid(`${field}.unitIds.${i}`,'duplicate_wire_id');
      seen.add(id);
    }
    const local = new Set();
    for (const [i,id] of originals.entries()) {
      if (!originalId(id)) invalid(`${field}.originalIds.${i}`,'invalid_source_id');
      if (local.has(id)) invalid(`${field}.originalIds.${i}`,'duplicate_source_id');
      local.add(id);
    }
    if (seen.size > 2000) invalid('conversation.origins','too_many_wire_ids');
    if (!originalId(item.pageId)) invalid(`${field}.pageId`,'invalid_page_id');
    if (pages.has(item.pageId)) invalid(`${field}.pageId`,'duplicate_page_id');
    pages.add(item.pageId);
    const fingerprint = Object.prototype.hasOwnProperty.call(item, 'sourceFingerprint') ? item.sourceFingerprint : '';
    if (typeof fingerprint !== 'string' || fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint)) invalid(`${field}.sourceFingerprint`,'invalid_fingerprint');
    const row = {pageId:item.pageId,unitIds:[...ids],originalIds:[...originals],sourceFingerprint:fingerprint};
    for(const key of ['pageIndex','pageOrder']) if(Number.isInteger(item[key]) && item[key]>=0 && item[key]<10000000) row[key]=item[key];
    return row;
  });
  if (rows.length && sourceIds && (seen.size !== sourceIds.length || rows.flatMap(p=>p.unitIds).some((id,i)=>id!==sourceIds[i])))
    invalid('conversation.origins','source_order_mismatch');
  return rows;
}

// Page ownership only. Old assistant strings must stay byte-identical.
const key=p=>p.pageIndex!=null?`index:${p.pageIndex}`:`id:${p.pageId}`;
export function branchHistory(history,origins,orderPolicy="request_arrival") {
  for(let i=0;i<history.length;i++)for(const old of history[i].pages||[])for(const fresh of origins){
    if(key(old)===key(fresh)){
      const changed=old.sourceFingerprint&&fresh.sourceFingerprint&&old.sourceFingerprint!==fresh.sourceFingerprint;
      if(changed||old.originalIds?.some(id=>fresh.originalIds?.includes(id)))return {turns:history.slice(0,i),reason:changed?'source_changed':'source_replayed'};
    }else if(orderPolicy==='document_enqueue'&&old.pageIndex!=null&&fresh.pageIndex!=null&&old.pageIndex>fresh.pageIndex)return {turns:history.slice(0,i),reason:'source_order_rewound'};
  }
  return {turns:history,reason:'none'};
}
export function pageBoundaries(origins,locale){
  // I<image>_P<unit> carries page ownership in the record ID itself. Normal
  // Conversation continuations therefore need no repeated page/speaker prose.
  if(origins.every(p=>(p.unitIds||[]).every(id=>CONVERSATION_ID.test(id)))) return '';
  if(origins.length<2)return '';
  const title={th:'ขอบเขตภาพ — ID แต่ละกลุ่มเป็นคนละภาพ ไม่ได้ระบุผู้พูด',ja:'ページ境界 — IDの組は別の画像です。話者を表しません。'}[locale]||'Page boundaries — each ID group belongs to a separate image, not a speaker';
  return title+'\n'+origins.map((p,i)=>`${i+1}: ${p.unitIds.join(', ')}`).join('\n')+'\n\n';
}
