"""Offline erase-owner producer parity and API composition regression.
Uses the recorded Lens fixture and real decoders; no Lens/provider request.
TP_TEST_ROOT selects an unmodified release for a negative baseline run.
"""
from pathlib import Path
import asyncio, copy, json, os, subprocess, sys, tempfile, unittest
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image
ROOT=Path(os.environ.get('TP_TEST_ROOT', Path(__file__).resolve().parents[1])).resolve()
sys.path.insert(0,str(ROOT/'api'))
from backend.application import lens_service
from backend.jobs.stages import image_flow, lens_stage
from backend.render import erase_boxes
from backend.lens import document
from backend.lens.tree import flatten_spans
FIXTURE=json.loads((ROOT/'scripts/fixtures/lens-display-recorded.json').read_text(encoding='utf-8'))
W,H=FIXTURE['image']['width'],FIXTURE['image']['height']
NODE=r'''import {pathToFileURL} from 'node:url';import fs from 'node:fs';
const root=pathToFileURL(process.argv[1]+'/');
const {decodeLensResponse}=await import(new URL('src/shared/lens-decode.js',root));
const f=JSON.parse(fs.readFileSync(new URL('scripts/fixtures/lens-display-recorded.json',root),'utf8'));
const d=decodeLensResponse(f.lens,{...f.image,targetLang:'th'});
console.log(JSON.stringify({doc:d.document,boxes:d.eraseBoxes,tree:d.trees.original}));'''

class OwnedEraseApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js=json.loads(subprocess.check_output(['node','--input-type=module','-e',NODE,str(ROOT)],text=True,encoding='utf-8'))
    def assert_owned(self,doc,boxes):
        self.assertTrue(boxes['boxes'])
        known={p['id'] for p in doc['paragraphs']}
        self.assertTrue(all(b.get('p') in known for b in boxes['boxes']), 'producer emitted unowned/foreign erase boxes')
    def decoded(self):
        return lens_stage.decode(copy.deepcopy(FIXTURE['lens']),W,H)
    def test_api_compatibility_decoder_and_document_share_owner_namespace(self):
        doc,boxes=lens_service._decode(FIXTURE['lens'],width=W,height=H,target_lang='th')
        self.assert_owned(doc,boxes)
    def test_filtered_api_producer_matches_actual_extension_decode_exactly(self):
        original,translated=self.decoded()
        boxes=erase_boxes.build_for_tree(original)
        doc=document.build(original,translated,width=W,height=H,source_lang='ja',target_lang='th')
        self.assert_owned(doc,boxes)
        self.assertEqual(len(boxes['boxes']),85)
        self.assertEqual(boxes,self.js['boxes'])
        self.assertEqual([p['id'] for p in doc['paragraphs']],[p['id'] for p in self.js['doc']['paragraphs']])
    def test_ownership_metadata_does_not_change_geometry_or_skipped_counts(self):
        original,_=self.decoded()
        original['paragraphs'][0]['items'][0]['spans'].extend([{}, {'box':{'width':0,'height':.1}}])
        before=copy.deepcopy(original)
        owned=erase_boxes.build_for_tree(original);raw=erase_boxes.build(flatten_spans(original))
        self.assertEqual([{k:v for k,v in b.items() if k!='p'} for b in owned['boxes']],raw['boxes'])
        self.assertEqual(owned.get('skipped'),raw.get('skipped'));self.assertEqual(original,before)
    def test_sparse_old_ocr_indices_do_not_become_new_document_ids(self):
        original,translated=self.decoded()
        original['paragraphs']=[original['paragraphs'][0],None,original['paragraphs'][3]]
        original['paragraphs'][0]['para_index']=800;original['paragraphs'][2]['para_index']=912
        doc=document.build(original,{},width=W,height=H)
        boxes=erase_boxes.build_for_tree(original)
        self.assert_owned(doc,boxes);self.assertEqual({b['p'] for b in boxes['boxes']},{'p0','p2'})
    def test_empty_post_filter_source_produces_empty_mask_not_origin_box(self):
        self.assertEqual(erase_boxes.build_for_tree({'paragraphs':[]}),{'schema':'tp.erase-boxes/1','boxes':[]})
        self.assertEqual(erase_boxes.build_for_tree(None),{'schema':'tp.erase-boxes/1','boxes':[]})
    def test_full_api_original_image_flow_retains_owner_after_grouping(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'recorded.png';Image.new('RGB',(W,H),'white').save(p)
            with patch.object(image_flow,'resolve_font_pair',return_value=('', '')), patch.object(image_flow.render_stage,'annotate_text_light'):
                out=image_flow.process_image(str(p),'th','lens_text',None,source='original',lens_data=copy.deepcopy(FIXTURE['lens']),
                    layout_opts={'client_background':True,'lens_document':True,'relayout_translated':False})
            self.assert_owned(out['lensDocument'],out['eraseBoxes'])
            self.assertEqual(out['eraseBoxes'],self.js['boxes']);self.assertIn('canonicalOriginalTree',out)
    def test_python_masks_remain_selectable_for_grouped_partial_in_extension(self):
        original,translated=self.decoded()
        doc=document.build(original,translated,width=W,height=H,source_lang='ja',target_lang='th')
        doc['paragraphs'][0]['aiText']='คำแปล';doc['paragraphs'][0]['aiGroupParagraphIds']=['p0','p1'];doc['paragraphs'][1]['aiCoveredBy']='p0'
        data={'doc':doc,'boxes':erase_boxes.build_for_tree(original)}
        node=r'''import {pathToFileURL} from 'node:url';import fs from 'node:fs';
const root=pathToFileURL(process.argv[1]+'/');const {eraseBoxesForAiPartial}=await import(new URL('src/shared/erase-boxes.js',root));
const d=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(eraseBoxesForAiPartial(d.doc,d.boxes)));'''
        result=json.loads(subprocess.check_output(['node','--input-type=module','-e',node,str(ROOT)],input=json.dumps(data),text=True,encoding='utf-8'))
        self.assertTrue(result['ok'],result);self.assertEqual({b['p'] for b in result['eraseBoxes']['boxes']},{'p0','p1'})

if __name__=='__main__':unittest.main()
