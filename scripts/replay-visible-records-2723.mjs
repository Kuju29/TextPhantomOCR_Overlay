// Replay already-assembled visible text, not redacted provider transport frames.
// Run: node scripts/replay-visible-records-2723.mjs LOGS/ai-wire OUT.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {decodeTranslations} from '../src/shared/ai/direct-local/decode.js';
import {createStreamRecords} from '../src/background/ai/translation-paths/stream-records.js';
const [root,out]=process.argv.slice(2);if(!root||!out)throw Error('Usage: replay-visible-records-2723.mjs ai-wire-directory output.json');
const read=(dir,name,fallback=null)=>{try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch{return fallback;}};
const rows=[];
for(const name of fs.readdirSync(root).sort()){
 const dir=path.join(root,name);if(!fs.statSync(dir).isDirectory())continue;
 const identity=read(dir,'00_identity.json',{});if(identity.recordKind!=='provider_request')continue;
 const rawPath=path.join(dir,'05_provider_response.assembled.txt');if(!fs.existsSync(rawPath))continue;
 const raw=fs.readFileSync(rawPath,'utf8');if(!raw.trim())continue;
 const units=read(dir,'01_units.json',[]),w=read(dir,'03_wire_units.json',units),wire=Array.isArray(w)?w:(w.units||units);
 const body=read(dir,'04_provider_request.json',{}).body||{};
 const structured=body.format?.type==='object'||body.response_format?.type==='json_schema';
 let decoded;try{decoded=decodeTranslations(raw,units,{compactMarkers:!structured,structured,wireUnits:wire});}catch(e){decoded={translations:e.partialTranslations||[],diagnostics:e.diagnostics||{},error:e.code};}
 const translations=decoded.translations.filter(t=>t.text?.trim()),byId=new Map(translations.map(t=>[t.id,t.text]));
 const applied=read(dir,'08_apply_result.json',{}).translations;
 const parsed=read(dir,'06_parsed_records.json',[]);
 const logged=Array.isArray(applied)?applied:Array.isArray(parsed)?parsed:[];
 const mismatches=logged.filter(t=>t.text?.trim()&&byId.get(t.id)?.trim()!==t.text.trim()).map(t=>({id:t.id,replayPresent:byId.has(t.id)}));
 const chunks=[];
 for(const width of structured?[]:[1,17,1024]){
  const stream=createStreamRecords(wire);for(let i=0;i<raw.length;i+=width)stream.push(raw.slice(i,i+width));stream.finish();
  const actual=new Map([...stream.accepted].map(([id,text])=>[units[wire.findIndex(w=>w.id===id)]?.id||id,text]));
  const different=[...byId].filter(([id,text])=>actual.get(id)!==text).map(([id])=>id);
  const extra=[...actual].filter(([id,text])=>byId.get(id)!==text).map(([id])=>id);
  chunks.push({width,accepted:actual.size,differentIds:different,extraIds:extra});
 }
 rows.push({directory:name,provider:identity.provider,model:identity.model,attemptKind:identity.attemptKind,contract:structured?'native_schema_object':'compact_markers',sha256:crypto.createHash('sha256').update(raw).digest('hex'),requested:units.length,replayed:translations.length,outerWhitespaceNormalizations:logged.filter(t=>t.text?.trim()&&byId.get(t.id)!==t.text&&byId.get(t.id)?.trim()===t.text.trim()).length,loggedAccepted:logged.filter(t=>t.text?.trim()).length,loggedTextMismatches:mismatches,missingIds:units.filter(u=>!byId.has(u.id)).map(u=>u.id),chunks});
}
const result={scope:'Production terminal decoder (including requested native schemas) and streaming marker reader versus already-assembled visible provider text and logged accepted records; comparison permits outer whitespace trimming only. Native JSON schemas are finalized as objects, not scanned as marker streams. No live generation, hidden reasoning, transport-frame recreation, semantic-quality approval, or actual DOM placement replay.',requests:rows.length,requestedUnits:rows.reduce((n,r)=>n+r.requested,0),replayedUnits:rows.reduce((n,r)=>n+r.replayed,0),mismatches:rows.reduce((n,r)=>n+r.loggedTextMismatches.length+r.chunks.reduce((a,c)=>a+c.differentIds.length+c.extraIds.length,0),0),rows};
fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,rows:undefined},null,2));
if(result.mismatches)process.exitCode=1;
