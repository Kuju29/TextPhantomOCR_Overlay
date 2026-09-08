// One presentation vocabulary for the existing batch/repair state; no job state here.
(function(root){
 const phases=new Set(['waiting','scanning','downloading','lens','grouping','ai_queued','ai_generating','server_processing','usage_pending','http_wait','validating','rendering','repair_wait','repairing','repair_applying','apply_pending','apply_failed','done','partial','error','cancelled']);
 const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
 const numbers=['total','accepted','applied','pending','fallbackCount','wrongLanguageCount','structuralCount','batchIndex','unitCount'];
 function normalize(raw={}) {
   const out={phase:phases.has(raw.phase)?raw.phase:'waiting'};
   for(const k of numbers)out[k]=count(raw[k]);
   for(const k of ['provider','model']) {
     const value=String(raw[k] || '');
     out[k]=/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,119}$/.test(value) && !/^(sk-|Bearer)/i.test(value) ? value : '';
   }
   out.contract=['json_schema_object_v1','compact_markers_v1','plain_records_v1','unconfirmed'].includes(raw.contract)?raw.contract:'unconfirmed';
   return out;
 }
 const words={
  th:{waiting:'รอเริ่มงาน',scanning:'กำลังเตรียมภาพ',downloading:'กำลังโหลดภาพ',lens:'กำลังอ่านข้อความในภาพ',grouping:'กำลังจัดกลุ่มข้อความ',ai_queued:'รอช่องงาน AI · ยังไม่ส่งคำขอ',ai_generating:'AI กำลังประมวลผล',server_processing:'กำลังประมวลผลที่เซิร์ฟเวอร์',usage_pending:'กำลังบันทึกสถานะคำขอ · ยังไม่ส่ง AI',http_wait:'ส่งคำขอแล้ว · รอเซิร์ฟเวอร์',validating:'ได้รับคำตอบแล้ว · กำลังตรวจสอบ',rendering:'กำลังแทรกข้อความ',repair_wait:'รอภาพอื่นจบรอบแรกก่อนซ่อม',repairing:'อยู่ในรอบซ่อม',repair_applying:'กำลังแทรกผลซ่อม',apply_pending:'คำแปลพร้อมแล้ว · ยังยืนยันการวางไม่ได้',apply_failed:'วางบางส่วนไม่ได้อย่างปลอดภัย · เก็บผลไว้',done:'จบงาน',partial:'จบงาน · ยังมีส่วนที่ไม่ผ่าน',error:'ภาพนี้ทำงานไม่สำเร็จ · ดูรายละเอียดข้อผิดพลาด',cancelled:'ยกเลิกแล้ว'},
  en:{waiting:'Waiting to start',scanning:'Preparing image',downloading:'Loading image',lens:'Reading image text',grouping:'Grouping text',ai_queued:'Waiting for AI capacity · not sent',ai_generating:'AI processing',server_processing:'Processing on server',usage_pending:'Saving request state · not sent to AI',http_wait:'Request sent · waiting for server',validating:'Response received · validating',rendering:'Placing text',repair_wait:'Waiting for initial image pass before repair',repairing:'In repair pass',repair_applying:'Placing repair results',apply_pending:'Translation ready · placement not confirmed',apply_failed:'Some results cannot be safely placed · saved',done:'Finished',partial:'Finished · unresolved text remains',error:'Image processing failed · see error details',cancelled:'Cancelled'}
 };
 function label(raw,language='en'){
   const s=normalize(raw),th=String(language).toLowerCase().startsWith('th'),w=th?words.th:words.en;
   let text=w[s.phase];
   if(s.applied!==null&&s.total!==null)text+=th?` · แทรกแล้ว ${s.applied}/${s.total} ส่วน`:` · placed ${s.applied}/${s.total} units`;
   if(s.pending>0 && ['repair_wait','repairing','repair_applying','partial'].includes(s.phase))text+=th?` · เหลือ ${s.pending} ส่วน`:` · ${s.pending} remaining`;
   if(s.unitCount!==null&&['ai_generating','http_wait','validating'].includes(s.phase))text+=th?` · ชุด ${s.batchIndex||1} (${s.unitCount} ส่วน)`:` · batch ${s.batchIndex||1} (${s.unitCount} units)`;
   if(s.phase==='partial'&&s.wrongLanguageCount>0)text+=th?` · ผิดภาษา ${s.wrongLanguageCount} ส่วน`:` · wrong language: ${s.wrongLanguageCount}`;
   if(s.phase==='partial'&&s.structuralCount>0)text+=th?` · รูปแบบไม่ครบ ${s.structuralCount} ส่วน`:` · invalid output: ${s.structuralCount}`;
   return text;
 }
 root.TPImageStatusView=Object.freeze({normalize,label});
})(globalThis);
