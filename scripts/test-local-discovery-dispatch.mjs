/** Execute the exact dispatch block, with network/IPC endpoints simulated. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/background/index.js',import.meta.url),'utf8');
const start=source.indexOf('case "TP_LOCAL_AI_DISCOVER": {')+'case "TP_LOCAL_AI_DISCOVER": {'.length;
const end=source.indexOf('\n    case "TP_LOCAL_AI_DISCOVERY_UI":',start);
const block=source.slice(start,end).trim().replace(/\}\s*$/,'');
const handle=new Function('msg','sender','sendResponse','trustedUi','ensureTraceHandshake','localDiscovery','flushTrace',block);
const never=()=>new Promise(()=>{});let calls=0,replies=[];
const service={run:async()=>{calls++;return {ok:true,discoveryId:'fixture'};}};
assert.equal(handle({apiBase:'http://fixture'}, {}, x=>replies.push(x),()=>true,never,service,never),true);
await new Promise(r=>setTimeout(r,0));
assert.equal(calls,1);assert.equal(replies[0].ok,true,'trace handshake/flush cannot block the Local result');
const rejected=[];handle({}, {}, x=>rejected.push(x),()=>false,never,service,never);
assert.equal(calls,1);assert.equal(rejected[0].code,'trusted_ui_only');
let unhandled=0;const onUnhandled=()=>unhandled++;process.on('unhandledRejection',onUnhandled);
handle({}, {}, ()=>{throw Error('popup closed');},()=>true,never,service,never);
await new Promise(r=>setTimeout(r,5));process.off('unhandledRejection',onUnhandled);assert.equal(unhandled,0);
console.log('PASS exact Local dispatch: hung trace sink does not block reply; content caller denied; closed popup does not cause unhandled rejection.');
