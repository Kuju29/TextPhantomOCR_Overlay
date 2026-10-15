// The optional story summary is metadata, never a translation record.
import { normalizeLanguageCode } from "../../generated/language-code-aliases.js";
import { assertNoDuplicateJsonKeys } from "./direct-local/decode.js";

const SERIES_SUMMARY_LIMIT = 800;

export function seriesSummaryInstruction(lang, structured = false) {
  const code = normalizeLanguageCode(lang);
  const location = structured ? '"TP_MEMO"' : '<<TP_MEMO:...>>';
  if (code === "th") return `ความจำเรื่อง (TP_MEMO) — หลังคำแปลครบแล้ว ให้จดบันทึกจากข้อความในคำขอนี้ให้คำขอต่อไปเข้าใจเรื่อง: ตัวละครที่ปรากฏ ใช้ชื่อตามที่ข้อความระบุ ถ้าไม่มีชื่อให้เขียน "ไม่ทราบชื่อ" พร้อมลักษณะสั้น ๆ ห้ามเดาชื่อ บอกบทบาทหรือความสัมพันธ์ บุคลิกหรือน้ำเสียงการพูด และระบุเพศเฉพาะเมื่อข้อความบอกชัด ถ้าไม่ชัดไม่ต้องใส่ ตามด้วยเหตุการณ์สำคัญ จะมีหลายตัวละครหลายเหตุการณ์ก็ได้ เลือกเองว่าอะไรสำคัญ เขียนเป็นภาษาไทยบรรทัดเดียว คั่นแต่ละเรื่องด้วย " · " ไม่เกิน 800 ตัวอักษร ห้ามแต่งข้อมูลที่ข้อความไม่ได้บอก ใช้บริบทเดิมช่วยเข้าใจได้แต่ไม่จดตัวอย่างหรือเนื้อหาตอนก่อนซ้ำ ใส่ครั้งเดียวที่ท้ายคำตอบใน ${location}${structured ? " ซึ่งเป็นคีย์ string สุดท้ายใน JSON ที่กำหนด" : " แยกจาก marker คำแปล"} บันทึกนี้เป็นข้อยกเว้นเดียวของกฎที่ให้ตอบเฉพาะคำแปล ห้ามใส่ ID คำแปลหรือเครื่องหมาย << และ >> ลงในบันทึก`;
  if (code === "ja") return `物語の記憶（TP_MEMO）— 全訳文の後に、今回の文章から次の依頼が物語を理解できるよう記録する：登場人物（文中の名前どおり。名前が無ければ「名前不明」と短い特徴、名前を推測しない）、役割や関係、性格や話し方、性別は文中で明確な場合のみ。続けて重要な出来事。人物や出来事は複数でよく、何が重要かは自分で選ぶ。日本語の1行、項目は「 · 」で区切り、800文字以内。文中に無い事実を作らない。以前の文脈は理解の補助とし、例文や前章を再記録しない。回答末尾の ${location}${structured ? "（指定JSON内の最後のstringキー）" : "（訳文markerとは別）"} に一度だけ入れる。これは訳文だけを返す規則の唯一の例外。記録に翻訳IDや <<、>> を入れない。`;
  return `SERIES MEMORY (TP_MEMO) — After all translations, write notes from this request's source so later requests understand the story: the characters who appear (use the name as written; if unnamed write "unknown name" with a short descriptor, never guess a name), their role or relationship, personality or speech style, and gender only when the text states it clearly (otherwise omit it), then the key events. Several characters and events are fine; choose what matters. One line in the selected target language, items separated by " · ", at most 800 characters. Do not invent facts. Use prior context for understanding but do not re-record examples or earlier chapters. Put the notes exactly once at the end of the response in ${location}${structured ? " as the final string property in the supplied JSON object" : ", separate from translation markers"}. These notes are the only exception to the translation-only rule. Do not put translation IDs or << / >> delimiters inside them.`;
}

export function withSeriesSummarySchema(schema) {
  if (!schema) return schema;
  return { ...schema,
    properties: { ...schema.properties, TP_MEMO: { type: "string", maxLength: SERIES_SUMMARY_LIMIT } },
    required: [...(schema.required || []), "TP_MEMO"],
  };
}

function validSummary(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    [...value.trim()].length <= SERIES_SUMMARY_LIMIT && !/[\r\n\u2028\u2029]/u.test(value) &&
    !value.includes("<<") && !value.includes(">>");
}
function splitNative(text) {
  try {
    const source=text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u,"$1");
    const parsed=JSON.parse(source);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return {text,summary:"",status:"invalid"};
    const ws=i=>{while(i<source.length&&/[ \t\r\n]/u.test(source[i]))i++;return i;};
    const stringEnd=start=>{let i=start+1;while(i<source.length){if(source[i]==="\\"){i+=2;continue;}if(source[i]==='"')return i+1;i++;}throw Error("string");};
    const valueEnd=start=>{let i=start,depth=0;while(i<source.length){const c=source[i];if(c==='"'){i=stringEnd(i);continue;}if(c==='['||c==='{')depth++;else if(c===']'||c==='}'){if(depth===0)return i;depth--;}else if(c===','&&depth===0)return i;i++;}throw Error("object");};
    let i=ws(0)+1;const retained=[],memos=[];
    while(true){i=ws(i);if(source[i]==='}')break;const begin=i,endKey=stringEnd(i),key=JSON.parse(source.slice(i,endKey));i=ws(endKey);if(source[i++]!==':')throw Error("colon");i=ws(i);const end=valueEnd(i);if(key==='TP_MEMO')memos.push(JSON.parse(source.slice(i,end)));else retained.push(source.slice(begin,end));i=ws(end);if(source[i]===','){i++;continue;}if(source[i]==='}')break;throw Error("boundary");}
    if(!memos.length)return {text,summary:"",status:"missing"};
    const clean='{'+retained.join(',')+'}';
    // Validate duplicates after removing only reserved metadata members.
    assertNoDuplicateJsonKeys(clean);
    const accepted=memos.length===1&&validSummary(memos[0]);
    return {text:clean,summary:accepted?memos[0].trim():"",status:accepted?"accepted":"invalid"};
  } catch {return {text,summary:"",status:"invalid"};}
}
export function splitSeriesSummary(raw,{enabled=false,nativeSchema=false}={}) {
  const text=String(raw||"");if(!enabled)return {text,summary:"",status:"disabled"};
  if(nativeSchema)return splitNative(text);
  const opening=/<<TP_MEMO(?=[:\s>]|$)/gu;
  let match,cursor=0,clean="",memos=[];
  while((match=opening.exec(text))){const begin=match.index;if(begin<cursor)continue;clean+=text.slice(cursor,begin);clean=clean.replace(/\r?\n$/u, "");let pos=begin+2,nested=[],closed=false;
    while(pos<text.length){const nextOpen=text.indexOf('<<',pos),nextClose=text.indexOf('>>',pos);
      if(nextClose<0){pos=text.length;break;}
      if(nextOpen>=0&&nextOpen<nextClose){const childEnd=text.indexOf('>>',nextOpen+2);if(childEnd<0){nested.push(text.slice(nextOpen));pos=text.length;break;}nested.push(text.slice(nextOpen,childEnd+2));pos=childEnd+2;continue;}
      pos=nextClose+2;closed=true;break;
    }
    const owned=text.slice(begin,pos),valid=/^<<TP_MEMO:([^<>]*?)>>$/u.exec(owned);
    if(nested.length && clean && !/\s$/u.test(clean)) clean+='\n';
    clean+=nested.join('\n');memos.push({value:valid?.[1],end:pos,closed,nested:nested.length});cursor=pos;opening.lastIndex=pos;
  }
  if(!memos.length)return {text,summary:"",status:"missing"};clean+=text.slice(cursor);
  const row=memos[0],accepted=memos.length===1&&row.closed&&!row.nested&&validSummary(row.value)&&!text.slice(row.end).trim();
  return {text:clean.replace(/\r?\n$/u,""),summary:accepted?row.value.trim():"",status:accepted?"accepted":"invalid"};
}
