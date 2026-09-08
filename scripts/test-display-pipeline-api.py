"""Offline API stage integration: target-owned grouping, source preservation and concurrency."""
from pathlib import Path
import asyncio, copy, json, math, re, sys, tempfile, threading, unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
from backend.jobs.stages import image_flow
from backend.render.translated_groups import translated_document, translated_layout_groups
from backend.render.html.translated import render_translated_overlay
from backend.application.ai_translation.request_validation import MAX_UNITS,MAX_UNIT_CHARS,MAX_TOTAL_CHARS
from backend.application.ai_request import validate_units

def paragraph(index,x,y,length,glyph,angle,text):
    rad=math.radians(angle);dx=math.cos(rad)*length/2;dy=math.sin(rad)*length/2
    aw=abs(length*math.cos(rad))+abs(glyph*math.sin(rad));ah=abs(length*math.sin(rad))+abs(glyph*math.cos(rad))
    bounds=[x-aw/2,y-ah/2,x+aw/2,y+ah/2]
    return {'para_index':index,'text':text,'bounds_px':bounds,'items':[{
        'item_index':0,'para_index':index,'text':text,'valid_text':True,'bounds_px':bounds,'height_raw':glyph/1000,
        'baseline_p1':{'x':(x-dx)/1000,'y':(y-dy)/1000},'baseline_p2':{'x':(x+dx)/1000,'y':(y+dy)/1000},
        'box':{'left':(x-length/2)/1000,'top':(y-glyph/2)/1000,'width':length/1000,'height':glyph/1000,'rotation_deg':angle}}]}

ORIGINAL={'side':'original','source_lang':'ja','paragraphs':[
    paragraph(0,700,200,200,20,90,'本文'),paragraph(1,665,200,200,20,-90,'続き')]}
TRANSLATED={'side':'translated','paragraphs':[
    paragraph(0,500,400,200,20,90,'คำแปลแรก'),paragraph(1,465,400,200,20,-90,'คำแปลที่สอง'),
    paragraph(2,200,400,200,40,90,'หัวเรื่อง')]}
LAYOUT={'client_background':True,'lens_document':True,'relayout_translated':False}

class DisplayPipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.paths=[]
        for name in ['A','B']:
            p=Path(self.tmp.name)/(name+'.png');Image.new('RGB',(1000,1000),'white').save(p);self.paths.append(p)
    def patches(self,fetch=None,run_ai=None):
        stack=ExitStack()
        stack.enter_context(patch.object(image_flow.lens_stage,'fetch',side_effect=fetch or (lambda path,*_:({'originalTextFull':Path(path).stem,'originalContentLanguage':'ja'},0.0))))
        stack.enter_context(patch.object(image_flow.lens_stage,'decode',side_effect=lambda *_:(copy.deepcopy(ORIGINAL),copy.deepcopy(TRANSLATED))))
        stack.enter_context(patch.object(image_flow,'resolve_font_pair',return_value=('', '')))
        stack.enter_context(patch.object(image_flow.render_stage,'annotate_text_light'))
        stack.enter_context(patch.object(image_flow,'settings',SimpleNamespace(lens_direct_erase=False,lens_direct_png=False)))
        if run_ai:
            stack.enter_context(patch.object(image_flow.ai_stage,'run_ai_layer',side_effect=run_ai))
            stack.enter_context(patch.object(image_flow,'is_local_target',return_value=True))
        return stack
    def process(self,path,source='translated',rotate=False,ai=None):
        return image_flow.process_image(str(path),'th','lens_text',ai,source=source,
            layout_opts={**LAYOUT,'relayout_translated':rotate})
    def test_translated_never_requests_or_projects_source_groups(self):
        with self.patches(), patch.object(image_flow,'group_vertical_lens',side_effect=AssertionError('source grouping forbidden for Translated')):
            for rotate in [False,True,False]:
                out=self.process(self.paths[0],rotate=rotate)
                self.assertEqual(out['translated']['translatedTree'],TRANSLATED)
                groups=out['translated']['displayGroups'];self.assertEqual([g['paragraphIds'] for g in groups],[['p0','p1'],['p2']])
                self.assertEqual(len(out['lensDocument']['paragraphs']),3)
                self.assertTrue(all(p['sourceText']=='' and not p['items'] for p in out['lensDocument']['paragraphs']))
                html=out['translated']['translatedhtml']
                self.assertEqual(html.count('class="tp-line'),2 if rotate else 3)
                self.assertIn('rotate(0deg)' if rotate else 'rotate(-90.0000deg)',html)
                self.assertEqual(out['perfStages']['grouping'],'translated_geometry_only')
    def test_original_preserves_display_geometry_and_exposes_canonical_grouping(self):
        with self.patches():out=self.process(self.paths[0],source='original')
        tree=out['original']['originalTree']
        for a,b in zip(tree['paragraphs'],ORIGINAL['paragraphs']):
            self.assertEqual(a['text'],b['text']);self.assertEqual(a['bounds_px'],b['bounds_px'])
            for x,y in zip(a['items'],b['items']):
                for key in ['text','box','height_raw','baseline_p1','baseline_p2']:self.assertEqual(x[key],y[key])
        self.assertEqual(out['lensDocument']['canonicalOriginalTree'],out['canonicalOriginalTree'])
        self.assertEqual(len(out['canonicalOriginalTree']['paragraphs']),1)
        self.assertEqual(out['original']['originalhtml'].count('tp-gtext'),1)
    def test_off_common_font_and_direction_per_target_group_no_raw_mutation(self):
        before=copy.deepcopy(TRANSLATED)
        html=render_translated_overlay(TRANSLATED,1000,1000,rotate=False,target_lang='th')
        fs=[int(v) for v in re.findall(r'data-fs="(\d+)"',html)]
        self.assertEqual(fs[0],fs[1]);self.assertNotEqual(fs[0],fs[2]);self.assertEqual(html.count('rotate(-90.0000deg)'),3)
        self.assertEqual(before,TRANSLATED)
    def test_lens_wait_of_image_A_does_not_block_other_image_delivery(self):
        entered=threading.Event();release=threading.Event()
        def fetch(path,*_):
            if Path(path).stem=='A':
                entered.set()
                if not release.wait(4):raise RuntimeError('test deadlock')
            return {'originalTextFull':Path(path).stem},0.0
        with self.patches(fetch=fetch),ThreadPoolExecutor(max_workers=2) as pool:
            a=pool.submit(self.process,self.paths[0]);self.assertTrue(entered.wait(2))
            try:
                b=pool.submit(self.process,self.paths[1]);result=b.result(timeout=2)
                self.assertTrue(result['translated']['translatedhtml']);self.assertFalse(a.done())
            finally:release.set()
            self.assertTrue(a.result(timeout=2)['translated']['translatedhtml'])
    def test_AI_wait_of_image_A_does_not_block_image_B_AI_and_delivery(self):
        entered=threading.Event();release=threading.Event()
        def run_ai(out,*_,**__):
            if out['originalTextFull']=='A':
                entered.set()
                if not release.wait(4):raise RuntimeError('test deadlock')
            out['Ai']={'aiTree':{'paragraphs':[]},'aihtml':'<div>fixture result</div>'}
        cfg=SimpleNamespace(provider='ollama',base_url='http://localhost:11434',api_key='')
        # Match legacy AI template paragraph count so this test isolates scheduling,
        # not the deliberately mismatched target-only fixture used above.
        target={**TRANSLATED,'paragraphs':TRANSLATED['paragraphs'][:2]}
        with self.patches(run_ai=run_ai),patch.object(image_flow.lens_stage,'decode',side_effect=lambda *_:(copy.deepcopy(ORIGINAL),copy.deepcopy(target))),ThreadPoolExecutor(max_workers=2) as pool:
            a=pool.submit(self.process,self.paths[0],'ai',False,cfg);self.assertTrue(entered.wait(2))
            try:
                b=pool.submit(self.process,self.paths[1],'ai',False,cfg);result=b.result(timeout=2)
                self.assertTrue(result['Ai']['aihtml']);self.assertFalse(a.done())
            finally:release.set()
            self.assertTrue(a.result(timeout=2)['Ai']['aihtml'])
    def test_capabilities_report_actual_CPU_group_slots(self):
        from backend.application.translate_service import capability_snapshot
        from backend.jobs.runtime import CPU_SLOTS
        stats=SimpleNamespace(limit=8,as_dict=lambda:{"limit":8})
        gate=SimpleNamespace(stats=lambda:stats,adaptive_state=lambda:{"limit":8})
        request=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(admission_gate=gate,ai_admission_gate=gate)))
        data=asyncio.run(capability_snapshot(request))
        self.assertEqual(data['capacityGroups'],{'limit':CPU_SLOTS,'source':'shared_cpu_runtime'})
        self.assertEqual(data['capacityAi']['limit'],8)

    def test_short_source_char_batches_over_200_units_reach_validation_but_security_bound_remains(self):
        rows=[{'id':f'p{i}','text':'a'} for i in range(220)]
        self.assertEqual(len(validate_units(rows,max_units=MAX_UNITS,max_unit_chars=MAX_UNIT_CHARS,max_total_chars=MAX_TOTAL_CHARS)),220)
        with self.assertRaises(ValueError):validate_units([{'id':f'p{i}','text':'a'} for i in range(MAX_UNITS+1)],max_units=MAX_UNITS,max_unit_chars=MAX_UNIT_CHARS,max_total_chars=MAX_TOTAL_CHARS)

if __name__=='__main__':unittest.main()
