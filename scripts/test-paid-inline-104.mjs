import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {accountScope,validNavigation} from '../src/paid/inline.js';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const checks=[];
async function check(name,fn){await fn();checks.push({name,passed:true});}
await check('Navigation is bound to both API and session, without storing token',async()=>{
 const a=await accountScope('https://a.example','session-1'), b=await accountScope('https://b.example','session-1'), c=await accountScope('https://a.example','session-2');
 assert.match(a,/^[a-f0-9]{64}$/);assert.notEqual(a,b);assert.notEqual(a,c);
 const value={version:1,scope:a,tab:'orders',updatedAt:100};assert(validNavigation(value,a,200));assert(!validNavigation(value,b,200));assert(!validNavigation(value,c,200));
});
await check('Expired, malformed and future navigation never restores',()=>{
 const v={version:1,scope:'scope',tab:'buy',updatedAt:100000};
 assert(!validNavigation(v,'scope',100000+86400001));assert(!validNavigation({...v,tab:'/api/admin'},'scope',100001));
 assert(!validNavigation({...v,updatedAt:'100000'},'scope',100001));assert(!validNavigation({...v,updatedAt:999999999},'scope',100001));
});
await check('Package selection and payment restore as distinct views',()=>{
 for(const tab of ['home','buy','payment','orders','details','usage'])assert(validNavigation({version:1,scope:'s',tab,updatedAt:10},'s',20));
});
await check('Inline account navigation stays local; only validated Checkout uses a new tab',async()=>{
 const source=await readFile(new URL('../src/paid/inline.js',import.meta.url),'utf8');
 assert(!/window\.open|tabs\.create/.test(source));assert(source.includes('createCheckoutLauncher'));assert(source.includes('open: (url) => createTab({ url })'));assert(!source.includes('createTab({ url:'));assert(!source.includes('/api/admin/'));
 assert(source.includes('await persist();'));assert(source.indexOf('await persist();')<source.search(/await client\.request\(['"]\/paid\/orders['"]/));
 assert(source.includes('client.invalidate()'));assert(/expected\s*!==\s*epoch/.test(source));
 assert(source.includes('activeOrder'));assert(!source.includes("action==='submit'"));
});
console.log(JSON.stringify({scope:'Navigation contract and source invariants. Actual DOM and mutation workflows tested separately.',checks,passed:true},null,2));
