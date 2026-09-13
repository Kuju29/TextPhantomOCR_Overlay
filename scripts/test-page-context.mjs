import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { selectPageContext, normalizePageContext, pageContextText } from '../src/shared/ai/page-context.js';
const page=Array.from({length:12},(_,index)=>({id:`original_${index}`,text:`line ${index}`}));
assert.deepEqual(selectPageContext(page,page),[]);
assert.deepEqual(selectPageContext(page,[page[6]]).map(unit=>unit.id),[3,4,5,7,8,9].map(index=>page[index].id));
const entries=[{id:'target',text:'do not repeat'},null,{id:'n1',text:'😀'.repeat(1999)},{id:'n1',text:'duplicate'},{id:'n2',text:'ab'},{id:'n3',text:'!'}];
const normalized=normalizePageContext(entries,[{id:'target'}]);
assert.deepEqual(normalized.map(unit=>unit.id),['n1','n3']);
const py=spawnSync('python3',['-c',`
import json,sys
sys.path.insert(0,'api')
from backend.ai.prompts.context import normalize_page_context,build_page_context_block
from backend.application.ai_request import request_fingerprint
raw=json.load(sys.stdin)
a={'units':[{'id':'target','text':'source'}], 'pageContext':[{'id':'n','text':'before'}]}
b={**a,'pageContext':[{'id':'n','text':'after'}]}
assert request_fingerprint(a)!=request_fingerprint(b)
items=normalize_page_context(raw,[{'id':'target'}])
print(json.dumps({'items':items,'block':build_page_context_block(items)},ensure_ascii=False))
`],{input:JSON.stringify(entries),encoding:'utf8'});
assert.equal(py.status,0,py.stderr);
const result=JSON.parse(py.stdout);
assert.deepEqual(result.items,normalized);
assert.equal(result.block,pageContextText(normalized));
console.log('PASS same-page context: bounded complete Unicode units, nearest neighbors, target exclusion, Python/JS parity and idempotency separation.');
