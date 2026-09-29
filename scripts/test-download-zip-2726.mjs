import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),window={__TP:{}};window.top=window;
const context=vm.createContext({window,Blob,TextEncoder,Uint32Array,Uint8Array,DataView,DOMException,Set,Date,Promise,setTimeout});
vm.runInContext(fs.readFileSync(path.join(root,'src/content/download/zip.js'),'utf8'),context);
const {ImageZip,zipEntryName}=window.__TP.downloads;
const signal=new AbortController().signal;
let checks=0;const ck=(label,f)=>{f();checks++;console.log('PASS',label);};
const z=new ImageZip(),binary=new Uint8Array(2200000);for(let i=0;i<binary.length;i++)binary[i]=i%251;
await z.add('บททดสอบ - 001.png',new Blob([binary]),signal);
await z.add('บททดสอบ - 001.png',new Blob(['second']),signal);
await z.add('ZERO.bin',new Blob([]),signal);
await z.add('../folder\\bad.png',new Blob(['safe']),signal);
const blob=z.finish(signal),dir=fs.mkdtempSync(path.join(os.tmpdir(),'tp-zip-2726-')),file=path.join(dir,'archive.zip');
fs.writeFileSync(file,Buffer.from(await blob.arrayBuffer()));
try{
 const result=JSON.parse(execFileSync('python',['-c',`import zipfile,json,sys,zlib
z=zipfile.ZipFile(sys.argv[1]);n=z.namelist()
assert z.testzip() is None
assert z.read(n[0])==bytes(i%251 for i in range(2200000))
assert z.read(n[1])==b'second'
assert z.read('ZERO.bin')==b''
assert all(i.compress_type==0 and (i.flag_bits&0x800) for i in z.infolist())
assert all('/' not in name and '\\\\' not in name for name in n)
print(json.dumps({'names':n,'count':len(n)},ensure_ascii=False))`,file],{encoding:'utf8'}));
 ck('Python zipfile verifies CRC, UTF-8, bytes, empty entry and safe leaf paths',()=>assert.equal(result.count,4));
 ck('duplicate names are not overwritten',()=>assert.ok(result.names[1].includes('(2)')));
 ck('image ordering preserved',()=>assert.equal(result.names[0],'บททดสอบ - 001.png'));
 ck('ZIP media type',()=>assert.equal(blob.type,'application/zip'));
 ck('blob references released after finish',()=>assert.equal(z.parts.length,0));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
ck('long Thai entry name kept extractable',()=>assert.ok(new TextEncoder().encode(zipEntryName('ก'.repeat(200)+'.png')).length<=220));
ck('reserved filename escaped',()=>assert.equal(zipEntryName('CON.png'),'_CON.png'));
assert.throws(()=>new ImageZip().finish(signal),/No images/);checks++;
const aborted=new AbortController();aborted.abort();await assert.rejects(new ImageZip().add('a',new Blob(['a']),aborted.signal),{name:'AbortError'});checks++;
const midway=new AbortController(),pending=new ImageZip();setTimeout(()=>midway.abort(),1);
await assert.rejects(pending.add('large',new Blob([binary]),midway.signal),{name:'AbortError'});checks++;
ck('cancelled CRC never adds half entry',()=>assert.equal(pending.entries.length,0));
class TooLarge extends Blob { get size(){return 0xffffffff;} }
await assert.rejects(new ImageZip().add('large',new TooLarge(['x']),signal),e=>e.code==='DOWNLOAD_ZIP_LIMIT');checks++;
const disposable=new ImageZip();disposable.dispose();await assert.rejects(disposable.add('x',new Blob(['x']),signal),/closed/);checks++;
console.log('PASS',checks,'ZIP integrity / cancellation / limits checks');
