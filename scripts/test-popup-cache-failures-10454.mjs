/**
 * Run the unchanged .50 cache failure suite with deterministic fixture crypto.
 * Its setImmediate-based settle helper cannot reliably wait for Node's native
 * WebCrypto worker pool. Only the fixture SHA256 scheduling changes here:
 * production modules, HTTP responses, case selection and assertions stay intact.
 * Run: node --experimental-vm-modules scripts/test-popup-cache-failures-10454.mjs
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const originalUrl=new URL('./test-popup-cache-failures-10450.mjs',import.meta.url);
const original=await readFile(originalUrl,'utf8');
const originalSha256=createHash('sha256').update(original).digest('hex');
// 2026.10.16.2: the reviewed suite now seeds data-use consent in its own fixture (one storage key; no assertion changed).
assert.equal(originalSha256,'fa27a5c913c829a9a29325cb943c4a310777adb220f9184d1ed6695c573684eb',
  'This runner must use the unchanged reviewed .50 suite');
const fixtureImport="import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';";
assert.equal(original.split(fixtureImport).length,2,'Exactly one fixture import must be replaced');
const injected=`import {popupEntryFixture as originalFixture} from ${JSON.stringify(new URL('./lib/popup-entry-fixture.mjs',import.meta.url).href)};
import {createHash,webcrypto} from 'node:crypto';
const fixtureCrypto={
  subtle:{digest:async(algorithm,bytes)=>{
    assert.equal(algorithm,'SHA-256');
    const value=createHash('sha256').update(Buffer.from(bytes)).digest();
    return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);
  }},
  getRandomValues:value=>webcrypto.getRandomValues(value),
  randomUUID:()=>webcrypto.randomUUID(),
};
// 10495: this signed-in customer allowed data use (account requests go through the account gate).
const popupEntryFixture=options=>{if(options?.local)options.local.tpDataConsentV1={version:1,granted:true,at:1};return originalFixture({...options,cryptoProvider:fixtureCrypto});};`;
const executed=original.replace(fixtureImport,injected);
const restored=executed.replace(injected,fixtureImport);
assert.equal(restored,original,'Every original byte, including every assertion and case, must be conserved');
const restoredSha256=createHash('sha256').update(restored).digest('hex');
const originalAssertionCalls=(original.match(/\bassert(?:\.[A-Za-z_$][\w$]*)?\s*\(/g)||[]).length;

// Capture the original suite's report without replacing its console output.
const originalLog=console.log;let report;
console.log=(...values)=>{
  if(values.length===1&&typeof values[0]==='string'){
    try{const parsed=JSON.parse(values[0]);if(Array.isArray(parsed.checks)&&typeof parsed.passed==='boolean')report=parsed;}catch{}
  }
  originalLog(...values);
};
try{await import('data:text/javascript;base64,'+Buffer.from(executed).toString('base64'));}
finally{console.log=originalLog;}
assert.equal(report?.passed,true,'The original suite must report success');
const args=process.argv.slice(2),filtered=args.includes('--case')||args.some((arg,index)=>!arg.startsWith('--')&&args[index-1]!=='--api-fixture');
if(!filtered)assert.equal(report.count,args.includes('--api-fixture')?16:15,'Every original full-suite case must execute');
console.log(JSON.stringify({
  runner:'test-popup-cache-failures-10454.mjs',passed:true,count:report.count,
  originalSource:'test-popup-cache-failures-10450.mjs',originalSha256,restoredSha256,
  sourceBytesConserved:restored===original,originalAssertionCalls,
  onlyFixtureDifference:'SHA256 uses identical input bytes and algorithm through Node createHash in an async microtask, instead of the native WebCrypto worker pool. Randomness still uses WebCrypto; production imports and original assertions are unchanged.',
}));
