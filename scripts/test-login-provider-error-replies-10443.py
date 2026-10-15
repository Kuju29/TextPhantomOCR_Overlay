"""Replay Gemini's archived .42 completed error prose through native runs.

These are whole-answer provider errors, not translated dialogue or HTTP errors.
No session credential, source text or native response frame is retained here.
"""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.login.endpoint import login_endpoint_runs as runs
from backend.ai.login.login_provider_contract import LoginError

ARCHIVED_REPLIES = (
    'ฉันเป็น AI ที่ทำงานตามข้อความโต้ตอบ คำถามนี้เกินความสามารถของฉัน',
    'I encountered an error doing what you asked. Could you try again?',
    'Sorry, something went wrong. Please try your request again.',
    "I'm having a hard time fulfilling your request. Can I help you with something else instead?",
    'I seem to be encountering an error. Can I try something else for you?',
)


def request(operation='main', run='run'):
    return SimpleNamespace(cache_context={'webchatRunId': run, 'operationId': operation,
        'conversationSource': '<<I1_P0:Hello>>'}, image_b64='',
        user_parts=['<<I1_P0:Hello>>'], system_text='Translate to Thai using the same IDs.',
        model='session/web-default', history_messages=[], cancel_check=None)


class ProviderErrorReplies(unittest.TestCase):
    def setUp(self):
        runs.clear()
        self.session = {'id': 'session', 'provider': 'login_gemini', 'credential': 'fixture'}
        self.patches = [
            patch.object(runs.store, 'credential_for_session', return_value={'tokens': {'credentials': {}}}),
            patch.object(runs.store, 'active_session_ids', return_value={'session'}),
            patch.dict(os.environ, {'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0', 'TP_AI_WIRE_TRACE': '0'}),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        runs.clear()

    def module(self, text, calls):
        def generate(credentials, prompt, remote, model, check, dispatch):
            dispatch(); calls.append(prompt); remote['thread'] = 'fixture-thread'
            return {'text': text, 'completed': True, 'statuses': [200],
                    'terminal': 'gemini_candidate_state_complete'}
        return SimpleNamespace(endpoint_generate=generate)

    def test_archived_completed_error_is_not_success_or_repaired(self):
        for index, text in enumerate(ARCHIVED_REPLIES):
            with self.subTest(reply=index):
                calls = []
                module = self.module(text, calls)
                req = request(run=f'archived-{index}')
                with self.assertRaises(LoginError) as caught:
                    runs.generate(self.session, req, module)
                error = caught.exception
                self.assertEqual(error.code, 'login_provider_reply_failed')
                self.assertEqual(error.status, 502)
                self.assertTrue(error.requestDispatched)
                self.assertEqual(error.provider_reason, 'provider_error_reply')
                self.assertEqual(error.upstream_status, 200)
                with self.assertRaises(LoginError):
                    runs.generate(self.session, req, module)
                with self.assertRaises(LoginError):
                    runs.generate(self.session, request('repair', f'archived-{index}'), module)
                with self.assertRaises(LoginError):
                    runs.generate(self.session, request('next-image', f'archived-{index}'), module)
                self.assertEqual(len(calls), 1)

    def test_error_dialogue_inside_a_valid_record_remains_translation(self):
        calls = []
        text = '<<I1_P0:' + ARCHIVED_REPLIES[2] + '>>'
        result = runs.generate(self.session, request(), self.module(text, calls))
        self.assertEqual(result['text'], text)

    def test_non_error_prose_is_not_guessed_to_be_provider_failure(self):
        calls = []
        text = 'The character encountered an error and says to try again.'
        result = runs.generate(self.session, request(), self.module(text, calls))
        self.assertEqual(result['text'], text)

    def test_other_provider_answer_is_not_given_gemini_error_semantics(self):
        self.session['provider'] = 'login_deepseek'
        calls = []
        result = runs.generate(self.session, request(), self.module(ARCHIVED_REPLIES[2], calls))
        self.assertEqual(result['text'], ARCHIVED_REPLIES[2])

    def test_normal_translation_still_continues_and_keeps_original_context(self):
        calls = []
        module = self.module('<<I1_P0:สวัสดี>>', calls)
        runs.generate(self.session, request(), module)
        runs.generate(self.session, request('next-image'), module)
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0].startswith('Translate to Thai using the same IDs.'))
        self.assertEqual(calls[1], '<<I1_P0:Hello>>')


if __name__ == '__main__':
    unittest.main()
