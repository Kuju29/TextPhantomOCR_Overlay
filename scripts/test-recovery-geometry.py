"""Regression contract: source ruby removal and nonfatal orientation isolation.
No OCR/provider calls. Uses authored geometry and a recorded Lens fixture.
"""
from pathlib import Path
import copy, json, subprocess, sys, unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'api'))
from backend.lens.furigana import strip_furigana_trees
from backend.grouping.detector_free_service import group_vertical_lens, DetectorFreeGroupingError
from backend.grouping.ai_source_tree import build_ai_source_tree
from backend.lens import document

def item(text,b,angle=0):
    x,y,X,Y=b;w,h=X-x,Y-y
    # Native zero-degree envelope, also used by Lens for tall CJK columns.
    return dict(text=text,bounds_px=b,baseline_p1=dict(x=x/1000,y=(y+Y)/2000),
        baseline_p2=dict(x=X/1000,y=(y+Y)/2000),height_raw=h/1000,
        box=dict(left=x/1000,top=y/1000,width=w/1000,height=h/1000,rotation_deg=angle),valid_text=True)
def para(items,index=0,**kw):
    bs=[i['bounds_px'] for i in items]
    return dict(para_index=index,text=''.join(i['text'] for i in items),items=items,
        bounds_px=[min(b[0] for b in bs),min(b[1] for b in bs),max(b[2] for b in bs),max(b[3] for b in bs)],**kw)
def run(ps,lang='ja',target=None):
    return strip_furigana_trees({'paragraphs':ps},target or {'paragraphs':[]},source_lang=lang,img_w=1000,img_h=1000)

def vectors():
    vbase=item('魔法',[100,20,120,160]);vruby=item('まほう',[122,40,129,85])
    hbase=item('永椎晃平',[100,100,240,126]);hruby=item('ながしいこうへい',[105,89,235,97])
    cases=[]
    def add(name,ps,drops,**kw):cases.append(dict(name=name,original={'paragraphs':ps},translated={'paragraphs':[para([item('คำแปล',[20,20,100,40])])]},lang=kw.get('lang','ja'),expected=drops))
    add('vertical_zero_angle_cross_paragraph',[para([vbase]),para([vruby],1)],1)
    add('horizontal_ruby_above_author',[para([hruby]),para([hbase],1)],1)
    add('horizontal_mixed_paragraph',[para([hruby,hbase])],1)
    add('square_single_kana',[para([vbase]),para([item('ま',[122,40,129,47])],1)],1)
    add('kana_same_size_dialogue',[para([vbase]),para([item('はい',[122,40,142,100])],1)],0)
    add('kana_left_not_ruby',[para([vbase]),para([item('まほう',[90,40,97,85])],1)],0)
    add('kana_below_not_ruby',[para([hbase]),para([item('まほう',[120,128,180,136])],1)],0)
    add('kana_far_right_other_balloon',[para([vbase]),para([item('おっす',[165,40,174,85])],1)],0)
    add('ruby_ambiguous_owners',[para([vbase]),para([item('属性',[98,20,118,160])],1),para([vruby],2)],0)
    add('different_explicit_containers',[para([vbase],container_id='a'),para([vruby],1,container_id='b')],0)
    add('tilted_small_text_not_ruby',[para([vbase]),para([item('まほう',[122,40,129,85],45)],1)],0)
    add('kana_punctuation_not_ruby',[para([vbase]),para([item('・・・',[122,40,129,85])],1)],0)
    add('no_japanese_language_evidence',[para([vbase]),para([vruby],1)],0,lang='en')
    mixed=item('ながしいこうへい永椎晃平',[100,89,240,126]);mixed['spans']=[{**hruby,'span_index':0},{**hbase,'span_index':1}]
    add('ruby_span_in_merged_item',[para([mixed])],0)
    cases[-1]['expectedSpans']=1
    for angle in (90,-90):
        add(f'vertical_signed_{angle}',[para([item('魔法',[100,20,120,160],angle)]),para([item('まほう',[122,40,129,85],angle)],1)],1)
    merged=item('ながしいこうへい永椎晃平',[100,89,240,126])
    merged['spans']=[{**hruby,'span_index':0},
        {**item('永椎',[100,100,164,126]),'span_index':1},
        {**item('晃平',[166,100,240,126]),'span_index':2}]
    add('two_main_spans_reframed_after_ruby',[para([merged])],0)
    cases[-1]['expectedSpans']=1
    separated=item('まほう永椎晃平',[100,89,318,126])
    separated['spans']=[{**item('まほう',[105,89,310,97]),'span_index':0},
        {**item('永椎',[100,100,164,126]),'span_index':1},
        {**item('晃平',[244,100,318,126]),'span_index':2}]
    add('separated_kanji_spans_do_not_form_fake_owner',[para([separated])],0)
    staggered=item('まほう永椎晃平',[100,89,240,156])
    staggered['spans']=[{**hruby,'text':'まほう','span_index':0},
        {**item('永椎',[100,100,164,126]),'span_index':1},
        {**item('晃平',[166,130,240,156]),'span_index':2}]
    add('staggered_kanji_spans_do_not_form_fake_owner',[para([staggered])],0)
    return cases

class RubyRegression(unittest.TestCase):
    def test_authored_vectors_and_cross_runtime_parity(self):
        cases=vectors();expected=[]
        for c in cases:
            before=copy.deepcopy(c)
            a,b,report=strip_furigana_trees(c['original'],c['translated'],source_lang=c['lang'],img_w=1000,img_h=1000)
            self.assertEqual(report['itemsDropped'],c['expected'],c['name']);self.assertEqual(report['spansDropped'],c.get('expectedSpans',0),c['name'])
            self.assertEqual(c,before,'must not mutate source data');self.assertIs(b,c['translated'])
            aa,bb,_=strip_furigana_trees(a,b,source_lang=c['lang'],img_w=1000,img_h=1000)
            self.assertEqual(aa,a,'idempotent cleanup');self.assertEqual(bb,b)
            expected.append(dict(original=a,translated=b,report=report))
        code="""import fs from 'node:fs';import {filterJapaneseFuriganaTrees as f} from './src/shared/lens-furigana.js';
let c=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(c.map(v=>f(v.original,v.translated,{sourceLang:v.lang,imgW:1000,imgH:1000}))));"""
        proc=subprocess.run(['node','--input-type=module','-e',code],input=json.dumps(cases),text=True,capture_output=True,cwd=ROOT)
        self.assertEqual(proc.returncode,0,proc.stderr);self.assertEqual(json.loads(proc.stdout),expected)
    def test_original_envelope_rebuilt_from_main_not_ruby(self):
        c=vectors()[2];o,_,r=strip_furigana_trees(c['original'],c['translated'],source_lang='ja',img_w=1000,img_h=1000)
        p=o['paragraphs'][0];self.assertEqual(p['bounds_px'],[100,100,240,126]);self.assertEqual(p['text'],'永椎晃平')
        self.assertEqual(p['items'][0]['box'],c['original']['paragraphs'][0]['items'][1]['box'])
    def test_span_removal_shrinks_item_geometry(self):
        c=next(c for c in vectors() if c['name']=='ruby_span_in_merged_item');o,_,_=strip_furigana_trees(c['original'],c['translated'],source_lang='ja',img_w=1000,img_h=1000)
        n=o['paragraphs'][0]['items'][0];self.assertEqual(n['text'],'永椎晃平');self.assertEqual(n['bounds_px'],[100,100,240,126]);self.assertEqual(n['box']['top'],.1)
    def test_multiple_retained_spans_are_reframed_without_loss(self):
        c=next(c for c in vectors() if c['name']=='two_main_spans_reframed_after_ruby')
        o,_,r=strip_furigana_trees(c['original'],c['translated'],source_lang='ja',img_w=1000,img_h=1000)
        n=o['paragraphs'][0]['items'][0]
        self.assertEqual(n['text'],'永椎晃平');self.assertEqual(n['bounds_px'],[100,100,240,126])
        self.assertEqual(n['box']['top'],.1);self.assertEqual(n['box']['rotation_deg'],0)
        self.assertEqual([s['text'] for s in n['spans']],['永椎','晃平'])
        self.assertEqual(n['spans'][0]['t0_raw'],0);self.assertEqual(n['spans'][1]['t1_raw'],1)
        self.assertEqual(r['spansDropped'],1)
    def test_removal_does_not_shift_existing_target_pairing(self):
        src=[para([item('まほう',[122,40,129,85])]),para([item('魔法',[100,20,120,160])],1),para([item('火炎',[200,20,220,160])],2)]
        t={'paragraphs':[para([item(s,[10,20+i*30,100,40+i*30])],i) for i,s in enumerate(['reading','magic','fire'])]}
        o,tt,_=run(src,target=t);d=document.build(o,tt,width=1000,height=1000)
        self.assertEqual([p['lensText'] for p in d['paragraphs']],['magic','fire'])
        self.assertEqual(len(document.build_translated(tt,width=1000,height=1000)['paragraphs']),3)
    def test_removal_does_not_invent_pairing_for_independent_target_counts(self):
        src=[para([item('まほう',[122,40,129,85])]),para([item('魔法',[100,20,120,160])],1)]
        t={'paragraphs':[para([item('คำแปลรวม',[10,20,100,40])])]}
        o,tt,_=run(src,target=t);d=document.build(o,tt,width=1000,height=1000)
        self.assertEqual(d['paragraphs'][0]['lensItems'],[]);self.assertEqual(tt,t)

class OrientationRecovery(unittest.TestCase):
    def uncertain(self,name='u',bounds=True):
        p=para([item('かな',[145,60,165,80])]);p['id']=name
        p['items'][0]['box'].pop('rotation_deg')
        if not bounds:p.pop('bounds_px')
        return p
    def test_unknown_is_singleton_main_columns_still_merge(self):
        ps=[para([item('本文',[100,20,120,160],90)]),self.uncertain(),para([item('続文',[70,20,90,160],90)],2)]
        before=copy.deepcopy(ps);r=group_vertical_lens({'paragraphs':ps},1000,1000)
        groups=r['grouping_result']['groups'];self.assertEqual(len(groups),2)
        isolated=[g for g in groups if g.get('orientationFallback')];self.assertEqual(len(isolated),1)
        self.assertEqual(isolated[0]['paragraphIds'],['p1']);self.assertEqual(isolated[0]['text'],'かな')
        self.assertEqual(r['debug']['isolatedIds'],['u']);self.assertEqual(ps,before)
        source=build_ai_source_tree({'paragraphs':ps},r['grouping_result'])
        self.assertEqual(len(source['paragraphs']),2)
    def test_all_unknown_finite_geometry_can_continue(self):
        r=group_vertical_lens({'paragraphs':[self.uncertain('a'),self.uncertain('b')]},1000,1000)
        self.assertEqual(len(r['grouping_result']['groups']),2)
    def test_unknown_uses_items_if_paragraph_envelope_absent(self):
        r=group_vertical_lens({'paragraphs':[self.uncertain(bounds=False)]},1000,1000)
        self.assertEqual(r['grouping_result']['groups'][0]['boundsPx'],[145,60,165,80])
    def test_empty_after_legacy_ruby_measurement_preserved_standalone(self):
        p=self.uncertain();p['items'][0]['box']['rotation_deg']=0
        with patch('backend.grouping.detector_free_service.infer_item_ruby',return_value={'u':(0,)}):
            r=group_vertical_lens({'paragraphs':[p]},1000,1000)
        self.assertEqual(r['bubble_groups'][0]['text'],'かな')
    def test_unknown_missing_geometry_is_not_silently_accepted(self):
        p={'text':'かな','items':[{'text':'かな','box':{}}]}
        with self.assertRaises(DetectorFreeGroupingError) as c:group_vertical_lens({'paragraphs':[p]},1000,1000)
        self.assertEqual(c.exception.code,'orientation_unresolved')
    def test_nonfinite_geometry_is_not_drawable(self):
        p=self.uncertain();p['bounds_px']=[0,0,float('nan'),100];p['items']=[]
        with self.assertRaises(DetectorFreeGroupingError):group_vertical_lens({'paragraphs':[p]},1000,1000)

if __name__=='__main__':unittest.main(verbosity=2)
