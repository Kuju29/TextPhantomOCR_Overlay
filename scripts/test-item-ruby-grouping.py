"""Item-level ruby regression. Constructed Lens geometry, NOT the user's absent raw tree.
The recorded two-balloon geometry remains covered by test-grouping-balloons.py.
"""
from __future__ import annotations
import copy, json, os, subprocess, sys, unittest
from pathlib import Path
from PIL import Image, ImageDraw
ROOT=Path(os.environ.get('TP_TEST_ROOT',Path(__file__).resolve().parents[1])).resolve()
sys.path.insert(0,str(ROOT/'api'))
from backend.render.lens_graph_partition.item_roles import infer_item_ruby
from backend.render.lens_graph_partition.nodes import extract_nodes
from backend.grouping.detector_free_service import group_vertical_lens
from backend.grouping.ai_source_tree import build_ai_source_tree


def item(text,x,y,w,h):
    return {'text':text,'bounds_px':[x,y,x+w,y+h], 'box':{'rotation_deg':0},
            'height_raw':h/600,'baseline_p1':{'x':x/800,'y':(y+h/2)/600},
            'baseline_p2':{'x':(x+w)/800,'y':(y+h/2)/600}}

def para(i,items):
    bb=[it['bounds_px'] for it in items]
    return {'id':f'p{i}','para_index':i,'text':''.join(it['text'] for it in items),
            'bounds_px':[min(b[0] for b in bb),min(b[1] for b in bb),max(b[2] for b in bb),max(b[3] for b in bb)],'items':items}

def fixture():
    return {'paragraphs':[
        para(0,[item('大好きで嫌われたく',200,40,24,240),item('だい',225,40,8,24),item('きら',225,150,8,24)]),
        para(1,[item('なかったから',166,42,24,190)]),
        para(2,[item('憧れてた',70,400,24,150)]),
    ]}

class RubyTests(unittest.TestCase):
    def test_ruby_is_item_addressed_and_measurement_uses_main_column(self):
        tree=fixture();before=copy.deepcopy(tree);roles=infer_item_ruby(tree)
        self.assertEqual(roles,{'p0':(1,2)})
        nodes=extract_nodes(tree,item_exclusions=roles)
        self.assertEqual(nodes[0].bounds,(200.,40.,224.,280.))
        self.assertEqual(nodes[0].glyph_px,24.)
        self.assertEqual(tree,before)

    def test_mixed_ruby_no_longer_changes_main_font_or_splits_neighbour(self):
        tree=fixture();before=copy.deepcopy(tree)
        for mapping in (None,[0,1,2]):
            result=group_vertical_lens(tree,800,600,image=Image.new('RGB',(800,600),'white'),raw_to_document=mapping)['grouping_result']
            g=next(g for g in result['groups'] if set(m['rawId'] for m in g['sourceContract']['members'])=={'p0','p1'})
            self.assertEqual(g['text'],'大好きで嫌われたくなかったから')
            self.assertEqual(g['fontPx'],24.)
            self.assertEqual(g['rubyItemsDropped'],2)
            self.assertEqual(len(g['sourceContract']['members']),2)
            self.assertIn('だい',g['sourceContract']['members'][0]['sourceText'])
            source=build_ai_source_tree(tree,result);self.assertTrue(source['coverage']['complete'])
        self.assertEqual(tree,before)

    def test_canonical_js_boundary_preserves_all_geometry_and_native_text(self):
        tree=fixture();result=group_vertical_lens(tree,800,600,raw_to_document=[0,1,2])['grouping_result']
        canonical=build_ai_source_tree(tree,result)
        doc={'schema':'tp.lens-document/1','image':{'width':800,'height':600},
             'paragraphs':[{'id':p['id'],'sourceText':p['text'],'items':[]} for p in tree['paragraphs']]}
        js=f'''import fs from 'node:fs';import {{attachCanonicalOriginalTree,translationUnits}} from {json.dumps((ROOT/'src/shared/lens-document.js').as_uri())};
const x=JSON.parse(fs.readFileSync(0,'utf8'));const doc=attachCanonicalOriginalTree(x.doc,x.tree);console.log(JSON.stringify({{units:translationUnits(doc),paragraphs:doc.paragraphs}}));'''
        value=json.loads(subprocess.check_output(['node','--input-type=module','-e',js],input=json.dumps({'tree':canonical,'doc':doc}).encode()))
        self.assertEqual([p['sourceText'] for p in value['paragraphs']],[p['text'] for p in tree['paragraphs']])
        ids=[p for u in value['units'] for p in u['paragraphIds']]
        self.assertCountEqual(ids,['p0','p1','p2']);self.assertEqual(len(ids),len(set(ids)))
        self.assertEqual(value['units'][0]['text'],'大好きで嫌われたくなかったから')

    def test_ambiguous_or_not_ruby_has_no_automatic_omission(self):
        for mode in ('left','long','same_size','latin','ambiguous','different_container'):
            t=fixture();it=t['paragraphs'][0]['items'][1]
            t['paragraphs'][0]['items']=t['paragraphs'][0]['items'][:2]
            if mode=='left':it['bounds_px']=[189,40,197,64]
            elif mode=='long':it['bounds_px']=[225,40,233,280]
            elif mode=='same_size':it['bounds_px']=[225,40,249,120]
            elif mode=='latin':it['text']='note'
            elif mode=='ambiguous':t['paragraphs'].append(para(3,[item('大事な本文',201,40,24,240)]))
            else:
                main=t['paragraphs'][0]['items'].pop(0)
                t['paragraphs'][0]['container_id']='annotation'
                t['paragraphs'][0]['items'].append(item('メモ',300,500,10,30))
                base=para(3,[main]);base['container_id']='other';t['paragraphs'].append(base)
            with self.subTest(mode=mode):self.assertNotIn(1 if mode!='different_container' else 0,infer_item_ruby(t).get('p0',()))

    def test_furigana_in_other_mixed_paragraph_can_attach_to_unique_base(self):
        t=fixture();r=t['paragraphs'][0]['items'].pop(1)
        t['paragraphs'][1]['items'].insert(0,r)
        roles=infer_item_ruby(t)
        self.assertEqual(roles['p1'],(0,))

    def test_short_square_ruby_does_not_flip_whole_paragraph_orientation(self):
        t=fixture()
        for it in t['paragraphs'][0]['items'][1:]:
            it['text']='だ';it['bounds_px'][3]=it['bounds_px'][1]+8
        r=group_vertical_lens(t,800,600)['grouping_result']
        g=next(g for g in r['groups'] if len(g['sourceContract']['members'])==2)
        self.assertEqual(g['direction'],'v')
        self.assertEqual(g['text'],'大好きで嫌われたくなかったから')

    def test_head_mismatch_and_real_separator_still_prevent_merge(self):
        for mode in ('head','line'):
            t={'paragraphs':[para(0,[item('本文',200,40,24,240)]),para(1,[item('別本文',166,42 if mode=='line' else 140,24,190)])]}
            image=Image.new('RGB',(800,600),'white')
            if mode=='line':ImageDraw.Draw(image).line((195,0,195,340),fill='black',width=3)
            r=group_vertical_lens(t,800,600,image=image)['grouping_result']
            with self.subTest(mode=mode):self.assertEqual(len(r['groups']),2)

if __name__=='__main__':unittest.main()
