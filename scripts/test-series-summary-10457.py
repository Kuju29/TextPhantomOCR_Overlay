"""Same-call summary/continuation acceptance; all provider replies synthetic."""
from pathlib import Path
import sys, importlib.util, unittest
from dataclasses import replace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
fixture=importlib.util.spec_from_file_location('conversation_fixture',Path(__file__).with_name('test-conversation-paths.py'))
m=importlib.util.module_from_spec(fixture);fixture.loader.exec_module(m)
from backend.ai.providers.openai_provider_runtime import build_messages
from backend.ai.series_summary import split_summary
from backend.ai import markers
class SummaryConversationTests(unittest.TestCase):
    setUp=m.ConversationTests.setUp
    call=m.ConversationTests.call
    def record(self,text,index):
        uid=f"I{index}_P0"
        self.ai=replace(self.ai,conversation={**self.ai.conversation,"origins":[{"pageId":f"page-{index}","pageIndex":index-1,"unitIds":[uid],"originalIds":["P0"]}]})
        self.next_answer=self.next_answer.replace("TP_P0",uid)
        return self.call(text)
    def test_full_first_anchor_next_source_only_and_accepted_footer_history(self):
        self.ai=replace(self.ai,memory_mode='full',series_state='PRIOR_CHAPTER_SEED')
        self.next_answer='<<TP_P0:คำแปล>>\n<<TP_MEMO:พระเอกพบกุญแจ>>'
        first=self.record('First source',1)
        self.next_answer='<<TP_P0:คำแปล>>\n<<TP_MEMO:พระเอกพบกุญแจ>>'
        second=self.record('Next source',2)
        self.assertEqual(first['meta']['seriesSummaries'],['พระเอกพบกุญแจ'])
        self.assertNotIn('TP_MEMO',first['aiTextFull'])
        a,b=[build_messages(r) for r in self.requests]
        self.assertIn('TP_MEMO',a[-1]['content']);self.assertIn('H01\nEN:',a[-1]['content'])
        self.assertIn('PRIOR_CHAPTER_SEED',a[-1]['content'])
        self.assertNotIn('TP_MEMO',b[-1]['content']);self.assertNotIn('H01\nEN:',b[-1]['content'])
        self.assertNotIn('PRIOR_CHAPTER_SEED',b[-1]['content']);self.assertIn('Next source',b[-1]['content'])
        self.assertIn('<<TP_MEMO:พระเอกพบกุญแจ>>',b[2]['content'])
        self.assertEqual(len(self.requests),2);self.assertEqual(first['meta']['usage']['totalTokens'],110)
    def test_invalid_optional_footer_does_not_fail_or_poison_history(self):
        self.ai=replace(self.ai,memory_mode='full')
        self.next_answer='<<TP_P0:คำแปล>>\n<<TP_MEMO:a>>\n<<TP_MEMO:b>>\n<<TP_MEMO:c>>'
        first=self.record('First',1)
        self.next_answer='<<TP_P0:คำแปล>>\n<<TP_MEMO:a>>\n<<TP_MEMO:b>>\n<<TP_MEMO:c>>'
        second=self.record('Second',2)
        self.assertNotIn('seriesSummary',first['meta']);self.assertNotIn('TP_MEMO',first['aiTextFull'])
        self.assertNotIn('TP_MEMO',build_messages(self.requests[1])[2]['content'])
        self.assertEqual(first['meta']['conversation']['commitStatus'],'committed')
        self.assertEqual(len(self.requests),2)
    def test_missing_provider_terminal_never_learns_or_commits(self):
        self.ai=replace(self.ai,memory_mode='full');self.complete=False
        self.next_answer='<<TP_P0:คำแปล>>\n<<TP_MEMO:เหตุการณ์>>'
        with self.assertRaises(Exception):self.call('First')
        self.complete=True;self.call('Retry new source')
        self.assertEqual(len(build_messages(self.requests[1])),2)
    def test_marker_parser_preserves_ids_and_removes_only_reserved_memo(self):
        base='<<TP_P0:คำแปล>>'
        for footer in ['<<TP_MEMO: >>','<<TP_MEMO:a\nb>>','<<TP_MEMO:'+('x'*801)+'>>','<<TP_MEMO:unfinished']:
            clean,summary,status=split_summary(base+'\n'+footer,enabled=True)
            self.assertFalse(summary);self.assertEqual(status,'invalid')
            decoded=markers.decode_translation_response(clean,['P0'],require_complete=True,allow_complete_without_end=True)
            self.assertEqual(markers.extract_paragraphs_exact(decoded.ai_text_full,1)[0],['คำแปล'])
        clean,summary,status=split_summary('{"P0":"คำแปล","TP_MEMO":"a","TP_MEMO":"b"}',enabled=True,native_schema=True)
        self.assertEqual(status,'invalid');self.assertEqual(clean,'{"P0":"คำแปล"}')
        clean,_,_=split_summary('{"P0":"one","P0":"two","TP_MEMO":"a"}',enabled=True,native_schema=True)
        with self.assertRaises(Exception):markers.decode_legacy_translation_response(clean,['P0'],require_complete=True)

ready_fixture=importlib.util.spec_from_file_location('ready_fixture',Path(__file__).with_name('test-conversation-ready.py'))
rm=importlib.util.module_from_spec(ready_fixture);ready_fixture.loader.exec_module(rm)
class SummaryReadyTests(unittest.TestCase):
    setUp=rm.ReadyTests.setUp
    ai=rm.ReadyTests.ai
    call=rm.ReadyTests.call
    def test_repeat_page_uses_stable_memory_ids_and_preserves_prior_records(self):
        self.answer_override=lambda ids,record:'\n'.join(record(uid,'คำแปล') for uid in ids)+'\n<<TP_MEMO:พระเอกพบกุญแจ>>'
        ai=replace(self.ai(3),memory_mode='full')
        from backend.ai.translation_paths import ready_batch
        ready_batch.reserve(ai,'th')
        # Keep a live successor reserved so wire order does not reset between calls.
        successor=ready_batch.reserve(replace(self.ai(4),memory_mode='full'),'th')
        self.addCleanup(ready_batch.finish,successor)
        first=self.call(ai,['First source','Next source'])
        second=self.call(replace(self.ai(3),memory_mode='full'),['First source','Next source'])
        a=first['meta']['seriesSummaryRecords'];b=second['meta']['seriesSummaryRecords']
        self.assertEqual(a[0]['sourceIds'],['I3_P0','I3_P1']);self.assertEqual(a,b)
        self.assertNotEqual(self.seen[0].expected_ids,self.seen[1].expected_ids)
        self.assertEqual(len(self.seen),2)

if __name__=='__main__':unittest.main()
