"""Exercise the canonical invocation through the actual provider adapter seam."""
from pathlib import Path
import asyncio
import copy
import hashlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import json
import sys
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai import markers
from backend.ai.clients.base import ChatResult
from backend.ai.provider_registry import provider_registry
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate
from backend.ai.translation.source_filter import prepare_source
from backend.application.ai_translation.response_mapping import map_result
from backend.jobs.stages.ai_repair import translate_with_one_repair

RUN_HTTP = '--http' in sys.argv
if RUN_HTTP:
    sys.argv.remove('--http')


class SourceFilterInvocation(unittest.TestCase):
    def invoke(self, texts, answer='I', omit=(), **overrides):
        calls = []
        config = AiConfig(api_key='fixture-key', provider='openrouter',
            model='fixture-model', thinking='default', style_examples=False, **overrides)
        def generate(request):
            calls.append(request)
            return ChatResult(text='\n'.join(f'{markers.record_open(uid)}:{answer}>>' for uid in request.expected_ids if uid not in omit),
                used_model='fixture-model', finish_reason='stop', terminal_completed=True,
                terminal_evidence='provider_done')
        with patch.object(provider_registry.require('openrouter').adapter, 'generate', side_effect=generate):
            result = translate(markers.apply(texts), 'en', config, capture_request=True)
        return result, calls, config

    def test_mixed_source_is_filtered_at_actual_adapter_boundary(self):
        texts = ['A', 'L', '-', '漢', 'ฉัน', 'ดี', 'มี', 'ที่', 'A\u0301', 'A\u200d', '漢\ufe0f', 'Hello']
        result, calls, _ = self.invoke(texts)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].source_unit_texts, ('ฉัน', 'ดี', 'มี', 'ที่', 'Hello'))
        parsed = markers.extract_paragraphs_exact(result['aiTextFull'], len(texts))
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed[0], ['A', 'L', '-', '漢', 'I', 'I', 'I', 'I', 'A\u0301', 'A\u200d', '漢\ufe0f', 'I'])
        self.assertEqual(result['meta']['sourceUnitCount'], 12)
        self.assertEqual(result['meta']['translatableUnitCount'], 5)
        self.assertEqual(result['meta']['skippedSourceUnitCount'], 7)

    def test_unicode_decision_counts_code_points_after_nfc_only(self):
        cases = {'A':False, 'L':False, '-':False, '漢':False, '12':False, '!!':False,
                 '😀😀':False, '\u200d\u2065':False, 'A\u0301':False, 'A\ufe0f':False,
                 'A\U000e0100':False, 'A\u034f':False, 'A\u115f':False, 'A\u3164':False,
                 'A\U000e0020':False, 'A\ufff0':False, 'A\u0000':False, ' A ':False,
                 'ดี':True, 'มี':True, 'ที่':True, 'ฉัน':True, '漢字':True, 'AB':True,
                 'A!':True, 'A😀':True, 'A\u0308B':True, '가':False, '\u1100\u1161':False}
        for text, eligible in cases.items():
            with self.subTest(text=repr(text)):
                self.assertEqual(markers.has_translatable_text(text), eligible)
        self.assertTrue(markers.has_letters('I'))
        self.assertTrue(markers.has_letters('漢'))

    def test_conservation_allows_one_letter_remaining_after_documented_ruby_removal(self):
        from backend.jobs.stages.ai_conservation import require_ai_input_conservation
        tree = {'paragraphs':[{'para_index':0,'text':'A','items':[]}, {'para_index':1,'text':'B','items':[]}]}
        group = {'para_indices':[0,1], 'text':'A', 'ruby_items_dropped':1, 'ruby_paragraphs_dropped':0,
            'source_contract':{'version':'tp.group-source/2','separator':'','fullParts':['A','B'],
                'translationParts':['A',''], 'members':[
                    {'rawId':'r0','rawParagraphIndex':0,'documentParagraphId':'p0','sourceText':'A','translationText':'A','rubyItemsDropped':0},
                    {'rawId':'r1','rawParagraphIndex':1,'documentParagraphId':'p1','sourceText':'B','translationText':'','rubyItemsDropped':1}]}}
        self.assertTrue(require_ai_input_conservation(tree,[group],[[0,1]],['A'])['ok'])

    def test_private_ready_model_evidence_survives_filtering_and_is_consumed_once(self):
        from backend.ai.translation_paths.batch_policy import PreparedModelEvidence
        caps = {'limits':{'contextTokens':65536,'maxOutputTokens':8192},
                'reasoning':{'supported':False,'control':'none','supported_efforts':[]}}
        config = AiConfig(api_key='', provider='lmstudio', model='fixture-model',
            base_url='http://127.0.0.1:1234', thinking='default', style_examples=False,
            page_context=[{'id':'noise','text':'A'}, {'id':'near','text':'Nearby source'}])
        evidence = PreparedModelEvidence('lmstudio', 'fixture-model', config.base_url,
            hashlib.sha256(b'').hexdigest(), caps, time.monotonic())
        config._runtime_context_evidence = evidence
        original_context = copy.deepcopy(config.page_context)
        prepared = prepare_source(markers.apply(['A','Current source']),config)
        self.assertIs(prepared.config._runtime_context_evidence,evidence)
        self.assertIs(config._runtime_context_evidence,evidence)
        self.assertEqual(config.page_context,original_context)
        self.assertFalse(evidence.used)
        requests = []
        def generate(request):
            requests.append(request)
            return ChatResult(text='<<TP_P0:I>>', used_model='fixture-model', finish_reason='stop',
                terminal_completed=True, terminal_evidence='provider_done')
        adapter = provider_registry.require('lmstudio').adapter
        with patch('backend.ai.translation.invocation.assert_ai_base_url_allowed'), \
             patch.object(adapter,'list_models') as list_models, \
             patch.object(adapter,'generate',side_effect=generate):
            result = translate(markers.apply(['A','Current source']),'en',config)
            list_models.assert_not_called()
        self.assertEqual(len(requests),1)
        self.assertEqual(requests[0].source_unit_texts,('Current source',))
        self.assertEqual(requests[0].model_capabilities['limits']['contextTokens'],65536)
        self.assertEqual(markers.extract_paragraphs_exact(result['aiTextFull'],2)[0],['A','I'])
        self.assertTrue(evidence.used)
        self.assertEqual(config.page_context,original_context)
        self.assertIsNone(evidence.consume('lmstudio','fixture-model',config.base_url,''))

    def test_skipped_only_never_generates_or_repairs_and_preserves_source(self):
        texts = ['A', 'L', '-', '漢', 'A\u0301', 'A\u200d', '  ']
        result, calls, config = self.invoke(texts, repair_enabled=True)
        self.assertEqual(calls, [])
        self.assertEqual(result['aiTextFull'], markers.apply(texts))
        self.assertEqual(result['meta']['generationAttempts'], 0)
        self.assertEqual(result['meta']['providerAttempts'], 0)
        with patch.object(provider_registry.require('openrouter').adapter, 'generate') as generate:
            repaired = translate_with_one_repair(markers.apply(texts), 'th', config, len(texts))
            generate.assert_not_called()
        self.assertEqual(repaired['meta']['generation_attempts'], 0)
        self.assertFalse(repaired['meta']['repair_attempted'])

    def test_context_pruned_even_when_current_source_already_clean(self):
        page = [{'id':'near-a', 'text':'A'}, {'id':'near-l', 'text':'L'},
                {'id':'near-dash', 'text':'-'}, {'id':'near-th', 'text':'ดี'}]
        context = [{'targetIds':['P0'], 'units':[
            {'id':'old-a','text':'A'}, {'id':'old-variant','text':'漢\ufe0f'},
            {'id':'old-ok','text':'Captured source'}], 'origin':'page_checkpoint'}]
        result, calls, config = self.invoke(['Current source'], page_context=page, source_context=context)
        self.assertEqual(config.page_context, page)
        self.assertEqual(config.source_context, context)
        request = '\n'.join(calls[0].user_parts)
        for text in ('A', 'L', '-', '漢\ufe0f'):
            self.assertNotIn(json.dumps({'text':text}, ensure_ascii=False, separators=(',', ':'))[1:-1], request)
        self.assertIn('Captured source', request)
        self.assertIn('ดี', request)

    def test_context_targets_renumbered_without_editing_text_or_caller(self):
        config = AiConfig(api_key='fixture', source_context=[
            {'targetIds':['P0'], 'units':[{'id':'old','text':'Old source'}]},
            {'targetIds':['P1','P2'], 'units':[{'id':'noise','text':'A'}, {'id':'kept','text':'A\u0308B'}]}])
        original = copy.deepcopy(config)
        prepared = prepare_source(markers.apply(['A','Hello','World']), config)
        self.assertEqual(prepared.config.source_context,
            [{'targetIds':['P0','P1'], 'units':[{'id':'kept','text':'A\u0308B'}]}])
        self.assertEqual(config, original)
        result, calls, _ = self.invoke(['A', 'A\u0308B', '漢'], answer='漢')
        self.assertEqual(calls[0].source_unit_texts, ('A\u0308B',))
        self.assertEqual(markers.extract_paragraphs_exact(result['aiTextFull'],3)[0], ['A','漢','漢'])

    def test_conversation_keeps_sparse_wire_ids_and_origin_membership(self):
        origins = [{'pageId':'image-1', 'pageOrder':7, 'unitIds':['I7_P0','I7_P1'], 'originalIds':['a','b']},
                   {'pageId':'image-2', 'pageOrder':8, 'unitIds':['I8_P0'], 'originalIds':['c']},
                   {'pageId':'image-3', 'pageOrder':9, 'unitIds':['I9_P5'], 'originalIds':['d']}]
        result, calls, config = self.invoke(['A','Hello','L','World'], translation_mode='conversation',
            conversation={'origins':origins}, source_context=[{'targetIds':['I7_P0','I7_P1','I9_P5'],
                'units':[{'id':'a','text':'A'},{'id':'b','text':'Hello'}], 'origin':'initial_request'}])
        self.assertEqual(calls[0].expected_ids, ('I7_P1','I9_P5'))
        self.assertEqual(calls[0].source_unit_texts, ('Hello','World'))
        self.assertEqual(config.conversation['origins'], origins)
        prepared = prepare_source(markers.apply(['A','Hello','L','World']), config)
        self.assertEqual(prepared.config.conversation['origins'], [
            {**origins[0], 'unitIds':['I7_P1'], 'originalIds':['b'], 'sourceFingerprint':''},
            {**origins[2], 'sourceFingerprint':''}])
        self.assertEqual(prepared.config.source_context[0]['targetIds'], ['I7_P1','I9_P5'])
        self.assertEqual(markers.extract_paragraphs_exact(result['aiTextFull'],4)[0], ['A','I','L','I'])

    def test_missing_eligible_answer_maps_to_original_position_only(self):
        result, _, _ = self.invoke(['A','Hello','L','World'], omit=('P1',))
        self.assertEqual(result['meta']['omitted_ids'], ['P3'])
        self.assertEqual(markers.extract_paragraphs_exact(result['aiTextFull'],4)[0], ['A','I','L',''])
        from backend.jobs.stages.ai_repair import _ai_answer_state
        state = _ai_answer_state(result, 4, 'en', ['A','Hello','L','World'])
        self.assertEqual(state['missing'], [3])
        self.assertEqual([row['id'] for row in state['languageDiagnostics']], ['P1','P3'])

    def test_public_result_reports_zero_attempts_and_deliberate_passthrough(self):
        texts = ['A','L','-','漢']
        result, _, config = self.invoke(texts)
        units = [{'id':f'original-{i}','text':text} for i,text in enumerate(texts)]
        body, missing, declined, passthrough = map_result(result=result, units=units,
            payload={}, target_lang='en', started=time.perf_counter(), parse_started=time.perf_counter(),
            rate_wait_ms=0, admission_wait_ms=0, provider_ms=0, route_identity={},
            rate={'enabled':False,'mode':'default'}, unlimited=True, resolved_provider='openrouter',
            config=config, prompt_meta={})
        self.assertEqual(missing, [])
        self.assertEqual(declined, [])
        self.assertEqual(passthrough, [row['id'] for row in units])
        self.assertEqual(body['meta']['generationAttempts'], 0)
        self.assertEqual(body['meta']['providerAttempts'], 0)
        self.assertEqual(body['meta']['providerHttpStatuses'], [])
        self.assertEqual(body['meta']['skippedUnitIds'], [row['id'] for row in units])
        self.assertEqual(body['memoryDelta']['glossary'], [])
        self.assertEqual(body['translations'], [{'id':row['id'], 'text':row['text'],
            'hash':__import__('backend.application.ai_request',fromlist=['unit_hash']).unit_hash(row['text'])} for row in units])


class SourceFilterRepairPool(unittest.TestCase):
    def prepare_task(self, texts):
        from backend.application.repair_pool import state as s
        run = s.new_run('filter-pool',['page'],0)
        s.record_page(run, {'pageId':'page','generationId':'initial','groupKey':'1'*64,
            'status':'finished','failed':[{'id':f'g{i}','text':text,'sourceHash':s.source_hash(text),
                'reason':'not_sent'} for i,text in enumerate(texts)]})
        s.seal(run)
        ids = list(run['units'])
        s.claim(run, {'taskId':'task','executor':'fixture','route':'server','ids':ids})
        s.begin(run,'task','fixture')
        return run, ids

    def test_actual_owned_consumer_resolves_deliberate_skip_without_missing_or_repair_count(self):
        from backend.application.repair_pool import state as s
        run, ids = self.prepare_task(['A','Meaningful source'])
        task = s.answer_task(run,'task', {'translations':[{'id':ids[1],'text':'I'}],
            'meta':{'skippedUnitIds':[ids[0]],'generationAttempts':1,'providerAttempts':1}})
        self.assertEqual(task['answer']['missing'],[])
        self.assertEqual(task['answer']['meta']['skippedUnitIds'],ids[:1])
        snapshot = s.complete(run,'task',{'accepted':ids[1:]})
        self.assertEqual(snapshot['phase'],'done')
        self.assertEqual(snapshot['unresolved'],0)
        self.assertEqual(snapshot['repaired'],1)
        self.assertEqual(snapshot['skippedUnits'],1)
        self.assertEqual(snapshot['skipped'][0]['text'],'A')
        self.assertNotIn('translation',snapshot['skipped'][0])
        self.assertEqual([row['unitId'] for row in snapshot['results']],['g1'])

    def test_all_skipped_receipt_recovers_with_zero_attempts_and_idempotent_commit(self):
        from backend.application.repair_pool import state as s
        run, ids = self.prepare_task(['A','L','-','漢'])
        answer = {'translations':[], 'meta':{'skippedUnitIds':ids,
            'generationAttempts':0,'providerAttempts':0}}
        s.answer_task(run,'task',answer)
        recovered = s.task_view(run,run['tasks']['task'])
        self.assertEqual(recovered['answer']['missing'],[])
        self.assertEqual(recovered['answer']['meta']['generationAttempts'],0)
        self.assertEqual(recovered['answer']['meta']['providerAttempts'],0)
        first = s.complete(run,'task',{'accepted':[]})
        replay = s.complete(run,'task',{'accepted':ids})
        self.assertEqual(first,replay)
        self.assertEqual(first['phase'],'done')
        self.assertEqual(first['unresolved'],0)
        self.assertEqual(first['repaired'],0)
        self.assertEqual(first['skippedUnits'],4)

    def test_skip_cannot_bypass_owned_source_or_identity_or_quarantine(self):
        from backend.application.repair_pool import state as s
        for meta in ({'skippedUnitIds':['R1']}, {'skippedUnitIds':['R999']},
                     {'skippedUnitIds':['R0','R0']}, {'skippedUnitIds':'R0'},
                     {'skippedUnitIds':['R0'],'alignmentUncertainIds':['R0']}):
            with self.subTest(meta=meta):
                run, _ = self.prepare_task(['A','Meaningful source'])
                with self.assertRaises(s.PoolError):
                    s.answer_task(run,'task',{'translations':[],'meta':meta})
                self.assertEqual(run['tasks']['task']['state'],'running')

    def test_answered_legacy_receipt_resumes_and_replays_without_ai_or_hash_conflict(self):
        from backend.application.repair_pool import state as s
        run, ids = self.prepare_task(['A','Meaningful source'])
        legacy = {'schema':'tp.ai.result/1','translations':[{'id':'R0','text':'Old answer'},
            {'id':'R1','text':'I'}], 'missing':[], 'meta':{'generationAttempts':1,'providerAttempts':1}}
        task = run['tasks']['task']
        task.update(state='answered',answer=copy.deepcopy(legacy),answerHash=s.fingerprint(legacy))
        with patch.object(provider_registry.require('openrouter').adapter,'generate') as generate:
            recovered = s.answer_task(run,'task',copy.deepcopy(legacy))
            self.assertEqual(recovered['answer']['meta']['skippedUnitIds'],['R0'])
            first = s.complete(run,'task',{'accepted':['R1']})
            replay = s.complete(run,'task',{'accepted':['R0','R1']})
            s.answer_task(run,'task',copy.deepcopy(legacy))
            generate.assert_not_called()
        self.assertEqual(first,replay)
        self.assertEqual(first['unresolved'],0)
        self.assertEqual(first['skippedUnits'],1)
        self.assertEqual(first['repaired'],1)
        self.assertEqual(task['answer']['meta']['generationAttempts'],1)
        self.assertEqual(task['answer']['meta']['providerAttempts'],1)
        changed = copy.deepcopy(legacy); changed['translations'][1]['text']='Changed meaningful answer'
        with self.assertRaisesRegex(s.PoolError,'repair_answer_conflict'):
            s.answer_task(run,'task',changed)

    def test_legacy_quarantined_singleton_stays_unresolved(self):
        from backend.application.repair_pool import state as s
        run, _ = self.prepare_task(['A','Meaningful source'])
        legacy = {'schema':'tp.ai.result/1','translations':[{'id':'R1','text':'I'}], 'missing':['R0'],
            'meta':{'alignmentUncertainIds':['R0'],'generationAttempts':1,'providerAttempts':1}}
        run['tasks']['task'].update(state='answered',answer=legacy,answerHash=s.fingerprint(legacy))
        done = s.complete(run,'task',{'accepted':['R1']})
        self.assertEqual(done['unresolved'],1)
        self.assertEqual(done['skippedUnits'],0)
        self.assertEqual(done['tasks'][0]['answer']['meta']['alignmentUncertainIds'],['R0'])

    def test_legacy_complete_itself_reclassifies_answered_and_done_receipts(self):
        from backend.application.repair_pool import state as s
        for route, previous_state in (('server','answered'), ('direct-local','answered'), ('server','done')):
            with self.subTest(route=route,previous_state=previous_state):
                run, _ = self.prepare_task(['A','Meaningful source'])
                legacy = {'schema':'tp.ai.result/1','translations':[{'id':'R0','text':'Old answer'},
                    {'id':'R1','text':'I'}], 'missing':[], 'meta':{'generationAttempts':1,'providerAttempts':1}}
                task = run['tasks']['task']
                task.update(route=route,state=previous_state,answer=copy.deepcopy(legacy),answerHash=s.fingerprint(legacy))
                if previous_state=='done':
                    task['accepted'] = ['R0','R1']; run['phase'] = 'done'
                    for alias in task['ids']:
                        run['units'][alias].update(state='repaired',translation='Old answer' if alias=='R0' else 'I')
                body = {'accepted':['R0','R1']}
                if route=='direct-local':
                    body['answer'] = copy.deepcopy(legacy)
                with patch.object(provider_registry.require('openrouter').adapter,'generate') as generate:
                    done = s.complete(run,'task',body)
                    replay = s.complete(run,'task',body)
                    generate.assert_not_called()
                self.assertEqual(done,replay)
                self.assertEqual(done['phase'],'done')
                self.assertEqual(done['unresolved'],0)
                self.assertEqual(done['skippedUnits'],1)
                self.assertEqual(done['repaired'],1)
                self.assertNotIn('translation',done['skipped'][0])
                self.assertEqual(task['accepted'],['R1'])
                self.assertEqual(task['answer']['meta']['generationAttempts'],1)

    def test_legacy_task_view_projects_canonical_skip_without_mutating_receipt_hash(self):
        from backend.application.repair_pool import state as s
        for previous_state in ('answered','done'):
            with self.subTest(previous_state=previous_state):
                run, _ = self.prepare_task(['A','Meaningful source'])
                legacy = {'schema':'tp.ai.result/1','translations':[{'id':'R0','text':'Old answer'},
                    {'id':'R1','text':'I'}], 'missing':[], 'meta':{'generationAttempts':1,'providerAttempts':1}}
                task = run['tasks']['task']
                task.update(state=previous_state,answer=legacy,answerHash=s.fingerprint(legacy))
                before = copy.deepcopy(run)
                projected = s.task_view(run,task)
                self.assertEqual(projected['answer']['translations'],[{'id':'R1','text':'I'}])
                self.assertEqual(projected['answer']['missing'],[])
                self.assertEqual(projected['answer']['meta']['skippedUnitIds'],['R0'])
                self.assertEqual(projected['answer']['meta']['generationAttempts'],1)
                self.assertEqual(projected['answer']['meta']['providerAttempts'],1)
                self.assertEqual(projected['answerHash'],before['tasks']['task']['answerHash'])
                self.assertEqual(s.view(run)['tasks'][0]['answer'],projected['answer'])
                self.assertEqual(run,before)


@unittest.skipUnless(RUN_HTTP, 'Run --http in a runtime that permits asyncio loopback sockets')
class SourceFilterHttp(unittest.TestCase):
    def test_actual_repair_http_maps_wire_skip_ids_to_owned_receipt_aliases(self):
        import httpx
        from fastapi import FastAPI
        from backend.api.routes import repair_runs as routes
        from backend.application.repair_pool import state as s
        from backend.application.repair_pool.store import RepairStore
        calls = []
        def generate(request):
            calls.append(request)
            return ChatResult(text='\n'.join(f'{markers.record_open(uid)}:I>>' for uid in request.expected_ids),
                used_model='fixture-model', finish_reason='stop', terminal_completed=True,
                terminal_evidence='provider_done')
        class Gate:
            @asynccontextmanager
            async def slot(self, _):
                yield
        app = FastAPI(); app.include_router(routes.router); app.state.ai_admission_gate = Gate()
        headers = {'X-TP-Run-Token':'a'*64,'X-TP-Tab-Session':'filter-repair-10438'}
        base = '/v2/engine/runsextension/repair-runs'
        with ThreadPoolExecutor(max_workers=1) as executor:
            app.state.ai_executor = executor
            async def exercise():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture.invalid', headers=headers) as client:
                    for number, texts in enumerate((['A','Meaningful source'], ['A','L'])):
                        run_id, page = f'filter-r{number}', f'filter-page-{number}'
                        async def post(suffix, body):
                            response = await client.post(base+suffix,json=body)
                            self.assertEqual(response.status_code,200,response.text)
                            return response.json()
                        await post('',{'runId':run_id,'manifest':[page]})
                        await post(f'/{run_id}/pages',{'pageId':page,'generationId':'legacy',
                            'groupKey':'1'*64,'status':'finished','failed':[{'id':f'g{i}','text':text,
                                'sourceHash':s.source_hash(text),'reason':'not_sent'} for i,text in enumerate(texts)]})
                        await post(f'/{run_id}/seal',{})
                        await post(f'/{run_id}/claim',{'taskId':'task','executor':'fixture','route':'server','ids':['R0','R1']})
                        image = 81+number
                        wire = [f'I{image}_P0',f'I{image}_P1']
                        request = {'translationMode':'conversation','units':[{'id':uid,'text':text} for uid,text in zip(wire,texts)],
                            'targetLang':'en','provider':{'id':'openrouter','model':'fixture-model','apiKey':'fixture-key','thinking':'default'},
                            'memory':{'mode':'off','styleExamples':False},
                            'conversation':{'documentId':run_id,'origins':[{'pageId':page,'pageOrder':image,
                                'unitIds':wire,'originalIds':['R0','R1']}]}}
                        before = len(calls)
                        reply = await post(f'/{run_id}/tasks/task/translate',request)
                        skipped = ['R0'] if number==0 else ['R0','R1']
                        self.assertEqual(reply['meta']['skippedUnitIds'],skipped)
                        self.assertEqual(len(calls)-before,1 if number==0 else 0)
                        if number==0:
                            self.assertEqual(calls[-1].expected_ids,(wire[1],))
                        saved = (await client.get(base+f'/{run_id}')).json()['tasks'][0]['answer']
                        self.assertEqual(saved['meta']['skippedUnitIds'],skipped)
                        self.assertEqual(saved['missing'],[])
                        self.assertEqual(saved['meta']['generationAttempts'],1 if number==0 else 0)
                        self.assertEqual(saved['meta']['providerAttempts'],1 if number==0 else 0)
                        done = await post(f'/{run_id}/tasks/task/complete',{'accepted':['R1'] if number==0 else []})
                        self.assertEqual(done['phase'],'done')
                        self.assertEqual(done['unresolved'],0)
                        self.assertEqual(done['skippedUnits'],len(skipped))
                        self.assertEqual([row['text'] for row in done['skipped']],[texts[i] for i in range(len(skipped))])
            with patch.object(routes,'store',RepairStore()), \
                 patch.object(provider_registry.require('openrouter').adapter, 'generate', side_effect=generate):
                asyncio.run(exercise())

    def test_actual_alias_and_canonical_routes_with_filtered_and_skipped_source(self):
        import httpx
        from fastapi import FastAPI
        from backend.api.routes.ai_v1 import router
        calls = []
        def generate(request):
            calls.append(request)
            return ChatResult(text='\n'.join(f'{markers.record_open(uid)}:I>>' for uid in request.expected_ids),
                used_model='fixture-model', finish_reason='stop', terminal_completed=True,
                terminal_evidence='provider_done')
        class Gate:
            @asynccontextmanager
            async def slot(self, _):
                yield
        app = FastAPI(); app.include_router(router); app.state.ai_admission_gate = Gate()
        def payload(texts, mode='independent', ids=None, page=1):
            ids = ids or [f'opaque-{i}' for i in range(len(texts))]
            return {'schema':'tp.ai.request/1','translationMode':mode,
                'units':[{'id':uid,'text':text} for uid,text in zip(ids,texts)],
                'sourceLang':'th','targetLang':'en',
                'provider':{'id':'openrouter','model':'fixture-model','apiKey':'fixture-key','thinking':'default'},
                'memory':{'mode':'off','styleExamples':False},
                'repair':{'owner':'extension','enabled':False},
                **({'conversation':{'documentId':'filter-10438','pageId':f'image-{page}',
                    'pageOrder':page,'origins':[{'pageId':f'image-{page}','pageOrder':page,
                        'unitIds':ids,'originalIds':[f'original-{i}' for i in range(len(ids))]}]},
                    'context':{'tp_tab_session':'filter-http-10438'}} if mode=='conversation' else {})}
        with ThreadPoolExecutor(max_workers=1) as executor:
            app.state.ai_executor = executor
            async def exercise():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture.invalid') as client:
                    for route in ('/v1/ai/translate','/v2/engine/runsextension/ai/translate'):
                        before = len(calls)
                        mixed = payload(['A','ฉัน','L','ดี','-','ที่'])
                        mixed['pageContext'] = [{'id':'old-a','text':'A'},{'id':'old-ok','text':'Context text'}]
                        mixed['sourceContext'] = [{'targetIds':['opaque-0','opaque-1'],
                            'units':[{'id':'a','text':'A'},{'id':'hello','text':'Captured text'}]}]
                        reply = await client.post(route, json=mixed)
                        self.assertEqual(reply.status_code, 200, reply.text)
                        body = reply.json()
                        self.assertEqual(len(calls), before+1)
                        self.assertEqual(calls[-1].source_unit_texts, ('ฉัน','ดี','ที่'))
                        self.assertEqual([row['id'] for row in body['translations']], [row['id'] for row in mixed['units']])
                        self.assertEqual([row['text'] for row in body['translations']], ['A','I','L','I','-','I'])
                        self.assertEqual(body['missing'], [])
                        self.assertEqual(body['meta']['passthroughUnits'], 3)
                        self.assertEqual(body['meta']['generationAttempts'], 1)
                        self.assertNotIn('"text":"A"', '\n'.join(calls[-1].user_parts))
                        skipped = await client.post(route, json=payload(['A','L','-','漢']))
                        self.assertEqual(skipped.status_code, 200, skipped.text)
                        self.assertEqual(len(calls), before+1)
                        self.assertEqual(skipped.json()['meta']['generationAttempts'], 0)
                        self.assertEqual(skipped.json()['meta']['providerAttempts'], 0)
                        self.assertEqual(skipped.json()['missing'], [])
                    for page in (41,42):
                        ids = [f'I{page}_P0',f'I{page}_P1']
                        reply = await client.post('/v2/engine/runsextension/ai/translate',
                            json=payload(['A','Current source'], 'conversation', ids, page))
                        self.assertEqual(reply.status_code,200,reply.text)
                        self.assertEqual(calls[-1].expected_ids,(ids[1],))
                        self.assertEqual([row['id'] for row in reply.json()['translations']],ids)
                        for previous in calls[-1].history_messages:
                            self.assertNotIn('<<I41_P0:A>>', previous['text'])
                        self.assertEqual(reply.json()['meta']['passthroughUnits'],1)
                    self.assertTrue(calls[-1].history_messages)
                    before = len(calls)
                    bad = payload(['A'], 'conversation', ['I43_P0'], 43)
                    bad['conversation']['origins'][0]['unitIds'] = ['I43_P1']
                    reply = await client.post('/v2/engine/runsextension/ai/translate', json=bad)
                    self.assertEqual(reply.status_code,400,reply.text)
                    self.assertEqual(len(calls),before)
            with patch.object(provider_registry.require('openrouter').adapter, 'generate', side_effect=generate):
                asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main(verbosity=2)
