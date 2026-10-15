"""Current maintainer protocol shapes through the actual native Gemini HTTP seam.

Synthetic provider replies establish wire/context correctness, not live account
acceptance. Reference: HanaokaYuzu/Gemini-API client.py reviewed 2026-10-08.
"""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs

import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.login import login_provider_gemini as provider
from backend.ai.login.endpoint import login_endpoint_http as transport
from backend.ai.login.login_provider_contract import LoginError

REAL_CLIENT = httpx.Client
CREDS = {'psid': 'synthetic-cookie', 'psidts': 'synthetic-cookie-ts',
         'auth_user': '0', 'identity': 'fixture@example.test'}
HTML = json.dumps({'oPEP7c': CREDS['identity'], 'SNlM0e': 'synthetic-at',
                   'cfb2h': 'synthetic-build', 'FdrFJe': 'synthetic-sid'}).encode()


def frame(body):
    value = json.dumps([['wrb.fr', None, json.dumps(body, ensure_ascii=False)]], ensure_ascii=False)
    value = '\n' + value
    return (str(len(value.encode('utf-16-le')) // 2) + value).encode()


def body(text='<<I1_P0:สวัสดี>>', cid='c_fixture', rid='r_fixture', candidate='rc_fixture', context='context-fixture', ended=True):
    result = [None] * 26
    result[1] = [cid, rid]
    result[4] = [[candidate, [text], None, None, None, None, None, None, [2 if ended else 1]]]
    result[25] = context
    return result


def wire(*bodies):
    return b")]}'\n" + b'\n'.join(frame(item) for item in bodies)


class GeminiProtocol(unittest.TestCase):
    def http(self, action, responses=None):
        calls, posts = [], []
        def handle(request):
            calls.append(request.url.path)
            self.assertEqual(request.headers['User-Agent'], 'TextPhantom')
            if request.method == 'GET':
                return httpx.Response(200, content=HTML, headers={'content-type': 'text/html'})
            fields = parse_qs(request.content.decode())
            outer = json.loads(fields['f.req'][0])
            posts.append((json.loads(outer[1]), dict(request.headers)))
            reply = responses[len(posts) - 1] if responses else wire(body())
            return httpx.Response(200, content=reply)
        with patch.object(transport.httpx, 'Client', side_effect=lambda **kw:
                REAL_CLIENT(transport=httpx.MockTransport(handle), **kw)):
            action(posts, calls)

    def test_catalogue_model_identifier_reaches_the_native_generator(self):
        def action(posts, calls):
            connected = provider.endpoint_validate(CREDS, lambda: None)
            self.assertEqual(connected['identity'], CREDS['identity'])
            self.assertEqual(len(connected['models']), 1)
            selected = connected['models'][0]['id']
            result = provider.endpoint_generate(connected['credentials'], 'fixture source', {},
                selected, lambda: None, lambda: None)
            self.assertTrue(result['completed'])
            self.assertEqual(len(posts), 1)
        self.http(action)

    def test_unsupported_model_stops_before_http_or_dispatch(self):
        for selected in ('', 'gemini-api-model', 'login_gemini/web-default', 'web-default '):
            with self.subTest(selected=selected), patch.object(provider, 'EndpointHTTP') as http:
                dispatched = []
                with self.assertRaises(LoginError) as rejected:
                    provider.endpoint_generate(CREDS, 'fixture source', {}, selected,
                        lambda: None, lambda: dispatched.append(True))
                self.assertEqual(rejected.exception.code, 'login_model_unavailable')
                self.assertEqual(rejected.exception.status, 409)
                self.assertEqual(dispatched, [])
                http.assert_not_called()

    def test_first_and_continuation_use_current_native_request_shape(self):
        def action(posts, calls):
            remote = {}
            for prompt in ('first source', 'next source'):
                provider.endpoint_generate(CREDS, prompt, remote, 'web-default', lambda: None, lambda: None)
            self.assertEqual(len(posts), 2)
            for inner, headers in posts:
                self.assertEqual(len(inner), 81)
                self.assertEqual(inner[6], [1])
                self.assertEqual(inner[17], [[0]])
                self.assertEqual(inner[79:81], [1, 1])
                self.assertEqual(inner[59], inner[59].upper())
                self.assertEqual(json.loads(headers['x-goog-ext-525005358-jspb']), [inner[59], 1])
                self.assertNotIn('x-goog-ext-525001261-jspb', headers)  # Provider chooses its own default.
            self.assertNotEqual(posts[0][0][59], posts[1][0][59])
            self.assertEqual(posts[1][0][2][0:3], ['c_fixture', 'r_fixture', 'rc_fixture'])
            self.assertEqual(posts[1][0][2][9], 'context-fixture')
        self.http(action)

    def test_completed_context_tail_preserves_original_parent_and_next_request(self):
        tail = [None] * 26
        tail[25] = 'opaque-context-after-candidate'
        text, metadata = provider.parse_reply(wire(body(context=None), tail))
        self.assertEqual(text, '<<I1_P0:สวัสดี>>')
        self.assertEqual(metadata[:3], ['c_fixture', 'r_fixture', 'rc_fixture'])
        self.assertEqual(metadata[9], 'opaque-context-after-candidate')

    def test_context_without_completed_candidate_never_confirms_an_answer(self):
        with self.assertRaises(LoginError):
            provider.parse_reply(wire(body(ended=False)))
        tail = [None] * 26; tail[25] = 'opaque-context'
        with self.assertRaises(LoginError):
            provider.parse_reply(wire(tail))

    def test_later_reply_without_new_context_preserves_the_previous_context(self):
        previous = ['c_fixture', 'r_previous', 'rc_previous', None, None, None, None, None, None, 'previous-context']
        text, metadata = provider.parse_reply(wire(body(context=None)), 'c_fixture', previous)
        self.assertEqual(metadata[:3], ['c_fixture', 'r_fixture', 'rc_fixture'])
        self.assertEqual(metadata[9], 'previous-context')
        self.assertEqual(previous[1:3], ['r_previous', 'rc_previous'])

    def test_malformed_or_oversized_context_is_not_retained(self):
        for value in ({'token': 'not-a-string'}, ['not-a-string'], 1, 'x' * 65537):
            with self.subTest(kind=type(value).__name__):
                with self.assertRaises(LoginError):
                    provider.parse_reply(wire(body(context=value)))

    def test_foreign_metadata_tail_cannot_replace_the_owning_context(self):
        tail = [None] * 26; tail[1] = ['foreign-conversation', 'foreign-parent']; tail[25] = 'foreign-context'
        with self.assertRaises(LoginError):
            provider.parse_reply(wire(body(), tail))

    def test_same_conversation_tail_cannot_change_the_current_reply_parent(self):
        tail = [None] * 26
        tail[1] = ['c_fixture', 'r_foreign']
        tail[25] = 'context-from-another-reply'
        with self.assertRaises(LoginError):
            provider.parse_reply(wire(body(), tail))

    def test_same_response_cannot_mix_candidates_from_different_replies(self):
        partial = body(text='partial answer', rid='r_first', ended=False)
        final = body(rid='r_other', candidate='rc_other')
        with self.assertRaises(LoginError):
            provider.parse_reply(wire(partial, final))

    def test_metadata_preamble_can_precede_the_current_candidate_reply(self):
        preamble = [None] * 26
        preamble[1] = ['c_fixture', 'r_previous']
        tail = [None] * 26
        tail[1] = ['c_fixture', 'r_fixture']
        tail[25] = 'current-context'
        text, metadata = provider.parse_reply(wire(preamble, body(context=None), tail))
        self.assertEqual(text, '<<I1_P0:สวัสดี>>')
        self.assertEqual(metadata[:3], ['c_fixture', 'r_fixture', 'rc_fixture'])
        self.assertEqual(metadata[9], 'current-context')

    def test_candidate_revisions_within_the_same_reply_remain_supported(self):
        partial = body(text='partial answer', candidate='rc_partial', ended=False)
        final = body(candidate='rc_final')
        text, metadata = provider.parse_reply(wire(partial, final))
        self.assertEqual(text, '<<I1_P0:สวัสดี>>')
        self.assertEqual(metadata[:3], ['c_fixture', 'r_fixture', 'rc_final'])

    def test_new_turn_can_replace_previous_reply_without_mutating_saved_metadata(self):
        previous = ['c_fixture', 'r_previous', 'rc_previous', None, None, None, None, None, None, 'previous-context']
        tail = [None] * 26
        tail[1] = ['c_fixture', 'r_fixture']
        tail[25] = 'current-context'
        text, metadata = provider.parse_reply(wire(body(context=None), tail), 'c_fixture', previous)
        self.assertEqual(text, '<<I1_P0:สวัสดี>>')
        self.assertEqual(metadata[:3], ['c_fixture', 'r_fixture', 'rc_fixture'])
        self.assertEqual(metadata[9], 'current-context')
        self.assertEqual(previous[1:3], ['r_previous', 'rc_previous'])

    def test_empty_reply_parent_in_metadata_tail_is_not_retained(self):
        for parent in ('', '  '):
            with self.subTest(parentKind='empty' if not parent else 'whitespace'):
                tail = [None] * 26; tail[1] = ['c_fixture', parent]; tail[25] = 'opaque-context'
                with self.assertRaises(LoginError):
                    provider.parse_reply(wire(body(), tail))
        tail = [None] * 26; tail[1] = ['c_fixture', None]; tail[25] = 'opaque-context'
        self.assertEqual(provider.parse_reply(wire(body(), tail))[1][1], 'r_fixture')

    def test_known_parent_remains_pinned_and_incomplete_frames_fail(self):
        with self.assertRaises(LoginError):
            provider.parse_reply(wire(body(cid='foreign-conversation')), 'c_fixture')
        with self.assertRaises(LoginError):
            provider.parse_reply(wire(body(text='<<I1_P0:ยิ้ม😀>>'))[:-1])

    def test_second_candidate_after_terminal_is_not_accepted(self):
        with self.assertRaises(LoginError):
            provider.parse_reply(wire(body(), body(candidate='different-candidate')))


if __name__ == '__main__':
    unittest.main()
