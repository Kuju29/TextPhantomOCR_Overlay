import assert from 'node:assert/strict';
import {createStreamRecords} from '../src/background/ai/translation-paths/stream-records.js';
import {readAiStream} from '../src/background/ai/transports/server.js';
let checks=0;
const units=[{id:'I1_P0',text:'Hello'},{id:'I2_P0',text:'World'}];
const text='<<I1_P0:สวัสดี>><<I2_P0:โลก>>';
for(let split=0;split<=text.length;split++){
 const parser=createStreamRecords(units);parser.push(text.slice(0,split));parser.push(text.slice(split));
 assert.deepEqual([...parser.accepted],[['I1_P0','สวัสดี'],['I2_P0','โลก']]);checks++;
}
{
 const p=createStreamRecords(units);for(const ch of text)p.push(ch);
 assert.equal(p.accepted.size,2);checks++;
}
for(const bad of ['<<I1_P0:>>','<<I1_P0:hello','<<I1_P0:bad <<I2_P0:nested>>>>']){
 const p=createStreamRecords(units);p.push(bad);assert.equal(p.accepted.size,0);checks++;
}
{
 const p=createStreamRecords(units);p.push('<<I1_P0:สวัสดี>>');assert.equal(p.accepted.size,1);
 p.push('<<I1_P0:เปลี่ยนคำ>>');assert.equal(p.accepted.size,0);assert.ok(p.invalid.has('I1_P0'));checks++;
}
{
 const p=createStreamRecords(units);p.push('<<I1_P0:ดี>><<I2_P0:อีกภาพ>><<I1_P0:เปลี่ยนไม่จบ');
 p.finish();assert.equal(p.accepted.has('I1_P0'),false);assert.equal(p.accepted.get('I2_P0'),'อีกภาพ');assert.ok(p.invalid.has('I1_P0'));checks++;
}
const encoder=new TextEncoder();
const response=rows=>new Response(new ReadableStream({start(c){for(const row of rows)c.enqueue(encoder.encode(row));c.close();}}));
const row=(sequence,type,rest)=>JSON.stringify({schema:'tp.ai.stream/1',sequence,type,...rest})+'\n';
{
 const deltas=[];const result=await readAiStream(response([row(1,'delta',{text:'<<I1_P0:สวัสดี>>'}),row(2,'result',{body:{usage:{inputTokens:50},translations:[]}})]),x=>deltas.push(x));
 assert.equal(deltas.length,1);assert.equal(result.body.usage.inputTokens,50);checks++;
}
for(const lines of [[row(2,'delta',{text:'bad sequence'})],[row(1,'delta',{text:'partial only'})],['not json\n'],[row(1,'error',{status:200,body:{}})]]){
 await assert.rejects(readAiStream(response(lines)),{code:'invalid_ai_stream'});checks++;
}
{
 const result=await readAiStream(response([row(1,'delta',{text:'valid first'}),row(2,'error',{status:502,body:{detail:{code:'upstream_incomplete'}}})]));
 assert.equal(result.status,502);assert.equal(result.body.detail.code,'upstream_incomplete');checks++;
}
console.log(`PASS ${checks} independent stream parser/envelope checks`);
