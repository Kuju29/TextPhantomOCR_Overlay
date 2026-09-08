"""Recorded geometry + real crop, with synthetic negative/large-column controls.
TP_TEST_ROOT selects a baseline implementation without copying fixes into it.
"""
from __future__ import annotations
import copy, hashlib, importlib.util, json, os, subprocess, sys, unittest
from pathlib import Path
from PIL import Image
HERE=Path(__file__).resolve().parent
ROOT=Path(os.environ.get('TP_TEST_ROOT',HERE.parent)).resolve()
sys.path.insert(0,str(ROOT/'api'))
from backend.grouping.detector_free_service import group_vertical_lens
from backend.grouping.ai_source_tree import build_ai_source_tree
from backend.grouping.adapter import adapt_grouping_result, GroupingResultError
from backend.render.lens_graph_partition import partition_vertical_lens
from backend.render.lens_graph_partition.roles import preclassify_ruby
from backend.render.lens_graph_partition.model import VerticalNode
FIX=HERE/'fixtures/grouping-balloons'

def paragraph(i,x,y=20):
    b=[x,y,x+16,y+100]
    return {'id':f'p{i}','para_index':i,'text':'本文','bounds_px':b,
            'items':[{'text':'本文','bounds_px':b,'box':{'rotation_deg':90,'height':.25}}]}

class BalloonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest=json.loads((FIX/'fixture.json').read_text())
        cls.raw=(FIX/'original_tree_raw.json').read_bytes()
        cls.tree=json.loads(cls.raw)
        cls.image=Image.new('RGB',tuple(cls.manifest['imageSize']),'white')
        cls.image.paste(Image.open(FIX/'balloons.png'),tuple(cls.manifest['crop'][:2]))

    def test_recorded_two_balloons_both_document_mapping_paths(self):
        self.assertEqual(hashlib.sha256(self.raw).hexdigest(),self.manifest['rawSha256'])
        before=copy.deepcopy(self.tree)
        for mapping in (None,list(range(len(self.tree['paragraphs'])))):
            with self.subTest(mapping='auto' if mapping is None else 'extension'):
                result=group_vertical_lens(self.tree,*self.image.size,image=self.image,raw_to_document=mapping)['grouping_result']
                canonical=build_ai_source_tree(self.tree,result)
                for members,text in zip(self.manifest['expectedRawMembers'],self.manifest['expectedText']):
                    groups=[g for g in result['groups'] if set(g['sourceContract']['rawIds'])==set(members)] if 'rawIds' in result['groups'][0]['sourceContract'] else [g for g in result['groups'] if {m['rawId'] for m in g['sourceContract']['members']}==set(members)]
                    self.assertEqual(len(groups),1, members)
                    group=groups[0]
                    self.assertEqual(group['text'],text)
                    para=next(p for p in canonical['paragraphs'] if set(p['source']['rawParagraphIndices'])=={int(x[1:]) for x in members})
                    self.assertEqual(para['text'],text)
                    if 'p10' in members:
                        ruby=next(m for m in group['sourceContract']['members'] if m['rawId']=='p10')
                        self.assertEqual(ruby['translationText'],'')
                        self.assertEqual(ruby['omission'],'whole_ruby' if mapping is None else 'ruby_text')
                        if mapping is not None:self.assertIn('p10',para['source']['documentParagraphIds'])
                self.assertTrue(canonical['coverage']['complete'])
        self.assertEqual(self.tree,before,'raw source is immutable')

    def test_extension_uses_two_translation_units_and_retains_every_geometry_owner(self):
        result=group_vertical_lens(self.tree,*self.image.size,image=self.image,raw_to_document=list(range(len(self.tree['paragraphs']))))['grouping_result']
        canonical=build_ai_source_tree(self.tree,result)
        doc={'schema':'tp.lens-document/1','image':dict(zip(('width','height'),self.image.size)),
             'paragraphs':[{'id':f'p{i}','sourceText':p['text'],'items':[]} for i,p in enumerate(self.tree['paragraphs'])]}
        js=f'''import fs from 'node:fs';import {{attachCanonicalOriginalTree,translationUnits}} from {json.dumps((ROOT/'src/shared/lens-document.js').as_uri())};
const x=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(translationUnits(attachCanonicalOriginalTree(x.doc,x.tree))));'''
        units=json.loads(subprocess.check_output(['node','--input-type=module','-e',js],input=json.dumps({'doc':doc,'tree':canonical}).encode()))
        for ids,text in zip(self.manifest['expectedRawMembers'],self.manifest['expectedText']):
            owned=[u for u in units if set(u['paragraphIds'])==set(ids)]
            self.assertEqual(len(owned),1);self.assertEqual(owned[0]['text'],text)
        all_ids=[p for u in units for p in u['paragraphIds']]
        self.assertEqual(len(all_ids),len(set(all_ids)))
        self.assertEqual(set(all_ids),{f'p{i}' for i in range(len(self.tree['paragraphs']))})

    def test_twelve_aligned_columns_have_no_three_column_width_cap(self):
        result=partition_vertical_lens({'paragraphs':[paragraph(i,600-24*i) for i in range(12)]})
        self.assertEqual(result.groups,(tuple(f'p{i}' for i in range(12)),))

    def test_drifting_heads_do_not_chain_across_all_columns(self):
        result=partition_vertical_lens({'paragraphs':[paragraph(i,600-24*i,20+14*i) for i in range(6)]})
        self.assertFalse(any(len(g)==6 for g in result.groups))

    def test_right_ruby_requires_unique_base_and_short_vertical_extent(self):
        base=VerticalNode('base',0,(100,20,124,100),'漢字',24)
        ruby=VerticalNode('ruby',1,(125,45,134,69),'もの',9)
        ordinary,attachments=preclassify_ruby([base,ruby])
        self.assertEqual([a.ruby_id for a in attachments],['ruby'])
        twin=VerticalNode('twin',2,(101,20,125,100),'別字',24)
        self.assertFalse(preclassify_ruby([base,twin,ruby])[1])
        long=VerticalNode('long',1,(125,20,134,100),'かなかな',9)
        self.assertFalse(preclassify_ruby([base,long])[1])

if __name__=='__main__':unittest.main()
