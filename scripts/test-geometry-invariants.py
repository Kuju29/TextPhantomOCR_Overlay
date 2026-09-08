"""Metamorphic geometry checks, not a benchmark of unseen manga quality."""
from pathlib import Path
import copy, json, random, subprocess, sys, unittest
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'api'))
from backend.lens.furigana import strip_furigana_trees
from backend.grouping.detector_free_service import group_vertical_lens
from backend.geometry_diagnostics import geometry_diagnostics, ruby_diagnostics, group_diagnostics

def node(text, b, ident, angle=90):
    return dict(id=ident,para_index=int(ident[1:]),text=text,bounds_px=b,
        items=[dict(text=text,bounds_px=b,box=dict(rotation_deg=angle))])

def fixture(scale=1, dx=0, dy=0, reverse=False):
    rows=[('魔法',[100,80,124,280],'p0'),('学校',[65,80,89,250],'p1'),
          ('別人',[420,360,444,540],'p2'),('会話',[385,360,409,560],'p3'),
          ('まほう',[126,100,134,180],'p4')]
    out=[node(t,[(b[0]+dx)*scale,(b[1]+dy)*scale,(b[2]+dx)*scale,(b[3]+dy)*scale],i) for t,b,i in rows]
    if reverse:out.reverse()
    return {'paragraphs':out}

def groups(tree,w,h):
    result=group_vertical_lens(tree,w,h)
    return sorted(sorted(g['paragraphIds']) for g in result['grouping_result']['groups'])

class GeometryInvariants(unittest.TestCase):
    def test_filter_and_group_scales_offsets_and_input_order(self):
        signatures=[]
        for scale in (.5,1,2,4):
            for dx,dy in ((0,0),(120,60)):
                for reverse in (False,True):
                    raw=fixture(scale,dx,dy,reverse);before=copy.deepcopy(raw)
                    cleaned,_,report=strip_furigana_trees(raw,{},source_lang='ja',img_w=1000*scale,img_h=1000*scale)
                    self.assertEqual(report['itemsDropped'],1)
                    self.assertEqual(sorted(p['text'] for p in cleaned['paragraphs']),['会話','別人','学校','魔法'])
                    self.assertEqual(raw,before)
                    # Map document IDs to semantic identity solely for the test;
                    # production still maps the actual immutable IDs.
                    result=group_vertical_lens(cleaned,1000*scale,1000*scale)
                    raw_by_id={p.get('id',f'p{i}'):p['text'] for i,p in enumerate(cleaned['paragraphs'])}
                    signature=sorted(sorted(raw_by_id[m['rawId']] for m in g['sourceContract']['members']) for g in result['grouping_result']['groups'])
                    signatures.append(signature)
        self.assertTrue(all(s==[['会話','別人'],['学校','魔法']] for s in signatures),signatures)
    def test_membership_diagnostics_cross_runtime_and_oversize(self):
        data={"groups":[dict(id="g0",paragraphIds=[f"p{i}" for i in range(19)],boundsPx=[0,10,100,200],direction="v",text="PRIVATE")]}
        expected=group_diagnostics(data,1000,1000)
        self.assertFalse(expected[0]["complete"])
        self.assertEqual(expected[0]["rows"][0]["count"],19)
        self.assertEqual(len(expected[0]["rows"][0]["ids"]),12)
        js="import fs from 'node:fs';import {groupDiagnostics} from './src/shared/geometry-diagnostics.js';console.log(JSON.stringify(groupDiagnostics(JSON.parse(fs.readFileSync(0,'utf8')),1000,1000)));"
        p=subprocess.run(['node','--input-type=module','-e',js],input=json.dumps(data),text=True,capture_output=True,cwd=ROOT)
        self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(json.loads(p.stdout),expected)
        self.assertNotIn("PRIVATE",json.dumps(expected))
    def test_diagnostic_bound_no_text_and_cross_runtime(self):
        tree=fixture();tree['paragraphs']*=30
        events=geometry_diagnostics(tree,1000,1000)
        self.assertTrue(all(len(e['rows'])<=12 for e in events));self.assertEqual(sum(len(e['rows']) for e in events),48)
        self.assertTrue(all(not e['complete'] and e['totalRows']==150 for e in events))
        self.assertNotIn('魔法',json.dumps(events,ensure_ascii=False))
        js="import fs from 'node:fs';import {geometryDiagnostics} from './src/shared/geometry-diagnostics.js';console.log(JSON.stringify(geometryDiagnostics(JSON.parse(fs.readFileSync(0,'utf8')),{width:1000,height:1000})));"
        p=subprocess.run(['node','--input-type=module','-e',js],input=json.dumps(tree),text=True,capture_output=True,cwd=ROOT)
        self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(json.loads(p.stdout),events)

if __name__=='__main__':unittest.main()
