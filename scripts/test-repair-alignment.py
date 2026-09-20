"""Repair quarantine at decoder, API mapping and recoverable receipt boundaries.

No model calls or semantic-scoring heuristics. Test cases deliberately include
usable records on other images and valid sparse IDs to prevent blanket rejection.
"""
import json
import sys
import time
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai import markers
from backend.ai.clients.base import ChatResult
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.result_decode import decode_result
from backend.ai.repair_alignment import uncertain_repair_ids
from backend.application.ai_translation.response_mapping import map_result
from backend.application.repair_pool import state as s
from backend.application.repair_pool.store import RepairStore

IDS = ['I10_P11', 'I26_P23', 'I26_P28', 'I26_P29', 'I26_P30']
RAW = '\n'.join(['<<I10_P11:ประเมินสถานการณ์ต่ำไป>>', '<<I26_P11:บทถัดไป>>',
    '<<I26_P23:เดินเล่นในเมืองด้วยกัน>>', '<<I26_P28:โซระ>>',
    '<<I26_P29:อิสึกิ>>', '<<I26_P30:นำเสนอโดยโซระ>>'])

def decode(raw=RAW, ids=IDS, branch='repair'):
    return decode_result(result=ChatResult(text=raw, used_model='fixture',
        input_tokens=100, output_tokens=20, total_tokens=120, cached_input_tokens=64,
        finish_reason='stop', usage_source='provider', terminal_completed=True,
        terminal_evidence='provider_done'), ids=ids, provider='openrouter',
        base_url='https://openrouter.ai/api/v1', used_model='fixture', target_lang='th',
        ai=AiConfig(api_key='', translation_mode='conversation', conversation={'branch':branch}),
        context_frozen=True, selected_wire_contract='tp.translation.compact-records/1',
        want_memo=False, image_b64='', thinking_selected='off', thinking_applied='off',
        system_text='fixture', user_parts=[], capture_request=True, is_retry=False)

class AlignmentTest(unittest.TestCase):
    def test_sparse_expected_and_uncertainty_matrix(self):
        for extra, expected in [([],[]),(['I26_P11'],IDS[1:]),(['I10_P7'],IDS[:1]),
            (['I10_P7','I26_P11'],IDS),(['I90_P0'],IDS),(['P0'],IDS),(['I26_P23'],[])]:
            with self.subTest(extra=extra): self.assertEqual(uncertain_repair_ids(IDS,extra),expected)
        self.assertEqual(uncertain_repair_ids(['P0','P5'],['P4']),['P0','P5'])
        self.assertEqual(uncertain_repair_ids(['P0','P5'],[]),[])
    def test_decode_rejects_affected_image_not_safe_one_or_usage(self):
        out=decode();parts=markers.extract_paragraphs_exact(out['aiTextFull'],len(IDS))[0]
        self.assertTrue(parts[0]);self.assertEqual(parts[1:],['']*4)
        self.assertEqual(out['meta']['alignment_uncertain_ids'],IDS[1:])
        self.assertEqual(out['meta']['ignored_output_ids'],['I26_P11'])
        self.assertEqual(out['meta']['omitted_ids'],IDS[1:])
        self.assertEqual(out['meta']['usage']['cachedInputTokens'],64)
        self.assertEqual(out['meta']['usage']['totalTokens'],120)
        self.assertEqual(out['meta']['debug_response_raw'],RAW)
        self.assertTrue(out['meta']['terminal_completed'])
        self.assertFalse(out['meta']['accepted_losslessly'])
        self.assertTrue(out['meta']['content_modified'])
    def test_same_body_initial_still_uses_existing_contract(self):
        out=decode(branch='initial');parts=markers.extract_paragraphs_exact(out['aiTextFull'],len(IDS))[0]
        self.assertTrue(all(parts));self.assertEqual(out['meta']['alignment_uncertain_ids'],[])
    def test_valid_sparse_or_missing_only_does_not_trigger(self):
        raw='\n'.join(f'<<{uid}:คำแปล>>' for uid in IDS)
        self.assertEqual(decode(raw)['meta']['alignment_uncertain_ids'],[])
        out=decode('\n'.join(raw.splitlines()[:-1]))
        self.assertEqual(out['meta']['alignment_uncertain_ids'],[])
        self.assertEqual(out['meta']['omitted_ids'],IDS[-1:])
    def test_neutral_passthrough_cannot_restore_quarantined_translation(self):
        out=decode();units=[dict(id=x,text='123' if x==IDS[-1] else 'Source text') for x in IDS]
        body, missing, declined, passthrough=map_result(result=out, units=units,payload={},target_lang='th',
            started=time.perf_counter(),parse_started=time.perf_counter(),rate_wait_ms=0,
            admission_wait_ms=0,provider_ms=10,route_identity={},rate={'mode':'provider_managed'},
            unlimited=True,resolved_provider='openrouter',config=AiConfig(api_key=''),prompt_meta={})
        self.assertEqual([t['id'] for t in body['translations']],IDS[:1])
        self.assertEqual(missing,IDS[1:]);self.assertEqual(declined,[]);self.assertEqual(passthrough,[])
        self.assertEqual(body['meta']['alignmentUncertainIds'],IDS[1:])
        self.assertEqual(body['meta']['usage']['totalTokens'],120)
    def test_receipt_metadata_sanitized_and_retained(self):
        answer={'translations':[{'id':'R0','text':'ไทย'}], 'meta': {
            'alignmentUncertainIds':['R0'], 'alignmentStatus':'incorrect_external_status',
            'contractDiagnostics':{'ignoredUnknownIds':['I26_P11','secret','I26_P11',None,{}],
                'duplicateIds':['P0'], 'raw':'PRIVATE'},'api_key':'SECRET'}}
        clean=s.normalized_answer(answer,['R0'])
        self.assertEqual(clean['meta']['alignmentUncertainIds'],['R0'])
        self.assertEqual(clean['meta']['contractDiagnostics'],{'ignoredUnknownIds':['I26_P11'],'duplicateIds':['P0']})
        self.assertEqual(clean['meta']['alignmentStatus'],'uncertain')
        self.assertNotIn('SECRET',json.dumps(clean));self.assertNotIn('PRIVATE',json.dumps(clean))
        for invalid in [None,{},['I26_P23'],[[]]]:
            with self.subTest(invalid=invalid),self.assertRaises(s.PoolError):
                s.normalized_answer({'meta':{'alignmentUncertainIds':invalid}},['R0'])
    def test_recovered_receipt_cannot_be_marked_success_by_old_client(self):
        db=RepairStore();token='a'*64;group='1'*64
        db.register('run',token,['p0'],'owner')
        page=dict(pageId='p0',generationId='gen0',groupKey=group,status='finished',initialAccepted=0,unverified=0,
            failed=[dict(id=f'g{k}',text='source '+str(k),sourceHash=s.source_hash('source '+str(k)),reason='missing') for k in range(2)])
        db.transact('run',token,lambda r:s.record_page(r,page));db.transact('run',token,s.seal)
        db.transact('run',token,lambda r:s.claim(r,dict(taskId='t',executor='w',route='server',ids=['R0','R1'])))
        db.transact('run',token,lambda r:s.begin(r,'t','w'))
        answer={'translations':[{'id':'R0','text':'ไม่แน่ใจ'},{'id':'R1','text':'คำแปล'}],
            'meta':{'alignmentUncertainIds':['R0'],'contractDiagnostics':{'ignoredUnknownIds':['I26_P11']},
                'usage':{'inputTokens':100,'outputTokens':20}}}
        for _ in range(2): db.transact('run',token,lambda r:s.answer_task(r,'t',answer))
        restored=db.read('run',token)['tasks'][0]['answer']
        self.assertEqual(restored['meta']['alignmentUncertainIds'],['R0'])
        with self.assertRaisesRegex(s.PoolError,'repair_alignment_uncertain'):
            db.transact('run',token,lambda r:s.complete(r,'t',{'accepted':['R0','R1']}))
        for _ in range(2): final=db.transact('run',token,lambda r:s.complete(r,'t',{'accepted':['R1']}))
        self.assertEqual(final['repaired'],1);self.assertEqual(final['unresolved'],1)
        self.assertEqual(final['phase'],'done')

if __name__ == '__main__': unittest.main(verbosity=2)
