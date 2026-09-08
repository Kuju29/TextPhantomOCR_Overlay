import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {buildTranslatedLensDocument} from '../src/shared/lens-document.js';
import {decodeLensResponse} from '../src/shared/lens-decode.js';
import {decodeTree} from '../src/shared/lens-tree.js';
import {translatedLayoutGroups} from '../src/processors/render/translated-groups.js';
import {renderOverlay} from '../src/processors/render/renderer.js';

let checks=0;const test=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
function element(tag) {
 const e={tag,children:[],attrs:{},textContent:'',style:{cssText:''},className:'',
  appendChild(child){this.children.push(child);return child;},
  setAttribute(name,value){this.attrs[name]=String(value);}};
 e.classList={add(...v){e.className+=' '+v.join(' ');}};return e;
}
const ownerDocument={createElement:element};
const lines=root=>{const list=[];const walk=e=>{if(e.className.split(' ').includes('tp-line'))list.push(e);e.children.forEach(walk);};walk(root);return list;};
const render=(doc,source='translated',rotate=false)=>renderOverlay(doc,{source,relayoutTranslated:rotate,ownerDocument});
const font=e=>Number(e.style.cssText.match(/\* (\d+)px/)[1]);
function rawPara(index,x,y,length,glyph,angle,text) {
 const radians=angle*Math.PI/180,dx=Math.cos(radians)*length/2,dy=Math.sin(radians)*length/2;
 return {para_index:index,text,items:[{item_index:0,text,valid_text:true,height_raw:glyph/1000,
  baseline_p1:{x:(x-dx)/1000,y:(y-dy)/1000},baseline_p2:{x:(x+dx)/1000,y:(y+dy)/1000},
  box:{left:(x-length/2)/1000,top:(y-glyph/2)/1000,width:length/1000,height:glyph/1000,rotation_deg:angle}}]};
}
const tree={side:'translated',paragraphs:[
 rawPara(0,700,200,200,20,90,'คำแปลหนึ่ง'),rawPara(1,665,200,200,20,-90,'คำแปลสองที่ยาวขึ้น'),
 rawPara(2,200,200,200,40,90,'หัวเรื่อง'),rawPara(3,350,500,250,20,0,'Horizontal translated text'),
 rawPara(4,650,720,160,25,30,'ข้อความเอียง'),
]};
const options={width:1000,height:1000,sourceLang:'ja',targetLang:'th'};
const doc=buildTranslatedLensDocument(tree,options);
const groupSummary=d=>translatedLayoutGroups(d).map(g=>({id:g.id,paragraphIds:g.paragraphIds,direction:g.direction,
 boundsPx:[g.block.leftPct*d.image.width/100,g.block.topPct*d.image.height/100,(g.block.leftPct+g.block.widthPct)*d.image.width/100,(g.block.topPct+g.block.heightPct)*d.image.height/100],
 sharedFontPx:g.sharedFontPx,text:g.text}));
await test('translated geometry creates one neighbouring vertical group, separate title/horizontal/art groups',()=>{
 const g=groupSummary(doc);assert.equal(g.length,4);assert.deepEqual(g[0].paragraphIds,['p0','p1']);
 assert.deepEqual(g.map(x=>x.direction),['v','v','h','tilted']);
});
await test('translated grouping and drawing ignore all Original groups and old ONNX lineage',()=>{
 const contaminated=structuredClone(doc);
 contaminated.groups=[{direction:'v',paragraphIds:['p0','p2','p4'],text:'WRONG SOURCE'}];
 contaminated.canonicalOriginalTree={paragraphs:[{id:'wrong',text:'WRONG SOURCE',source:{documentParagraphIds:['p3']}}]};
 contaminated.paragraphs.forEach(p=>{p.sourceText='UNRELATED';p.items=[{...p.lensItems[0],text:'UNRELATED'}];p.source_para_indices=[999];});
 assert.deepEqual(groupSummary(contaminated),groupSummary(doc));
 for(const rotate of [false,true])assert.equal(JSON.stringify(lines(render(contaminated,'translated',rotate).root)),JSON.stringify(lines(render(doc,'translated',rotate).root)));
});
await test('Rotate OFF: vertical text rotates left at -90, common font only within its translated group',()=>{
 const {root,report}=render(doc);assert.equal(report.error,undefined);
 const ls=lines(root);assert.equal(ls.length,5);
 for(const e of ls.slice(0,3))assert.match(e.style.cssText,/rotate\(-90\.0000deg\)/);
 assert.equal(font(ls[0]),font(ls[1]));assert.notEqual(font(ls[0]),font(ls[2]));
 assert.match(ls[3].style.cssText,/rotate\(0\.0000deg\)/);assert.match(ls[4].style.cssText,/rotate\(30\.0000deg\)/);
 assert.equal(report.rotationFlips,2);assert.equal(report.rotationMixedGroups,1);
});
await test('Rotate ON: horizontal reflow uses target union geometry and preserves all texts',()=>{
 const {root,report}=render(doc,'translated',true);const ls=lines(root);
 assert.equal(ls.length,4);assert.equal(report.coveredByGroup,1);
 assert.equal(ls[0].textContent,'คำแปลหนึ่ง คำแปลสองที่ยาวขึ้น');assert.match(ls[0].style.cssText,/rotate\(0\.0000deg\)/);
 assert.equal(ls[0].attrs['data-tp-group'],'tr:0');
 assert.equal(JSON.stringify(ls.slice(-2)),JSON.stringify(lines(render(doc).root).slice(-2)),'Horizontal and genuine tilt stay unchanged');
});
await test('all operations leave original target JSON and its baselines unchanged',()=>{
 const raw=JSON.stringify(tree),wire=JSON.stringify(doc);groupSummary(doc);render(doc);render(doc,'translated',true);
 assert.equal(JSON.stringify(tree),raw);assert.equal(JSON.stringify(doc),wire);
});
await test('whole-group head agreement prevents staircase chaining; different glyph tiers stay separate',()=>{
 const staircase={paragraphs:[rawPara(0,700,200,200,20,90,'A'),rawPara(1,665,225,200,20,90,'B'),rawPara(2,630,250,200,20,90,'C'),rawPara(3,595,275,200,20,90,'D')]};
 const groups=groupSummary(buildTranslatedLensDocument(staircase,options));assert.equal(groups.length,2);
 const tier={paragraphs:[rawPara(0,700,200,200,40,90,'BIG'),rawPara(1,650,200,200,15,90,'small')]};
 assert.equal(groupSummary(buildTranslatedLensDocument(tier,options)).length,2);
});
await test('many aligned translated columns have no artificial column count ceiling',()=>{
 const wide={paragraphs:Array.from({length:12},(_,i)=>rawPara(i,900-i*30,200,200,20,i%2?-90:90,'text '+i))};
 assert.equal(groupSummary(buildTranslatedLensDocument(wide,options)).length,1);
});
await test('legacy pre-reflowed horizontal target does not rotate twice from source_direction',()=>{
 const old={side:'Ai',relayout:{engine:'build_ai_tree'},paragraphs:[{...rawPara(0,300,200,200,20,0,'Already horizontal'),source_direction:'v',direction:'h',rotated:true,source_para_indices:[3,4,5]}]};
 const projected=buildTranslatedLensDocument(old,options);
 for(const rotate of [false,true])assert.match(lines(render(projected,'translated',rotate).root)[0].style.cssText,/rotate\(0\.0000deg\)/);
});
await test('Translated keeps its own paragraph set including target-only entries',()=>{
 const own=buildTranslatedLensDocument(tree,options);assert.equal(own.paragraphs.length,tree.paragraphs.length);
 assert(own.paragraphs.every(p=>p.sourceText==='' && p.items.length===0 && p.lensItems.length===1));
 assert.equal(lines(render(own).root).length,tree.paragraphs.length);
});
await test('Original semantic HTML groups come from canonical raw topology without altering visible lines',()=>{
 const original=structuredClone(doc);original.paragraphs.forEach(p=>{p.items=p.lensItems;p.sourceText=p.lensText;});
 const before=structuredClone(original);const solo=render(original,'original');
 original.canonicalOriginalTree={paragraphs:[{id:'raw-group',text:'GROUP SENTENCE',source:{documentParagraphIds:['p0','p1']},direction:'v'}]};
 const after=render(original,'original');const visible=x=>lines(x.root).filter(e=>!e.className.includes('tp-gtext')).map(e=>({style:e.style.cssText,text:e.textContent,classes:e.className}));
 assert.deepEqual(visible(solo),visible(after));
 const gtext=lines(after.root).filter(e=>e.className.includes('tp-gtext'));assert.equal(gtext.length,4);
 assert.equal(gtext[0].textContent,'GROUP SENTENCE');assert.equal(gtext[0].attrs['data-tp-group'],'raw-group');
 assert.deepEqual(original.paragraphs,before.paragraphs);
});
const captured=JSON.parse(await readFile(new URL('./fixtures/lens-display-recorded.json',import.meta.url),'utf8'));
await test('recorded Lens: remove eight located ruby items, preserve main geometry and independent target tree',()=>{
 const {width,height}=captured.image,lens=captured.lens;
 const raw=decodeTree(lens.originalParagraphs,lens.originalTextFull,'original',width,height);
 // Manually located readings in this captured fixture, not generated from the
 // detector output. In particular the real greeting おっす must survive.
 const drops=new Set(['0:0','0:2','3:0','7:0','10:0','21:1','25:0','27:0']);
 const d=decodeLensResponse(lens,{width,height,targetLang:'th',source:'original'});
 const rows=[];
 raw.paragraphs.forEach((p,pi)=>{
  const keep=p.items.filter((it,ii)=>!drops.has(`${pi}:${ii}`));
  if(keep.length) rows.push({raw:p,items:keep});
 });
 assert.equal(d.trees.original.paragraphs.length,rows.length);
 assert.equal(d.document.paragraphs.length,rows.length);
 rows.forEach((row,i)=>{
  const actual=d.trees.original.paragraphs[i];assert.equal(actual.items.length,row.items.length);
  assert.equal(actual.items.map(x=>x.text).join(''),row.items.map(x=>x.text).join(''));
  row.items.forEach((old,j)=>{
   for(const key of ['text','box','bounds_px','baseline_p1','baseline_p2','height_raw'])
    assert.deepEqual(actual.items[j][key],old[key],`retained main geometry ${i}/${j}/${key}`);
  });
 });
 assert(d.trees.original.paragraphs.some(p=>p.items.some(it=>it.text==='おっす')));
 assert.equal(d.trees.original.furigana_filter.itemsDropped,8);
 assert.deepEqual(d.groupingRawToDocument,rows.map((_,i)=>i));
 const nativeTarget=decodeTree(lens.translatedParagraphs,lens.translatedTextFull,'translated',width,height);
 assert.deepEqual(d.trees.translated,nativeTarget);
 const t=decodeLensResponse(lens,{width,height,targetLang:'th',source:'translated'});
 assert.deepEqual(t.trees.translated,nativeTarget);
 assert.deepEqual(t.document.paragraphs.map(p=>p.lensText),nativeTarget.paragraphs.map(p=>p.text));
});
await test('recorded Lens input: translated line content and raw geometry survive both toggle paths',()=>{
 const d=decodeLensResponse(captured.lens,{...captured.image,targetLang:'th',source:'translated'}).document;
 const before=JSON.stringify(d);for(const rotate of [false,true]) {
  const {root,report}=render(d,'translated',rotate);assert.equal(report.error,undefined);assert.equal(report.missingLayer.length,0);assert(lines(root).length>0);
 }
 assert.equal(JSON.stringify(d),before);
});
await test('cross-runtime grouping and font fits match JS/Python on synthetic and recorded target layers',()=>{
 const d=decodeLensResponse(captured.lens,{...captured.image,targetLang:'th',source:'translated'}).document;
 const input=[doc,d];
 const py=spawnSync('python',['-c',`import json,sys\nsys.path.insert(0,'api')\nfrom backend.render.translated_groups import translated_layout_groups\ndocs=json.load(sys.stdin)\nprint(json.dumps([translated_layout_groups(d['paragraphs'],d['image']['width'],d['image']['height']) for d in docs],ensure_ascii=False))`],{cwd:new URL('..',import.meta.url),input:JSON.stringify(input),encoding:'utf8'});
 assert.equal(py.status,0,py.stderr);const results=JSON.parse(py.stdout);
 for(let i=0;i<input.length;i++) {
  const expected=groupSummary(input[i]),actual=results[i];assert.equal(actual.length,expected.length);
  for(let j=0;j<actual.length;j++){
   const {boundsPx:a,...ar}=actual[j],{boundsPx:b,...br}=expected[j];assert.deepEqual(ar,br);
   a.forEach((v,k)=>assert(Math.abs(v-b[k])<1e-7));
  }
 }
});
await test('XML/HTML-looking source text remains literal text, never markup',()=>{
 const evil=structuredClone(doc);evil.paragraphs[0].lensItems[0].text='<img src=x onerror=alert(1)>';
 const rendered=lines(render(evil).root)[0];assert.equal(rendered.textContent,evil.paragraphs[0].lensItems[0].text);
 assert.equal(Object.hasOwn(rendered,'innerHTML'),false);
});
console.log(`Display layer ownership: ${checks}/${checks} PASS (offline, current modules).`);
