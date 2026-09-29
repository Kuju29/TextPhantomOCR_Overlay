import assert from 'node:assert/strict';
import {readDownloadImage,cancelDownloadRead,cancelTabDownloadReads} from '../src/background/download-images.js';
globalThis.chrome={runtime:{id:'extension-fixture'}};
const a={id:'extension-fixture',tab:{id:1},frameId:0,documentId:'doc-A',url:'https://reader.invalid/one'};
const b={...a,tab:{id:2},documentId:'doc-B'};
let count=0;const checks=[];function ck(name,ok){assert.ok(ok,name);checks.push(name);}
const message={requestId:'request-one',url:'https://images.invalid/page.jpg'};
globalThis.fetch=async()=>{count++;return new Response(new Uint8Array([1,2,3,4]),{headers:{'content-type':'image/jpeg'}});};
ck('untrusted sender refused',!(await readDownloadImage(message,{...a,id:'other'})).ok);
ck('non-image URL schemes refused',!(await readDownloadImage({...message,url:'file:///secret'},a)).ok);
ck('URL userinfo refused',!(await readDownloadImage({...message,url:'https://user:pass@image.invalid/p'},a)).ok);
ck('rejections perform no fetch',count===0);
const single=await readDownloadImage(message,a);ck('image bytes and MIME preserved',single.dataUri==='data:image/jpeg;base64,AQIDBA==');
globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.enqueue(new Uint8Array([2,3]));c.enqueue(new Uint8Array([4]));c.close();}}),{headers:{'content-type':'image/png'}});
ck('odd network chunks are not base64 padded separately',(await readDownloadImage(message,a)).dataUri==='data:image/png;base64,AQIDBA==');
for(const [name,response] of [['html',new Response('<html>',{headers:{'content-type':'text/html'}})],['oversize header',new Response('x',{headers:{'content-type':'image/png','content-length':String(26*1024*1024)}})],['HTTP error',new Response('x',{status:403})]]){
 globalThis.fetch=async()=>response;ck(name+' is not a downloadable image',!(await readDownloadImage(message,a)).ok);
}
const pending=[];globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>{pending.push({url,options,resolve});options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});});
const pa=readDownloadImage(message,a),pb=readDownloadImage(message,b);
ck('other document progresses independently',pending.length===2);
ck('broker does not forge a cross-origin referrer',pending.every(p=>!('referrer' in p.options)));
ck('same document has one bounded read',!(await readDownloadImage({...message,requestId:'second'},a)).ok);
cancelDownloadRead(message,{...a,documentId:'wrong-document'});
ck('wrong document cannot cancel another read',!pending[0].options.signal.aborted);
cancelDownloadRead(message,a);ck('cancel only owner read',pending[0].options.signal.aborted&&!pending[1].options.signal.aborted);
ck('cancel returns failed not phantom success',!(await pa).ok);
pending[1].resolve(new Response('good',{headers:{'content-type':'image/png'}}));ck('independent read finishes',(await pb).ok);
const next=readDownloadImage({...message,requestId:'next'},a);cancelTabDownloadReads(1);ck('tab close releases its pending read',!(await next).ok);
ck('broker never calls translation endpoint',pending.every(p=>p.url===message.url&&(!p.options.method||p.options.method==='GET')));
console.log(JSON.stringify({checks:checks.length,passed:checks,scope:'Production broker; mocked network image streams and per-document sender identities'},null,2));
