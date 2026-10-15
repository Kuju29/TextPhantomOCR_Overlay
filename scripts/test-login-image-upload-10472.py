""".72 Login Chat page images through the website's own upload route.

Fictional upstreams only (httpx MockTransport), never a live account.
References: HanaokaYuzu/Gemini-API upload_file (content-push upload host,
Push-ID header, [[[path], name]] in the message) and st1vms/unofficial-claude-api
(/api/{org}/upload multipart with orgUuid, file_uuid in the turn's "files").
DeepSeek / ChatGPT keep images off (no verified upload protocol).
"""
import base64
import json
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.login import login_provider_claude as claude
from backend.ai.login import login_provider_gemini as gemini
from backend.ai.login import login_provider_deepseek as deepseek
from backend.ai.login import login_provider_chatgpt as chatgpt
from backend.ai.login.endpoint import login_endpoint_http as endpoint
from backend.ai.login.endpoint import login_endpoint_runs as runs
from backend.ai.login.login_provider_contract import LoginError
from login_relay_fixture import relay_via

CLIENT = httpx.Client
PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 32
JPEG = b'\xff\xd8\xff\xe0' + b'\0' * 32


@contextmanager
def transport(handler):
    with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: CLIENT(transport=httpx.MockTransport(handler), **kw)), \
            patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), relay_via(handler):
        yield


def gemini_reply():
    body = [None] * 26
    body[1] = ['c_fixture', 'r_fixture']
    body[4] = [['rc_fixture', ['<<I1_P0:สวัสดี>>'], None, None, None, None, None, None, [2]]]
    value = '\n' + json.dumps([['wrb.fr', None, json.dumps(body, ensure_ascii=False)]], ensure_ascii=False)
    return b")]}'\n" + (str(len(value.encode('utf-16-le')) // 2) + value).encode()


GEMINI_CREDS = {'psid': 'synthetic-cookie', 'auth_user': '0', 'identity': 'fixture@example.test'}
GEMINI_HTML = json.dumps({'oPEP7c': GEMINI_CREDS['identity'], 'SNlM0e': 'synthetic-at',
                          'cfb2h': 'synthetic-build', 'FdrFJe': 'synthetic-sid'}).encode()


class DecodeImage(unittest.TestCase):
    def test_type_comes_from_bytes_and_size_is_bounded(self):
        self.assertEqual(runs.decode_image(base64.b64encode(PNG).decode())[1], 'image/png')
        self.assertEqual(runs.decode_image('data:image/png;base64,' + base64.b64encode(JPEG).decode())[1], 'image/jpeg')
        for bad in ('%%%', base64.b64encode(b'GIF89a....').decode(), ''):
            with self.subTest(bad=bad), self.assertRaises(LoginError) as error:
                runs.decode_image(bad)
            self.assertEqual(error.exception.code, 'login_image_invalid')
        with patch.object(runs, 'MAX_IMAGE_BYTES', 10), self.assertRaises(LoginError):
            runs.decode_image(base64.b64encode(PNG).decode())


class GeminiImage(unittest.TestCase):
    def run_gemini(self, upload_status=200, upload_body='/contrib_service/ttl_1d/fixture_path'):
        seen = {'upload': [], 'posts': []}
        def handle(request):
            if request.url.host == 'content-push.googleapis.com':
                seen['upload'].append(request)
                return httpx.Response(upload_status, text=upload_body)
            self.assertEqual(request.url.host, 'gemini.google.com')
            if request.method == 'GET':
                return httpx.Response(200, content=GEMINI_HTML, headers={'content-type': 'text/html'})
            outer = json.loads(parse_qs(request.content.decode())['f.req'][0])
            seen['posts'].append(json.loads(outer[1]))
            return httpx.Response(200, content=gemini_reply())
        dispatched = []
        with transport(handle):
            result = gemini.endpoint_generate(GEMINI_CREDS, 'prompt', {}, 'web-default', lambda: None,
                                              lambda: dispatched.append(1), image=(PNG, 'image/png'))
        return result, seen, dispatched

    def test_upload_then_reference_in_message(self):
        result, seen, dispatched = self.run_gemini()
        self.assertTrue(result['completed'])
        upload = seen['upload'][0]
        self.assertEqual(upload.headers['Push-ID'], 'feeds/mcudyrk2a4khkz')
        self.assertNotIn('cookie', {k.lower() for k in upload.headers}, 'no Google cookie to the upload host')
        self.assertIn(b'filename="page.png"', upload.content)
        self.assertEqual(seen['posts'][0][0][3], [[['/contrib_service/ttl_1d/fixture_path'], 'page.png']])
        self.assertEqual(dispatched, [1])

    def test_rejected_upload_stops_before_the_chat_turn(self):
        for status, text in ((500, 'x'), (200, 'not-a-path'), (200, '/contrib_service/' + 'x' * 5000)):
            with self.subTest(status=status, text=text[:20]), self.assertRaises(LoginError) as error:
                self.run_gemini(status, text)
            self.assertIn(error.exception.code, ('login_image_upload_failed', 'login_endpoint_response_invalid'))

    def test_model_row_and_stored_rows_report_vision(self):
        row = gemini.web_model()
        self.assertIs(row['model_capabilities']['vision']['supported'], True)
        old = endpoint.model('web-default', 'old')
        self.assertIs(gemini.endpoint_model_rows([old])[0]['model_capabilities']['vision']['supported'], True)

    def test_upload_url_is_allow_listed(self):
        with endpoint.EndpointHTTP('login_gemini', {}) as http, self.assertRaises(LoginError):
            http.upload('https://example.test/upload', filename='a', data=b'x', mime='image/png', headers={})
        with endpoint.EndpointHTTP('login_claude', {}) as http, self.assertRaises(LoginError):
            http.upload(gemini.UPLOAD_URL, filename='a', data=b'x', mime='image/png', headers={})


class ClaudeImage(unittest.TestCase):
    def test_upload_file_uuid_goes_into_the_turn(self):
        events = [
            {'type': 'message_start', 'message': {'uuid': 'answer-one', 'role': 'assistant'}},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': '<<I1_P0:สวัสดี>>'}},
            {'type': 'content_block_stop', 'index': 0},
            {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}},
            {'type': 'message_stop'}]
        sse = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
        seen = []
        def handle(request):
            self.assertEqual(request.url.host, 'claude.ai')
            seen.append(request)
            if request.url.path == '/api/owned-org/upload':
                self.assertIn(b'name="orgUuid"', request.content)
                self.assertIn(b'filename="page.jpg"', request.content)
                return httpx.Response(200, json={'file_uuid': 'file-fixture-1'})
            body = json.loads(request.content)
            self.assertEqual(body['files'], ['file-fixture-1'])
            return httpx.Response(200, content=sse, headers={'content-type': 'text/event-stream'})
        with transport(handle):
            result = claude.endpoint_generate({'organization': 'owned-org'}, 'prompt', {},
                                              'fixture-model', lambda: None, lambda: None, image=(JPEG, 'image/jpeg'))
        self.assertTrue(result['completed'])
        self.assertEqual([r.url.path for r in seen][0], '/api/owned-org/upload')
        self.assertEqual(endpoint.endpoint_step('login_claude', '/api/owned-org/upload'), 'claude_image_upload')

    def test_bad_upload_reply_stops_before_completion(self):
        paths = []
        def handle(request):
            paths.append(request.url.path)
            return httpx.Response(200, json={'unexpected': True})
        with transport(handle), self.assertRaises(LoginError):
            claude.endpoint_generate({'organization': 'owned-org'}, 'prompt', {},
                                     'fixture-model', lambda: None, lambda: None, image=(PNG, 'image/png'))
        self.assertEqual(paths, ['/api/owned-org/upload'])

    def test_rows_report_vision(self):
        old = endpoint.model('fixture-model', 'old')
        self.assertIs(claude.endpoint_model_rows([old])[0]['model_capabilities']['vision']['supported'], True)


class Unsupported(unittest.TestCase):
    def test_deepseek_and_chatgpt_refuse_images_explicitly(self):
        # .77: ChatGPT (Sign in with ChatGPT) accepts images; its website mode refuses them
        # per request (test-login-chatgpt-browser-10477.py). DeepSeek still refuses.
        self.assertFalse(getattr(deepseek, 'ENDPOINT_IMAGES', False))
        self.assertTrue(getattr(chatgpt, 'ENDPOINT_IMAGES', False))
        request = SimpleNamespace(cache_context={'webchatRunId': 'r', 'operationId': 'o'},
                                  image_b64=base64.b64encode(PNG).decode())
        with self.assertRaises(LoginError) as error:
            runs.generate({'id': 's'}, request, deepseek)
        self.assertEqual(error.exception.code, 'login_image_unsupported')
        self.assertIn('Page image', error.exception.message if hasattr(error.exception, 'message') else str(error.exception))


if __name__ == '__main__':
    unittest.main(verbosity=1)
