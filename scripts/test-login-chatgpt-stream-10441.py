"""Independent snapshot/delta/terminal contract audit using synthetic SSE only."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.login.endpoint.login_chatgpt_stream import decode_lines, StreamError

CID='11111111-2222-4333-8444-555555555555'
ASSISTANT='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'


def message(text='Hello',status='finished_successfully'):
    return {'conversation_id':CID,'message':{'id':ASSISTANT,'author':{'role':'assistant'},'channel':'final','recipient':'all','status':status,'end_turn':True,'content':{'content_type':'text','parts':[text]},'metadata':{}}}


def event(payload,kind=None):
    return ([f'event: {kind}'] if kind else [])+['data: '+(payload if isinstance(payload,str) else json.dumps(payload)), '']


class StreamSecurity(unittest.TestCase):
    def test_valid_one_character_answer_is_retained(self):
        self.assertEqual(decode_lines(event(message('1'))+event('[DONE]'))['text'],'1')

    def test_empty_error_frame_duplicate_fields_and_deep_payload_are_rejected(self):
        for extra in (['event: error', ''], ['event: error'],
                ['data: {"error":"blocked","error":null}', ''],
                ['data: ' + ('{"child":' * 70) + 'null' + ('}' * 70), '']):
            with self.subTest(kind=len(extra)):
                with self.assertRaises(StreamError):
                    decode_lines(event(message()) + extra + event('[DONE]'))

    def test_snapshot_replaces_instead_of_repeating_tokens(self):
        result=decode_lines(event(message('Hel','in_progress'))+event(message('Hello'))+event('[DONE]'))
        self.assertEqual(result['text'],'Hello')
        self.assertEqual(result['parent_message_id'],ASSISTANT)
        self.assertTrue(result['terminal_complete'])

    def test_actual_delta_append_and_terminal_snapshot(self):
        lines=event('v1','delta_encoding')+event({'c':0,'p':'','o':'add','v':message('Hel','in_progress')},'delta')
        lines+=event({'p':'/message/content/parts/0','o':'append','v':'lo'},'delta')
        lines+=event({'p':'/message/status','o':'replace','v':'finished_successfully'},'delta')+event('[DONE]')
        self.assertEqual(decode_lines(lines,expected_conversation_id=CID)['text'],'Hello')

    def test_missing_terminal_foreign_conversation_and_foreign_assistant_rejected(self):
        with self.assertRaises(StreamError):decode_lines(event(message()))
        with self.assertRaises(StreamError):decode_lines(event(message(status='in_progress'))+event('[DONE]'))
        with self.assertRaises(StreamError):decode_lines(event(message())+event('[DONE]'),expected_conversation_id='different-conversation')
        changed=message();changed['message']['id']='foreign-assistant'
        with self.assertRaises(StreamError):decode_lines(event(message())+event(changed)+event('[DONE]'))
        with self.assertRaises(StreamError):decode_lines(event(message())+event('[DONE]')+event(message()))

    def test_reasoning_or_tool_channels_are_never_promoted_to_final(self):
        payload=message('private reasoning');payload['message']['channel']='analysis'
        with self.assertRaises(StreamError):decode_lines(event(payload)+event('[DONE]'))
        payload=message('tool output');payload['message']['recipient']='python'
        with self.assertRaises(StreamError):decode_lines(event(payload)+event('[DONE]'))

    def test_malformed_mapping_shapes_are_typed_stream_failures(self):
        malformed=[]
        for author in [None,[],3,'assistant']:
            payload=message();payload['message']['author']=author;malformed.append(payload)
        payload=message();payload['message']['metadata']['finish_details']='invalid';malformed.append(payload)
        malformed.extend([{'type':'moderation','moderation_response':None},{'type':'moderation','moderation_response':[]}])
        for payload in malformed:
            with self.subTest(shape=str(type(payload.get('message',{}).get('author')))):
                with self.assertRaises(StreamError):decode_lines(event(payload)+event('[DONE]'))

    def test_error_event_never_yields_a_prior_successful_snapshot(self):
        with self.assertRaises(StreamError):decode_lines(event(message())+event({'message':'synthetic error'},'error')+event('[DONE]'))

if __name__=='__main__':unittest.main()
