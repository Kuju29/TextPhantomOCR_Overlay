import assert from 'node:assert/strict';
import {isActionPopup} from '../src/popup/controllers/paid-service-controller.js';
const page={},other={},checks=[];
const check=(name,fn)=>{fn();checks.push({name,passed:true});};
check('Native Chrome action view is detected even at a collapsed viewport',()=>{
 let query;assert(isActionPopup({page,protocol:'chrome-extension:',extension:{getViews:value=>{query=value;return [page];}}}));assert.deepEqual(query,{type:'popup'});
});
check('An extension page in a browser tab keeps responsive page layout',()=>{
 assert(!isActionPopup({page,protocol:'chrome-extension:',extension:{getViews:()=>[other]}}));
});
check('Firefox action view uses the same explicit view identity',()=>{
 assert(isActionPopup({page,protocol:'moz-extension:',extension:{getViews:()=>[page]}}));
});
check('Web previews never request native popup width',()=>{
 for(const protocol of ['http:','https:','file:'])assert(!isActionPopup({page,protocol,extension:{}}));
});
check('Extension runtimes without view lookup retain a deterministic action width request',()=>{
 for(const protocol of ['chrome-extension:','moz-extension:'])assert(isActionPopup({page,protocol,extension:{}}));
});
check('Unavailable view lookup falls back without preventing account navigation',()=>{
 assert(isActionPopup({page,protocol:'chrome-extension:',extension:{getViews:()=>{throw new Error('Unsupported');}}}));
});
console.log(JSON.stringify({scope:'Production action/page surface detection using explicit browser view identity; not a native browser host sizing test.',checks,total:checks.length,passed:true},null,2));
